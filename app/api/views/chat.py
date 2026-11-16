"""对话接口：同步回复和 SSE 流式输出。"""

import asyncio
import json
import logging
import re
import time
from contextlib import suppress
from typing import Any

from fastapi import APIRouter, Request
from langchain_core.messages import AIMessageChunk, ToolMessage
from sse_starlette.sse import EventSourceResponse

from app.api.schemas import ChatRequest, ChatResponse

router = APIRouter()
logger = logging.getLogger(__name__)

# 工具名 → 界面展示文案
_TOOL_LABELS = {
    "search_dify_kb": "检索知识库",
    "scheme_db_ping": "探测业务库",
    "scheme_db_list_tables": "列出分析表",
    "scheme_db_describe_table": "查看表结构",
    "scheme_db_query": "业务库只读查询",
    "generate_dify_report": "生成周报/月报",
    "task": "委派子智能体",
    "write_todos": "更新待办",
    "read_file": "读取文件",
    "write_file": "写入文件",
    "ls": "列出目录",
    "glob": "匹配文件",
    "grep": "搜索文件",
}

_HEARTBEAT_SEC = 5.0
_TOKEN_CHUNK = 1200
_REPORT_ERR_PREFIX = ("错误", "Dify API", "无法连接", "Dify 工作流错误", "Dify 报告超时")


def _run_config(session_id: str) -> dict:
    return {"configurable": {"thread_id": session_id}, "recursion_limit": 100}


def _sse(event: str, data: Any) -> dict:
    if not isinstance(data, str):
        data = json.dumps(data, ensure_ascii=False)
    return {"event": event, "data": data}


def _tool_label(name: str) -> str:
    return _TOOL_LABELS.get(name, name or "未知工具")


def _preview(content: Any, limit: int = 120) -> str:
    if content is None:
        return ""
    text = content if isinstance(content, str) else str(content)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _parse_task_target(args_json: str) -> str | None:
    """从 task 工具参数里解析子智能体名（分析/网络/工单委派用）。"""
    if not args_json:
        return None
    try:
        obj = json.loads(args_json)
    except json.JSONDecodeError:
        for key in ("subagent_type", "subagent", "name"):
            m = re.search(rf'"{key}"\s*:\s*"([^"]+)"', args_json)
            if m:
                return m.group(1)
        return None
    for key in ("subagent_type", "subagent", "name"):
        val = obj.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def _waiting_label(active_tool: str | None) -> str:
    if active_tool == "task":
        return "子智能体执行中（可能较久，可点停止）…"
    if active_tool == "generate_dify_report":
        return "Dify 正在生成周报/月报…"
    if active_tool:
        return f"正在{_tool_label(active_tool)}，请稍候…"
    return "处理中，请稍候…"


def _report_body(content: Any) -> str | None:
    """直调 generate_dify_report 的终稿正文（非错误时）。"""
    if content is None:
        return None
    text = (content if isinstance(content, str) else str(content)).strip()
    if not text or text.startswith(_REPORT_ERR_PREFIX):
        return None
    return text


async def _cancel_pending(task: asyncio.Task | None) -> None:
    if task is None or task.done():
        return
    task.cancel()
    with suppress(asyncio.CancelledError, StopAsyncIteration, Exception):
        await task


async def _close_stream(aiter: Any, stream: Any) -> None:
    for obj in (aiter, stream):
        aclose = getattr(obj, "aclose", None)
        if not callable(aclose):
            continue
        with suppress(Exception):
            await aclose()


def _unpack_messages_item(item: Any) -> tuple[tuple, Any, dict]:
    """兼容 subgraphs=True/False 的 astream messages 输出。

    - subgraphs=False → (chunk, meta)
    - subgraphs=True  → (namespace, (chunk, meta))
    """
    if not isinstance(item, tuple) or len(item) != 2:
        return (), item, {}
    first, second = item
    if isinstance(first, tuple) and isinstance(second, tuple) and len(second) == 2:
        return first, second[0], second[1] or {}
    if isinstance(first, tuple):
        return first, second, {}
    return (), first, second or {}


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, request: Request):
    agent = request.app.state.agent
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": req.message}]},
        config=_run_config(req.session_id),
    )
    return ChatResponse(session_id=req.session_id, reply=result["messages"][-1].text)


