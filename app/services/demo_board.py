"""受理看板演示数据（仅供前端 KPI / 最近工单展示，不注册为智能体工具）。"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta

_TICKETS: dict[str, dict] = {}


def list_tickets(limit: int = 50) -> list[dict]:
    items = sorted(_TICKETS.values(), key=lambda t: t["created_at"], reverse=True)
    return items[:limit]


def get_dashboard_stats() -> dict:
    tickets = list(_TICKETS.values())
    today = datetime.now().strftime("%Y-%m-%d")
    today_count = sum(1 for t in tickets if t["created_at"].startswith(today))
    by_category = Counter(t["category"] for t in tickets)
    by_status = Counter(t["status"] for t in tickets)
    by_urgency = Counter(t["urgency"] for t in tickets)
    return {
        "total": len(tickets),
        "today": today_count,
        "processing": by_status.get("处理中", 0) + by_status.get("已受理", 0),
        "closed": by_status.get("已办结", 0),
        "urgent": by_urgency.get("紧急", 0) + by_urgency.get("升级", 0),
        "by_category": dict(by_category),
        "by_status": dict(by_status),
        "by_urgency": dict(by_urgency),
    }


def seed_demo_tickets() -> None:
    """空库时写入演示工单，方便看板演示。"""
    if _TICKETS:
        return
    demo = [
        ("13800000001", "资费争议", "增值业务视频彩铃扣费争议", "紧急", "处理中", 2),
        ("13900000002", "网络质量", "小区 5G 弱覆盖无法上网", "普通", "已受理", 5),
        ("13700000003", "业务办理", "携号转网申请未生效", "升级", "处理中", 8),
        ("13600000004", "服务态度", "营业厅排队久且态度生硬", "普通", "已办结", 26),
        ("13500000005", "资费争议", "套外流量费用未收到提醒", "普通", "已办结", 30),
        ("13400000006", "网络质量", "夜间频繁掉话", "紧急", "已受理", 1),
        ("13300000007", "其他", "短信验证码延迟", "普通", "已办结", 40),
        ("13200000008", "资费争议", "套餐变更后仍按旧资费扣费", "紧急", "处理中", 3),
    ]
    now = datetime.now()
    for i, (phone, category, summary, urgency, status, hours_ago) in enumerate(demo):
        created = now - timedelta(hours=hours_ago)
        ticket_id = f"TS{created:%Y%m%d}{100000 + i}"
        _TICKETS[ticket_id] = {
            "ticket_id": ticket_id,
            "phone": phone,
            "category": category,
            "summary": summary,
            "urgency": urgency,
            "status": status,
            "created_at": created.isoformat(timespec="seconds"),
        }
