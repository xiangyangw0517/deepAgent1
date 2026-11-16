"""Dify 周报/月报工作流调用（chat-messages）。

将用户自然语言规范为工作流约定 query：
- 周报 → 「周报」
- 月报/本月报 → 「月报」
- N月月报 → 「N月月报」

内网默认优先 blocking（与 Postman 一致）。
若应用类型为 Agent Chat（不支持 blocking），自动回退 streaming。

工具设置 return_direct=True：answer 直接作为对用户的最终回复，
避免主/子智能体再把数万字报告「复述」一遍（耗时会从 ~30s 膨胀到数分钟）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid

import httpx

from app.config import get_settings
from app.tools.registry import register_tool

logger = logging.getLogger(__name__)


def normalize_report_query(user_text: str) -> str:
    """把用户说法收敛为 Dify 工作流期望的短 query。"""
    text = (user_text or "").strip()
    if not text:
        return ""

    if text in {"周报", "月报"}:
        return text
    m = re.fullmatch(r"(\d{1,2})月月报", text)
    if m:
        return f"{int(m.group(1))}月月报"

    m = re.search(r"(\d{1,2})\s*月(?:份)?(?:的)?\s*月报", text)
    if m:
        return f"{int(m.group(1))}月月报"

    if re.search(r"周报|本周报告|一周报告", text):
        return "周报"

    if re.search(r"月报|本月报告|本月报|月度报告", text):
        return "月报"

    return text


def _chat_url(base: str) -> str:
    base = (base or "").rstrip("/")
    if base.endswith("/chat-messages"):
        return base
    return f"{base}/chat-messages"


async def _consume_sse_stream(resp: httpx.Response) -> str:
    parts: list[str] = []
    async for line in resp.aiter_lines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            break
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            continue
        event = obj.get("event")
        if event in {"message", "agent_message"} and obj.get("answer") is not None:
            parts.append(str(obj["answer"]))
        elif event == "error":
            return f"Dify 工作流错误: {obj.get('message') or obj}"
        elif event == "message_end":
            break
    return "".join(parts).strip()


async def _call_dify_chat(query: str, user: str, conversation_id: str = "") -> str:
    settings = get_settings()
    base = settings.dify_report_base_url or ""
    api_key = settings.dify_report_api_key or ""
    if not base or not api_key:
        return "错误：未配置周报/月报 Dify（请设置 DIFY_REPORT_BASE_URL / DIFY_REPORT_API_KEY）"

    url = _chat_url(base)
    preferred = (settings.dify_report_response_mode or "blocking").strip().lower()
    if preferred not in {"blocking", "streaming"}:
        preferred = "blocking"

    base_payload = {
        "inputs": {},
        "query": query,
        "conversation_id": conversation_id or "",
        "user": user or settings.dify_report_user or "complaint-agent",
        "files": [],
    }
    timeout = httpx.Timeout(float(settings.dify_report_timeout_sec or 180))
    modes = [preferred]
    if preferred == "blocking":
        modes.append("streaming")

    last_error = ""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=timeout) as client:
        for mode in modes:
            payload = {**base_payload, "response_mode": mode}
            accept = "application/json" if mode == "blocking" else "text/event-stream"
            try:
                if mode == "streaming":
                    async with client.stream(
                        "POST",
                        url,
                        json=payload,
                        headers={**headers, "Accept": accept},
                    ) as resp:
                        if resp.status_code >= 400:
                            detail = (await resp.aread()).decode("utf-8", "replace")
                            last_error = f"Dify API 错误 {resp.status_code}: {detail[:500]}"
                            if mode == "blocking" or resp.status_code == 400:
                                continue
                            return last_error
                        answer = await _consume_sse_stream(resp)
                else:
                    resp = await client.post(
                        url,
                        json=payload,
                        headers={**headers, "Accept": accept},
                    )
                    detail = resp.text
                    if resp.status_code >= 400:
                        last_error = f"Dify API 错误 {resp.status_code}: {detail[:500]}"
                        if mode == "blocking" and (
                            "does not support blocking" in detail
                            or "invalid_param" in detail
                            or resp.status_code == 400
                        ):
                            logger.warning(
                                "Dify 报告 blocking 不可用，尝试 streaming: %s",
                                detail[:200],
                            )
                            continue
                        logger.warning("Dify report API %s: %s", resp.status_code, detail[:300])
                        return last_error
                    body = resp.json()
                    answer = str(body.get("answer") or body.get("message") or "").strip()
                    if not answer:
                        answer = f"（无正文，原始响应键: {list(body.keys())}）"

                if mode != preferred:
                    logger.info("Dify 报告 mode=%s 不可用，已回退到 %s", preferred, mode)
                return answer or "（工作流未返回文本）"
            except asyncio.CancelledError:
                raise
            except httpx.TimeoutException:
                return f"Dify 报告超时（>{settings.dify_report_timeout_sec}s）: {url}"
            except httpx.HTTPError as e:
                logger.exception("连接 Dify 周报/月报工作流失败")
                return f"无法连接 Dify 报告工作流（{url}）: {e}"

    return last_error or "Dify 报告调用失败"


@register_tool(return_direct=True)
async def generate_dify_report(query: str, conversation_id: str = "") -> str:
    """调用 Dify 周报/月报智能体，直接返回完整报告正文（终稿，勿再总结）。

    query 应为规范短词：周报 / 月报 / N月月报（如 8月月报）。
    若传入完整用户话术，会自动归一化后再请求 Dify。
    本工具 return_direct：返回值即对用户的最终回复，保留原格式。
    """
    normalized = normalize_report_query(query)
    if not normalized:
        return "错误：query 为空"

    settings = get_settings()
    user = settings.dify_report_user or f"report-{uuid.uuid4().hex[:10]}"
    try:
        return await _call_dify_chat(normalized, user, conversation_id or "")
    except asyncio.CancelledError:
        logger.info("generate_dify_report 已取消 query=%s", normalized)
        raise