@router.post("/chat/stream")
async def chat_stream(req: ChatRequest, request: Request):
    """SSE 流式输出。

    事件：run_start / status / tool_call / tool_result / subagent / token / done / aborted
    """
    agent = request.app.state.agent
    # SSE 场景下 request.is_disconnected() 常不可靠；用 sse-starlette 回调立刻感知停止
    client_gone = asyncio.Event()

    async def on_client_close(_message: dict) -> None:
        client_gone.set()
        logger.info("chat stream client disconnected session=%s", req.session_id)

    async def event_gen():
        t0 = time.perf_counter()
        step_i = 0
        started_tools: dict[str, float] = {}
        seen_tool_starts: set[str] = set()
        tool_args_buf: dict[str, str] = {}
        tool_names: dict[str, str] = {}
        announced_task_targets: set[str] = set()
        active_tool: str | None = None
        writing = False
        report_emitted = False  # 报告已透传后，忽略模型可能的二次复述 token
        last_node: str | None = None
        aborted = False
        # 当前主智能体委派的 task → 子智能体卡片（对齐 LangChain SubagentCard）
        active_subagent_id: str | None = None
        active_subagent_name: str = "子智能体"
        started_subagents: set[str] = set()
        sub_seen_tools: set[str] = set()
        sub_tool_args: dict[str, str] = {}

        def elapsed_ms() -> int:
            return int((time.perf_counter() - t0) * 1000)

        def should_stop() -> bool:
            return client_gone.is_set()

        def emit_subagent_start(sid: str, name: str):
            nonlocal active_subagent_id, active_subagent_name
            active_subagent_id = sid
            active_subagent_name = name or "子智能体"
            if sid in started_subagents:
                return _sse(
                    "subagent",
                    {
                        "action": "update",
                        "id": sid,
                        "name": active_subagent_name,
                        "status": "running",
                        "elapsed_ms": elapsed_ms(),
                    },
                )
            started_subagents.add(sid)
            return _sse(
                "subagent",
                {
                    "action": "start",
                    "id": sid,
                    "name": active_subagent_name,
                    "status": "running",
                    "elapsed_ms": elapsed_ms(),
                },
            )

        yield _sse(
            "run_start",
            {"elapsed_ms": 0, "label": "已接收请求，开始推理"},
        )
        yield _sse(
            "status",
            {
                "phase": "thinking",
                "label": "模型思考中…",
                "elapsed_ms": 0,
            },
        )

        stream = agent.astream(
            {"messages": [{"role": "user", "content": req.message}]},
            config=_run_config(req.session_id),
            stream_mode="messages",
            subgraphs=True,
        )
        aiter = stream.__aiter__()
        pending_next: asyncio.Task | None = None

        try:
            while True:
                if should_stop():
                    aborted = True
                    break

                if pending_next is None:
                    pending_next = asyncio.create_task(aiter.__anext__())

                gone_wait = asyncio.create_task(client_gone.wait())
                try:
                    done, _ = await asyncio.wait(
                        {pending_next, gone_wait},
                        timeout=_HEARTBEAT_SEC,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                except asyncio.CancelledError:
                    aborted = True
                    raise
                except Exception:
                    aborted = True
                    break
                finally:
                    if not gone_wait.done():
                        gone_wait.cancel()
                        with suppress(asyncio.CancelledError):
                            await gone_wait

                if should_stop():
                    aborted = True
                    break

                if pending_next not in done:
                    yield _sse(
                        "status",
                        {
                            "phase": "waiting",
                            "label": _waiting_label(active_tool),
                            "tool": active_tool,
                            "elapsed_ms": elapsed_ms(),
                        },
                    )
                    continue

                try:
                    raw_item = pending_next.result()
                except StopAsyncIteration:
                    pending_next = None
                    break
                except asyncio.CancelledError:
                    aborted = True
                    pending_next = None
                    raise
                except Exception as e:
                    yield _sse(
                        "status",
                        {
                            "phase": "error",
                            "label": f"流式异常：{e}",
                            "elapsed_ms": elapsed_ms(),
                        },
                    )
                    aborted = True
                    pending_next = None
                    break
                pending_next = None

                if should_stop():
                    aborted = True
                    break

                ns, chunk, meta = _unpack_messages_item(raw_item)
                in_subgraph = bool(ns)

                # —— 子图内：写入对应 SubagentCard，绝不混入主气泡 token ——
                if in_subgraph:
                    sid = active_subagent_id
                    if not sid:
                        # task 尚未在根图落盘时，用 namespace 兜底开一张卡
                        sid = "/".join(str(x) for x in ns) or "subagent"
                        yield emit_subagent_start(sid, "子智能体")
                    if isinstance(chunk, AIMessageChunk):
                        for tc in chunk.tool_call_chunks or []:
                            name = tc.get("name")
                            tid = str(tc.get("id") or name or "")
                            if tc.get("args"):
                                key = tid or name or "_"
                                sub_tool_args[key] = sub_tool_args.get(key, "") + str(
                                    tc.get("args") or ""
                                )
                            if not name or tid in sub_seen_tools:
                                continue
                            sub_seen_tools.add(tid)
                            yield _sse(
                                "subagent",
                                {
                                    "action": "tool_call",
                                    "id": sid,
                                    "tool_id": tid,
                                    "name": name,
                                    "label": _tool_label(name),
                                    "status": "running",
                                    "elapsed_ms": elapsed_ms(),
                                },
                            )
                        if chunk.text:
                            yield _sse(
                                "subagent",
                                {
                                    "action": "token",
                                    "id": sid,
                                    "text": chunk.text,
                                    "elapsed_ms": elapsed_ms(),
                                },
                            )
                    elif isinstance(chunk, ToolMessage):
                        name = chunk.name or "tool"
                        tid = str(getattr(chunk, "tool_call_id", None) or name)
                        content_text = str(chunk.content)
                        yield _sse(
                            "subagent",
                            {
                                "action": "tool_result",
                                "id": sid,
                                "tool_id": tid,
                                "name": name,
                                "label": _tool_label(name),
                                "preview": _preview(chunk.content),
                                "ok": not content_text.lstrip().startswith(
                                    ("错误", "Error", "error")
                                ),
                                "elapsed_ms": elapsed_ms(),
                            },
                        )
                    continue

                node = (meta or {}).get("langgraph_node")
                if node and node != last_node:
                    last_node = node
                    yield _sse(
                        "status",
                        {
                            "phase": "node",
                            "label": f"进入节点：{node}",
                            "node": node,
                            "elapsed_ms": elapsed_ms(),
                        },
                    )

                if isinstance(chunk, AIMessageChunk):
                    for tc in chunk.tool_call_chunks or []:
                        name = tc.get("name")
                        tid = str(tc.get("id") or name or "")
                        if tc.get("args"):
                            key = tid or name or "_"
                            tool_args_buf[key] = tool_args_buf.get(key, "") + str(
                                tc.get("args") or ""
                            )
                        if not name or tid in seen_tool_starts:
                            continue
                        seen_tool_starts.add(tid)
                        started_tools[tid] = time.perf_counter()
                        tool_names[tid] = name
                        active_tool = name
                        step_i += 1
                        label = _tool_label(name)
                        detail = name
                        if name == "task":
                            target = _parse_task_target(tool_args_buf.get(tid, ""))
                            if target:
                                label = f"委派 {target}"
                                detail = target
                                announced_task_targets.add(tid)
                            yield emit_subagent_start(tid, target or "子智能体")
                        yield _sse(
                            "tool_call",
                            {
                                "step": step_i,
                                "id": tid,
                                "name": name,
                                "label": label,
                                "detail": detail,
                                "elapsed_ms": elapsed_ms(),
                            },
                        )
                        yield _sse(
                            "status",
                            {
                                "phase": "tool",
                                "label": f"正在{label}…",
                                "tool": name,
                                "elapsed_ms": elapsed_ms(),
                            },
                        )

                    # task 参数流式到达较晚时，补全子智能体名（分析/网络/工单）
                    for tid, args in list(tool_args_buf.items()):
                        if tool_names.get(tid) != "task" or tid in announced_task_targets:
                            continue
                        target = _parse_task_target(args)
                        if not target:
                            continue
                        announced_task_targets.add(tid)
                        yield emit_subagent_start(tid, target)
                        yield _sse(
                            "status",
                            {
                                "phase": "tool",
                                "label": f"正在委派 {target}…",
                                "tool": "task",
                                "subagent": target,
                                "elapsed_ms": elapsed_ms(),
                            },
                        )

                    if chunk.text and not report_emitted:
                        if not writing:
                            writing = True
                            step_i += 1
                            yield _sse(
                                "status",
                                {
                                    "phase": "writing",
                                    "label": "正在生成回复…",
                                    "elapsed_ms": elapsed_ms(),
                                    "step": step_i,
                                },
                            )
                        yield _sse("token", chunk.text)

                elif isinstance(chunk, ToolMessage):
                    name = chunk.name or "tool"
                    tid = str(getattr(chunk, "tool_call_id", None) or name)
                    started = started_tools.pop(tid, None)
                    duration_ms = (
                        int((time.perf_counter() - started) * 1000) if started else None
                    )
                    if active_tool == name:
                        active_tool = None
                    label = _tool_label(name)
                    if name == "task":
                        target = _parse_task_target(tool_args_buf.get(tid, ""))
                        if target:
                            label = f"委派 {target}"
                    content_text = str(chunk.content)
                    ok = not content_text.lstrip().startswith(("错误", "Error", "error"))
                    yield _sse(
                        "tool_result",
                        {
                            "id": tid,
                            "name": name,
                            "label": label,
                            "elapsed_ms": elapsed_ms(),
                            "duration_ms": duration_ms,
                            "preview": _preview(chunk.content),
                            "ok": ok,
                        },
                    )

                    if name == "task" and tid in started_subagents:
                        yield _sse(
                            "subagent",
                            {
                                "action": "done",
                                "id": tid,
                                "name": active_subagent_name if active_subagent_id == tid else (target or "子智能体"),
                                "status": "complete" if ok else "error",
                                "output": _preview(chunk.content, limit=800),
                                "elapsed_ms": elapsed_ms(),
                            },
                        )
                        if active_subagent_id == tid:
                            active_subagent_id = None

                    # 周报/月报：主智能体直调工具，原样透传（与 task 子智能体无关）
                    if name == "generate_dify_report":
                        body = _report_body(chunk.content)
                        if body:
                            if not writing:
                                writing = True
                                step_i += 1
                            yield _sse(
                                "status",
                                {
                                    "phase": "writing",
                                    "label": "正在输出报告（原样）…",
                                    "elapsed_ms": elapsed_ms(),
                                    "step": step_i,
                                },
                            )
                            for i in range(0, len(body), _TOKEN_CHUNK):
                                if should_stop():
                                    aborted = True
                                    break
                                yield _sse("token", body[i : i + _TOKEN_CHUNK])
                            report_emitted = True
                            if aborted:
                                break
                            yield _sse(
                                "status",
                                {
                                    "phase": "thinking",
                                    "label": "报告已输出",
                                    "elapsed_ms": elapsed_ms(),
                                },
                            )
                            continue

                    yield _sse(
                        "status",
                        {
                            "phase": "thinking",
                            "label": f"{label}完成，继续推理…",
                            "elapsed_ms": elapsed_ms(),
                        },
                    )
        except asyncio.CancelledError:
            aborted = True
            logger.info("chat stream cancelled session=%s", req.session_id)
            raise
        finally:
            await _cancel_pending(pending_next)
            await _close_stream(aiter, stream)
            if aborted:
                logger.info(
                    "chat stream stopped session=%s elapsed_ms=%s",
                    req.session_id,
                    elapsed_ms(),
                )

        if aborted:
            if active_subagent_id:
                yield _sse(
                    "subagent",
                    {
                        "action": "done",
                        "id": active_subagent_id,
                        "name": active_subagent_name,
                        "status": "error",
                        "elapsed_ms": elapsed_ms(),
                    },
                )
                active_subagent_id = None
            if not client_gone.is_set():
                yield _sse(
                    "aborted",
                    {
                        "elapsed_ms": elapsed_ms(),
                        "label": "已停止",
                    },
                )
        else:
            if active_subagent_id:
                yield _sse(
                    "subagent",
                    {
                        "action": "done",
                        "id": active_subagent_id,
                        "name": active_subagent_name,
                        "status": "complete",
                        "elapsed_ms": elapsed_ms(),
                    },
                )
                active_subagent_id = None
            yield _sse(
                "done",
                {
                    "elapsed_ms": elapsed_ms(),
                    "steps": step_i,
                    "label": "完成",
                },
            )

    return EventSourceResponse(
        event_gen(),
        client_close_handler_callable=on_client_close,
    )
