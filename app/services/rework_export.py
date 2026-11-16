"""重投明细导出：按派单时间从 chongtou_root_cause_detail 出 CSV（全量字段）。"""

from __future__ import annotations

import csv
import io
import json
import logging
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import inspect, text

from app.services.rework_board import TABLE

logger = logging.getLogger(__name__)


def _parse_day(s: str | None) -> date | None:
    if not s:
        return None
    raw = str(s).strip()[:10]
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def resolve_range(
    *,
    start: str | None = None,
    end: str | None = None,
    year: int | None = None,
    month: int | None = None,
) -> tuple[datetime, datetime, str]:
    """返回 [start, end) 与文件名用标签。时间一律按派单时间。"""
    if year and month:
        if not (1 <= int(month) <= 12):
            raise ValueError("month 须为 1~12")
        y, m = int(year), int(month)
        start_dt = datetime(y, m, 1)
        end_dt = datetime(y + 1, 1, 1) if m == 12 else datetime(y, m + 1, 1)
        return start_dt, end_dt, f"{y}{m:02d}"

    d0 = _parse_day(start)
    d1 = _parse_day(end)
    if not d0 or not d1:
        raise ValueError("请提供 year+month，或 start/end（YYYY-MM-DD）")
    if d1 < d0:
        raise ValueError("结束日期不能早于开始日期")
    # end 按「含当天」（允许起止同一天）：次日 0 点为开区间上界
    start_dt = datetime.combine(d0, datetime.min.time())
    end_dt = datetime.combine(d1 + timedelta(days=1), datetime.min.time())
    return start_dt, end_dt, f"{d0.isoformat()}_{d1.isoformat()}"


def _list_columns(engine) -> list[str]:
    """读取表全部物理列名（库序）；派单时间尽量靠前便于查看。"""
    insp = inspect(engine)
    cols = [c["name"] for c in insp.get_columns(TABLE)]
    if not cols:
        raise RuntimeError(f"表 {TABLE} 无可用列")
    if "派单时间" in cols:
        cols = ["派单时间"] + [c for c in cols if c != "派单时间"]
    return cols


def _cell(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.isoformat(sep=" ", timespec="seconds")
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    if hasattr(v, "isoformat"):
        try:
            return v.isoformat(sep=" ", timespec="seconds")  # type: ignore[call-arg]
        except TypeError:
            return v.isoformat()
    return str(v)


def export_rework_csv(
    *,
    start: str | None = None,
    end: str | None = None,
    year: int | None = None,
    month: int | None = None,
    only_chongtou: bool = True,
    limit: int = 200_000,
) -> tuple[str, str, int]:
    """返回 (filename, csv_text, row_count)。导出表内全量字段。"""
    from app.config import get_settings
    from app.db.scheme import get_engine

    if not get_settings().scheme_db_url:
        raise RuntimeError("未配置 SCHEME_DB_URL")

    start_dt, end_dt, tag = resolve_range(start=start, end=end, year=year, month=month)
    engine = get_engine()
    columns = _list_columns(engine)
    cols_sql = ", ".join(f'"{c}"' for c in columns)
    # 派单时间为文本：用 ISO 前缀字典序过滤（与看板 substring 口径一致）
    start_s = start_dt.strftime("%Y-%m-%d")
    end_s = end_dt.strftime("%Y-%m-%d")
    where = [
        "\"派单时间\" ~ '^[0-9]{4}-[0-9]{2}'",
        'btrim("派单时间") >= :start_s',
        'btrim("派单时间") < :end_s',
    ]
    if only_chongtou:
        where.append("\"三节点是否重投\" = '是'")
    sql = text(
        f'''
        SELECT {cols_sql}
        FROM "{TABLE}"
        WHERE {" AND ".join(where)}
        ORDER BY btrim("派单时间")
        LIMIT :lim
        '''
    )
    timeout_ms = int(get_settings().scheme_db_timeout_ms or 60000)
    with engine.connect() as conn:
        conn.execute(text(f"SET statement_timeout = '{timeout_ms}'"))
        rows = conn.execute(
            sql,
            {
                "start_s": start_s,
                "end_s": end_s,
                "lim": max(1, min(int(limit), 500_000)),
            },
        ).mappings().all()

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({c: _cell(row.get(c)) for c in columns})

    scope = "chongtou" if only_chongtou else "all"
    filename = f"rework_export_{scope}_{tag}.csv"
    # UTF-8 BOM 方便 Excel
    return filename, "\ufeff" + buf.getvalue(), len(rows)
