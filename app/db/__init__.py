"""业务库连接（方案库 / 投诉工单等），供工具与后续分析 skill 使用。"""

from app.db.scheme import (
    describe_table,
    get_allowed_tables,
    get_engine,
    ping,
    run_readonly_query,
)

__all__ = [
    "describe_table",
    "get_allowed_tables",
    "get_engine",
    "ping",
    "run_readonly_query",
]
