"""三级节点重投看板数据。

GET /api/dashboard/rework 的返回结构固定，页面按这个结构渲染。
数据来自 .env 的 SCHEME_DB_URL，表 chongtou_root_cause_detail。
只统计「三节点是否重投 = 是」，按派单月份、地市、重投原因汇总。

reasons 顺序与 REASONS 一致。
"""

import logging

from sqlalchemy import text

logger = logging.getLogger(__name__)

TABLE = "chongtou_root_cause_detail"

CITIES = [
    "长沙",
    "湘潭",
    "株洲",
    "衡阳",
    "郴州",
    "常德",
    "益阳",
    "娄底",
    "邵阳",
    "岳阳",
    "自治州",
    "张家界",
    "怀化",
    "永州",
]

REASONS = [
    "前一张工单未彻底解决",
    "超时",
    "未达客户预期",
    "处理时间过长",
    "工单错误",
    "用户被限速",
    "未实质性处理",
    "投诉不同问题",
]

REASON_SHORT = [
    "前一张未解决",
    "超时",
    "未达预期",
    "处理过长",
    "工单错误",
    "被限速",
    "未实质处理",
    "不同问题",
]


def _empty(error: str = "") -> dict:
    meta = {"source": TABLE, "updatedAt": "", "ready": False}
    if error:
        meta["error"] = error
    return {
        "meta": meta,
        "cities": list(CITIES),
        "reasons": REASONS,
        "reasonShort": REASON_SHORT,
        "months": {},
    }


def fetch_rework_board() -> dict:
    from app.config import get_settings
    from app.db.scheme import get_engine

    if not get_settings().scheme_db_url:
        return _empty("未配置 SCHEME_DB_URL")

    reason_index = {name: i for i, name in enumerate(REASONS)}
    sql = text(
        f'''
        SELECT
            substring("派单时间" from 1 for 7) AS ym,
            COALESCE(NULLIF(btrim("投诉所属地市"), ''), '未知') AS city,
            btrim("重投原因") AS reason,
            COUNT(*) AS n,
            MAX("updated_at") AS updated_at
        FROM "{TABLE}"
        WHERE "三节点是否重投" = '是'
          AND "派单时间" ~ '^[0-9]{{4}}-[0-9]{{2}}'
          AND btrim("重投原因") = ANY(:reasons)
        GROUP BY 1, 2, 3
        '''
    )
    try:
        engine = get_engine()
        timeout_ms = int(get_settings().scheme_db_timeout_ms or 60000)
        with engine.connect() as conn:
            conn.execute(text(f"SET statement_timeout = '{timeout_ms}'"))
            rows = conn.execute(sql, {"reasons": REASONS}).mappings().all()
    except Exception as exc:
        logger.warning("重投看板查询失败: %s", exc)
        return _empty(str(exc))

    buckets: dict[str, dict[str, list[int]]] = {}
    updated = ""
    extra_cities: list[str] = []
    for row in rows:
        ym = str(row["ym"] or "")
        city = str(row["city"] or "未知")
        reason = str(row["reason"] or "")
        idx = reason_index.get(reason)
        if not ym or idx is None:
            continue
        city_rows = buckets.setdefault(ym, {})
        counts = city_rows.setdefault(city, [0] * len(REASONS))
        counts[idx] += int(row["n"] or 0)
        if city not in CITIES and city not in extra_cities:
            extra_cities.append(city)
        stamp = row["updated_at"]
        if stamp is not None:
            text_stamp = stamp.isoformat(sep=" ", timespec="seconds")
            if text_stamp > updated:
                updated = text_stamp

    months = {}
    for ym in sorted(buckets):
        cities = []
        for city in [*CITIES, *extra_cities]:
            counts = buckets[ym].get(city)
            if not counts:
                continue
            cities.append({"city": city, "total": sum(counts), "reasons": counts})
        if cities:
            months[ym] = {"cities": cities}

    return {
        "meta": {"source": TABLE, "updatedAt": updated, "ready": bool(months)},
        "cities": [*CITIES, *extra_cities],
        "reasons": REASONS,
        "reasonShort": REASON_SHORT,
        "months": months,
    }
