"""方案库 / 投诉工单库只读查询工具（供数据分析 skill 调用）。"""

from app.db.scheme import describe_table, get_allowed_tables, ping, run_readonly_query
from app.tools.registry import register_tool


@register_tool
def scheme_db_ping() -> dict:
    """探测业务 PostgreSQL（方案库/投诉工单库）是否连通，并返回表白名单行数。"""
    return ping()


@register_tool
def scheme_db_describe_table(table: str = "complaint") -> dict:
    """查看业务表结构。table 可选: complaint / scheme / chongtou，或完整表名。

    - complaint → 投诉工单表 complaint_work_order
    - scheme → 方案库表 complaint_work_scheme_library
    - chongtou → 重投归因明细 chongtou_root_cause_detail
    """
    return describe_table(table)


@register_tool
def scheme_db_list_tables() -> dict:
    """列出可查询的业务表逻辑名与物理表名。"""
    from app.config import get_settings

    tables = get_allowed_tables()
    return {
        "scheme": tables["scheme"],
        "complaint": tables["complaint"],
        "chongtou": tables["chongtou"],
        "chongto_repeat_gap_days": get_settings().chongto_repeat_gap_days,
        "note": "中文列名在 SQL 中必须用双引号，如 SELECT \"所属地市\", COUNT(*) FROM complaint_work_order GROUP BY 1",
    }


@register_tool
def scheme_db_query(sql: str, limit: int = 50) -> dict:
    """对业务库执行只读 SQL（仅 SELECT/WITH），用于投诉/方案/重投归因分析。

    约束：
    - 只能访问白名单表 complaint_work_order、complaint_work_scheme_library、chongtou_root_cause_detail
    - 中文列名/表名请加双引号
    - 自动限制返回行数（默认 50，上限见配置）
    """
    return run_readonly_query(sql, limit=limit)
