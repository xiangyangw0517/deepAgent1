"""方案/投诉工单 PostgreSQL 连接与只读查询。

仅允许对配置表白名单做 SELECT/CTE；禁止写操作与多语句。
中文列名/表名在 SQL 中需用双引号包裹，例如："所属地市"。
"""

from __future__ import annotations

import logging
import re
from functools import lru_cache
from typing import Any

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine

from app.config import get_settings

logger = logging.getLogger(__name__)

_FORBIDDEN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|"
    r"CALL|EXECUTE|MERGE|REPLACE|ATTACH|DETACH|VACUUM|ANALYZE|COMMENT|SET|RESET)\b",
    re.IGNORECASE,
)
_MULTI_STMT = re.compile(r";\s*\S")


@lru_cache
def get_engine() -> Engine:
    settings = get_settings()
    if not settings.scheme_db_url:
        raise RuntimeError("未配置 SCHEME_DB_URL")
    return create_engine(
        settings.scheme_db_url,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=5,
        connect_args={"connect_timeout": 5},
    )


def get_allowed_tables() -> dict[str, str]:
    """逻辑名 → 实际表名。"""
    s = get_settings()
    return {
        "scheme": s.scheme_db_scheme_table,
        "complaint": s.scheme_db_complaint_table,
        "chongtou": s.scheme_db_chongtou_table,
        s.scheme_db_scheme_table: s.scheme_db_scheme_table,
        s.scheme_db_complaint_table: s.scheme_db_complaint_table,
        s.scheme_db_chongtou_table: s.scheme_db_chongtou_table,
    }


def get_allowed_physical_tables() -> set[str]:
    s = get_settings()
    return {
        s.scheme_db_scheme_table,
        s.scheme_db_complaint_table,
        s.scheme_db_chongtou_table,
    }


def ping() -> dict[str, Any]:
    try:
        engine = get_engine()
        with engine.connect() as conn:
            db, user = conn.execute(text("select current_database(), current_user")).fetchone()
            tables = get_allowed_tables()
            counts = {}
            for key in ("scheme", "complaint", "chongtou"):
                t = tables[key]
                try:
                    counts[t] = conn.execute(text(f'SELECT COUNT(*) FROM "{t}"')).scalar()
                except Exception as e:
                    counts[t] = f"error: {e}"
        return {"ok": True, "database": db, "user": user, "tables": counts}
    except Exception as e:
        logger.exception("scheme db ping failed")
        return {"ok": False, "error": str(e)}


def describe_table(table_key: str) -> dict[str, Any]:
    tables = get_allowed_tables()
    physical = tables.get(table_key) or tables.get(table_key.strip())
    if not physical:
        return {
            "error": f"未知表: {table_key}",
            "allowed": sorted(get_allowed_physical_tables()),
        }
    engine = get_engine()
    insp = inspect(engine)
    if physical not in insp.get_table_names():
        return {"error": f"库中不存在表: {physical}"}
    cols = [{"name": c["name"], "type": str(c["type"])} for c in insp.get_columns(physical)]
    with engine.connect() as conn:
        n = conn.execute(text(f'SELECT COUNT(*) FROM "{physical}"')).scalar()
    return {"table": physical, "row_count": n, "columns": cols}


# PostgreSQL 函数里也会出现 FROM（非表引用），扫表前先抹掉，避免误判
# 例：substring(x from 1 for 7)、extract(year from ts)、trim(both from x)
_FROM_IN_FUNCS = re.compile(
    r"\b(?:SUBSTRING|SUBSTR|EXTRACT|TRIM|OVERLAY|SIMILAR)\s*\([^)]*?\)",
    re.IGNORECASE | re.DOTALL,
)
_FROM_JOIN_TABLE = re.compile(
    r'\b(?:FROM|JOIN)\s+(?:"([^"]+)"|([A-Za-z_][\w]*))',
    re.IGNORECASE,
)
_SQL_JUNK = {
    "SELECT",
    "WHERE",
    "AND",
    "OR",
    "GROUP",
    "ORDER",
    "LIMIT",
    "AS",
    "ON",
    "LEFT",
    "RIGHT",
    "INNER",
    "OUTER",
    "CROSS",
    "FULL",
    "LATERAL",
    "ONLY",
    "TRUE",
    "FALSE",
    "NULL",
}


def _from_join_tables(sql: str) -> set[str]:
    """提取 FROM/JOIN 后的表名；忽略函数内的 from（如 substring from 1）。"""
    masked = _FROM_IN_FUNCS.sub("/*fn*/", sql)
    names: set[str] = set()
    for quoted, bare in _FROM_JOIN_TABLE.findall(masked):
        name = (quoted or bare or "").strip()
        if not name or name.isdigit() or name.upper() in _SQL_JUNK:
            continue
        names.add(name)
    return names


def _validate_readonly_sql(sql: str, allowed_physical: set[str]) -> str:
    cleaned = sql.strip().rstrip(";").strip()
    if not cleaned:
        raise ValueError("SQL 为空")
    if _MULTI_STMT.search(sql.strip()):
        raise ValueError("禁止多语句 SQL")
    if _FORBIDDEN.search(cleaned):
        raise ValueError("仅允许只读 SELECT / WITH 查询")
    head = cleaned.lstrip("(").lstrip().upper()
    if not (head.startswith("SELECT") or head.startswith("WITH")):
        raise ValueError("仅允许 SELECT 或 WITH ... SELECT")

    from_join = _from_join_tables(cleaned)
    bad = from_join - allowed_physical
    if bad:
        raise ValueError(f"禁止访问未授权表: {sorted(bad)}；允许: {sorted(allowed_physical)}")

    return cleaned


def run_readonly_query(sql: str, limit: int = 50) -> dict[str, Any]:
    settings = get_settings()
    allowed = get_allowed_physical_tables()
    limit = max(1, min(int(limit or 50), settings.scheme_db_max_rows))
    timeout_ms = int(settings.scheme_db_timeout_ms)
    try:
        cleaned = _validate_readonly_sql(sql, allowed)
        # 外层包一层 LIMIT，避免模型漏写
        wrapped = f"SELECT * FROM ({cleaned}) AS _q LIMIT {limit}"
        engine = get_engine()
        with engine.connect() as conn:
            with conn.begin():
                conn.execute(text(f"SET LOCAL statement_timeout = '{timeout_ms}'"))
                result = conn.execute(text(wrapped))
                rows = [dict(r) for r in result.mappings().all()]
            for row in rows:
                for k, v in list(row.items()):
                    if hasattr(v, "isoformat"):
                        row[k] = v.isoformat(sep=" ", timespec="seconds")
                    elif v is not None and not isinstance(v, (str, int, float, bool)):
                        row[k] = str(v)
        return {
            "ok": True,
            "row_count": len(rows),
            "limit": limit,
            "rows": rows,
        }
    except Exception as e:
        logger.warning("scheme query failed: %s", e)
        return {"ok": False, "error": str(e)}
