"""Dify 知识库检索：按名称选择单个 Dataset。

.env：
  DIFY_BASE_URL / DIFY_API_KEY
  DIFY_DATASETS=投诉口径:uuid1,网络口径:uuid2
  DIFY_DATASET_DEFAULT=投诉口径
  DIFY_DATASET_ID=uuid   # 可选兼容；无 DIFY_DATASETS 时当作「默认」
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.request

from app.config import get_settings
from app.tools.registry import register_tool

logger = logging.getLogger(__name__)

MAX_CONTENT_CHARS = 4000
DEFAULT_TOP_K = 4

# 文档名中的日期：20260501 / 2026-05-01 / 2026_05_01
_DOC_DATE = re.compile(
    r"(?P<y>20\d{2})[-_/]?(?P<m>0[1-9]|1[0-2])[-_/]?(?P<d>0[1-9]|[12]\d|3[01])"
)


def _fmt_ymd(y: str, m: str, d: str) -> str:
    return f"{y}-{m}-{d}"


def extract_doc_time_label(doc_name: str) -> str:
    """从文档名解析统计区间，供回答时强制带上文档时间。"""
    name = (doc_name or "").strip()
    if not name:
        return ""
    hits = list(_DOC_DATE.finditer(name))
    if not hits:
        return ""
    if len(hits) >= 2:
        a, b = hits[0], hits[1]
        start = _fmt_ymd(a["y"], a["m"], a["d"])
        end = _fmt_ymd(b["y"], b["m"], b["d"])
        if start == end:
            return start
        return f"{start} ~ {end}"
    only = hits[0]
    # 仅有一个日期时：若像整月报告名含 YYYYMM，可只标该日；优先标该日
    return _fmt_ymd(only["y"], only["m"], only["d"])


def parse_dify_datasets(
    datasets_raw: str,
    legacy_id: str = "",
    default_name: str = "",
) -> tuple[dict[str, str], str]:
    """返回 (名称→uuid, 默认库名)。"""
    mapping: dict[str, str] = {}
    raw = (datasets_raw or "").strip()
    if raw:
        # 兼容中文逗号，避免「库A:uuid，库B:uuid」被解析成一个错误 UUID
        for part in raw.replace("，", ",").split(","):
            part = part.strip()
            if ":" not in part:
                continue
            name, did = part.split(":", 1)
            name, did = name.strip(), did.strip()
            if name and did:
                mapping[name] = did

    legacy = (legacy_id or "").strip()
    if legacy and not any(v == legacy for v in mapping.values()):
        mapping.setdefault("默认", legacy)

    if not mapping:
        return {}, ""

    default = (default_name or "").strip()
    if default and default in mapping:
        return mapping, default
    if "默认" in mapping:
        return mapping, "默认"
    return mapping, next(iter(mapping.keys()))


def resolve_dataset(dataset: str = "") -> tuple[str, str, dict[str, str]]:
    """返回 (库名, uuid, 全量映射)。未知库名时 uuid 为空。"""
    settings = get_settings()
    mapping, default = parse_dify_datasets(
        getattr(settings, "dify_datasets", "") or "",
        legacy_id=settings.dify_dataset_id or "",
        default_name=getattr(settings, "dify_dataset_default", "") or "",
    )
    if not mapping:
        return "", "", {}

    name = (dataset or "").strip() or default
    if name not in mapping:
        return name, "", mapping
    return name, mapping[name], mapping


@register_tool
def search_dify_kb(
    query: str,
    dataset: str = "",
    top_k: int = DEFAULT_TOP_K,
) -> str:
    """按名称检索企业 Dify 知识库（每次只查一个库）。

    知识库问答和指标询问（重投、重复投诉率、及时率、情况如何、口径释义）必须先调本工具，不要先委派子智能体。

    - query: 用户问题，一次带齐城市/时间/指标等关键词
    - dataset: 库名（与 DIFY_DATASETS 一致）；留空用 DIFY_DATASET_DEFAULT
    - top_k: 返回片段数，默认 4

    返回片段按文档时间新→旧排序，含「文档时间」。用户未指定日期时只答最新一期；作答开篇一行写数据时段即可，勿罗列文件名。
    返回「无匹配结果」时，对用户说「暂无此结果」，并询问是否委派数据分析专员，然后结束本轮。同一轮不要再调用 task；等用户下一句同意。
    需要查两个库时，对本工具调用两次并换不同 dataset。
    """
    settings = get_settings()
    base_url = (settings.dify_base_url or "").rstrip("/")
    api_key = settings.dify_api_key or ""

    name, dataset_id, mapping = resolve_dataset(dataset)
    if not base_url or not api_key:
        return "错误：未配置 Dify（请设置 DIFY_BASE_URL / DIFY_API_KEY）"
    if not mapping:
        return (
            "错误：未配置知识库。请设置 DIFY_DATASETS=名称:uuid,... "
            "或兼容项 DIFY_DATASET_ID=uuid"
        )
    if not dataset_id:
        available = "、".join(mapping.keys())
        return f"错误：未知知识库「{name}」。可用名称：{available}"

    top_k = max(1, min(int(top_k or DEFAULT_TOP_K), 8))
    payload = {
        "query": query,
        "retrieval_model": {
            "query": query,
            "search_method": "hybrid_search",
            "reranking_enable": True,
            "top_k": top_k,
            "score_threshold_enabled": True,
            "score_threshold": 0.5,
        },
    }
    url = f"{base_url}/datasets/{dataset_id}/retrieve"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        logger.warning("Dify API %s dataset=%s: %s", e.code, name, detail[:300])
        return f"Dify API 错误 {e.code}（库「{name}」）: {detail[:500]}"
    except Exception as e:
        logger.exception("连接 Dify 失败 dataset=%s", name)
        return f"无法连接 Dify（{url}）: {e}"

    records = sorted(
        body.get("records") or [],
        key=lambda r: float(r.get("score") or 0),
        reverse=True,
    )[:top_k]
    if not records:
        return f"【知识库：{name}】\n（无匹配结果）"

    # 按文档时间新→旧排序，便于模型在未指定日期时只取最近一期
    enriched: list[tuple[str, str, float, str]] = []
    for r in records:
        seg = r.get("segment") or {}
        doc = seg.get("document") or {}
        doc_name = str(doc.get("name") or "").strip() or "(未知)"
        doc_time = extract_doc_time_label(doc_name)
        score = float(r.get("score") or 0)
        content = str(seg.get("content") or "")[:MAX_CONTENT_CHARS]
        enriched.append((doc_time, doc_name, score, content))
    enriched.sort(key=lambda x: (x[0] or "", x[2]), reverse=True)

    chunks: list[str] = [
        f"【知识库：{name}】",
        "作答要求：用户未指定日期时，只根据文档时间最新的一期作答，勿罗列全部；"
        "开篇一行写「数据时段：…」（用下方文档时间），不要写来源文件名。",
    ]
    for i, (doc_time, doc_name, score, content) in enumerate(enriched, 1):
        time_part = doc_time or "（未解析到日期，请据正文写明）"
        chunks.append(
            f"[{i}] 得分 {score:.4f} | 文档时间: {time_part} | 内部文档: {doc_name}\n{content}"
        )
    return "\n\n".join(chunks)
