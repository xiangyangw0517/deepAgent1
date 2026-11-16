"""月度重投报告：SQL+Python 算同比/环比 → 固定 HTML 模板 → LLM 写核心洞察。"""

from __future__ import annotations

import logging
from calendar import monthrange
from datetime import datetime
from html import escape

from sqlalchemy import text

from app.services.rework_board import CITIES, REASON_SHORT, REASONS, TABLE

logger = logging.getLogger(__name__)


def _month_bounds(year: int, month: int) -> tuple[datetime, datetime]:
    start = datetime(year, month, 1)
    if month == 12:
        end = datetime(year + 1, 1, 1)
    else:
        end = datetime(year, month + 1, 1)
    return start, end


def _shift_month(year: int, month: int, delta: int) -> tuple[int, int]:
    idx = year * 12 + (month - 1) + delta
    return idx // 12, idx % 12 + 1


def _pct(cur: float, base: float) -> float | None:
    if base == 0:
        return None
    return round((cur - base) / base * 100.0, 2)


def _delta(cur: float, base: float) -> float:
    return round(cur - base, 2)


def _fmt_pct(v: float | None) -> str:
    if v is None:
        return "—"
    sign = "+" if v > 0 else ""
    return f"{sign}{v:.2f}%"


def _fmt_n(n: int | float) -> str:
    return f"{int(n):,}"


def _query_period(conn, start: datetime, end: datetime) -> dict:
    sql_total = text(
        f'''
        SELECT COUNT(*) AS n
        FROM "{TABLE}"
        WHERE "三节点是否重投" = '是'
          AND NULLIF(btrim("派单时间"), '')::timestamp >= :s
          AND NULLIF(btrim("派单时间"), '')::timestamp < :e
        '''
    )
    sql_city = text(
        f'''
        SELECT COALESCE(NULLIF(btrim("投诉所属地市"), ''), '未知') AS city, COUNT(*) AS n
        FROM "{TABLE}"
        WHERE "三节点是否重投" = '是'
          AND NULLIF(btrim("派单时间"), '')::timestamp >= :s
          AND NULLIF(btrim("派单时间"), '')::timestamp < :e
        GROUP BY 1
        ORDER BY n DESC
        '''
    )
    sql_reason = text(
        f'''
        SELECT btrim("重投原因") AS reason, COUNT(*) AS n
        FROM "{TABLE}"
        WHERE "三节点是否重投" = '是'
          AND NULLIF(btrim("派单时间"), '')::timestamp >= :s
          AND NULLIF(btrim("派单时间"), '')::timestamp < :e
        GROUP BY 1
        ORDER BY n DESC
        '''
    )
    params = {"s": start, "e": end}
    total = int(conn.execute(sql_total, params).scalar() or 0)
    cities = {str(r["city"]): int(r["n"]) for r in conn.execute(sql_city, params).mappings()}
    reasons = {str(r["reason"] or ""): int(r["n"]) for r in conn.execute(sql_reason, params).mappings()}
    return {"total": total, "cities": cities, "reasons": reasons}


def compute_monthly_metrics(year: int, month: int) -> dict:
    from app.config import get_settings
    from app.db.scheme import get_engine

    if not get_settings().scheme_db_url:
        raise RuntimeError("未配置 SCHEME_DB_URL")
    if not (1 <= month <= 12):
        raise ValueError("month 须为 1~12")

    cur_s, cur_e = _month_bounds(year, month)
    py, pm = _shift_month(year, month, -1)
    prev_s, prev_e = _month_bounds(py, pm)
    yoy_s, yoy_e = _month_bounds(year - 1, month)

    timeout_ms = int(get_settings().scheme_db_timeout_ms or 60000)
    engine = get_engine()
    with engine.connect() as conn:
        conn.execute(text(f"SET statement_timeout = '{timeout_ms}'"))
        cur = _query_period(conn, cur_s, cur_e)
        prev = _query_period(conn, prev_s, prev_e)
        yoy = _query_period(conn, yoy_s, yoy_e)

    city_rows = []
    city_names = list(dict.fromkeys([*CITIES, *cur["cities"].keys(), *prev["cities"].keys(), *yoy["cities"].keys()]))
    for city in city_names:
        c = cur["cities"].get(city, 0)
        p = prev["cities"].get(city, 0)
        y = yoy["cities"].get(city, 0)
        if c == 0 and p == 0 and y == 0:
            continue
        city_rows.append(
            {
                "city": city,
                "cur": c,
                "prev": p,
                "yoy": y,
                "mom_abs": _delta(c, p),
                "mom_pct": _pct(c, p),
                "yoy_abs": _delta(c, y),
                "yoy_pct": _pct(c, y),
            }
        )
    city_rows.sort(key=lambda r: r["cur"], reverse=True)

    reason_rows = []
    reason_names = list(dict.fromkeys([*REASONS, *cur["reasons"].keys(), *prev["reasons"].keys(), *yoy["reasons"].keys()]))
    short_map = {a: b for a, b in zip(REASONS, REASON_SHORT)}
    for reason in reason_names:
        c = cur["reasons"].get(reason, 0)
        p = prev["reasons"].get(reason, 0)
        y = yoy["reasons"].get(reason, 0)
        if c == 0 and p == 0 and y == 0:
            continue
        reason_rows.append(
            {
                "reason": reason,
                "short": short_map.get(reason, reason),
                "cur": c,
                "prev": p,
                "yoy": y,
                "mom_abs": _delta(c, p),
                "mom_pct": _pct(c, p),
                "yoy_abs": _delta(c, y),
                "yoy_pct": _pct(c, y),
            }
        )
    reason_rows.sort(key=lambda r: r["cur"], reverse=True)

    total = cur["total"]
    top_city = city_rows[0] if city_rows else None
    top_reason = reason_rows[0] if reason_rows else None
    worst_mom_city = None
    if city_rows:
        # 涨幅最大（环比 %，无对比则跳过）
        ranked = [r for r in city_rows if r["mom_pct"] is not None]
        if ranked:
            worst_mom_city = max(ranked, key=lambda r: r["mom_pct"])

    return {
        "period": {
            "year": year,
            "month": month,
            "label": f"{year}年{month}月",
            "prev_label": f"{py}年{pm}月",
            "yoy_label": f"{year - 1}年{month}月",
            "days": monthrange(year, month)[1],
            "dispatch_time_field": "派单时间",
        },
        "totals": {
            "cur": total,
            "prev": prev["total"],
            "yoy": yoy["total"],
            "mom_abs": _delta(total, prev["total"]),
            "mom_pct": _pct(total, prev["total"]),
            "yoy_abs": _delta(total, yoy["total"]),
            "yoy_pct": _pct(total, yoy["total"]),
        },
        "cities": city_rows,
        "reasons": reason_rows,
        "highlights": {
            "top_city": top_city,
            "top_reason": top_reason,
            "worst_mom_city": worst_mom_city,
        },
    }


def render_report_html(metrics: dict, insight: str) -> str:
    p = metrics["period"]
    t = metrics["totals"]
    insight_html = escape(insight or "（暂无模型洞察）").replace("\n", "<br/>")

    city_trs = []
    for r in metrics["cities"]:
        city_trs.append(
            "<tr>"
            f"<td>{escape(r['city'])}</td>"
            f"<td class='num'>{_fmt_n(r['cur'])}</td>"
            f"<td class='num'>{_fmt_n(r['prev'])}</td>"
            f"<td class='num'>{_fmt_n(r['mom_abs'])}</td>"
            f"<td class='num'>{_fmt_pct(r['mom_pct'])}</td>"
            f"<td class='num'>{_fmt_n(r['yoy'])}</td>"
            f"<td class='num'>{_fmt_n(r['yoy_abs'])}</td>"
            f"<td class='num'>{_fmt_pct(r['yoy_pct'])}</td>"
            "</tr>"
        )
    reason_trs = []
    for r in metrics["reasons"]:
        reason_trs.append(
            "<tr>"
            f"<td>{escape(r['reason'])}</td>"
            f"<td class='num'>{_fmt_n(r['cur'])}</td>"
            f"<td class='num'>{_fmt_n(r['prev'])}</td>"
            f"<td class='num'>{_fmt_n(r['mom_abs'])}</td>"
            f"<td class='num'>{_fmt_pct(r['mom_pct'])}</td>"
            f"<td class='num'>{_fmt_n(r['yoy'])}</td>"
            f"<td class='num'>{_fmt_n(r['yoy_abs'])}</td>"
            f"<td class='num'>{_fmt_pct(r['yoy_pct'])}</td>"
            "</tr>"
        )

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>重投月报 · {escape(p['label'])}</title>
<style>
  body {{ font-family: "PingFang SC","Microsoft YaHei",sans-serif; color:#1f2d3d; margin:0; padding:24px; background:#f5f8fc; }}
  .wrap {{ max-width: 920px; margin:0 auto; background:#fff; border-radius:14px; padding:28px 32px; }}
  h1 {{ margin:0 0 6px; font-size:22px; color:#08324f; }}
  .meta {{ color:#54708a; font-size:13px; margin-bottom:18px; }}
  .insight {{ background:linear-gradient(135deg,#eef6ff,#f7fbff); border-left:4px solid #1f6fd6; padding:14px 16px; border-radius:10px; margin:16px 0 22px; line-height:1.65; }}
  .kpis {{ display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:22px; }}
  .kpi {{ background:#f8fafc; border-radius:10px; padding:12px 14px; }}
  .kpi span {{ display:block; color:#54708a; font-size:12px; }}
  .kpi strong {{ font-size:22px; color:#08324f; }}
  .kpi em {{ font-style:normal; font-size:12px; color:#64748b; }}
  h2 {{ font-size:16px; margin:22px 0 10px; color:#08324f; }}
  table {{ width:100%; border-collapse:collapse; font-size:12.5px; }}
  th, td {{ border-bottom:1px solid #e8eef5; padding:8px 6px; text-align:left; }}
  th {{ background:#f3f7fb; color:#3d556c; font-weight:600; }}
  td.num, th.num {{ text-align:right; font-variant-numeric:tabular-nums; }}
  .foot {{ margin-top:18px; color:#8296a8; font-size:12px; }}
  @media print {{ body {{ background:#fff; padding:0; }} .wrap {{ box-shadow:none; }} }}
</style>
</head>
<body>
<div class="wrap">
  <h1>投诉管控 · 重投月度报告</h1>
  <div class="meta">统计月份：{escape(p['label'])} · 时间字段：派单时间 · 口径：三节点是否重投=是 · 环比对照 {escape(p['prev_label'])} · 同比对照 {escape(p['yoy_label'])}</div>
  <div class="insight"><strong>📊 核心洞察与建议</strong><br/>{insight_html}</div>
  <div class="kpis">
    <div class="kpi"><span>本月重投总量</span><strong>{_fmt_n(t['cur'])}</strong></div>
    <div class="kpi"><span>环比（较 {escape(p['prev_label'])}）</span><strong>{_fmt_pct(t['mom_pct'])}</strong><em>绝对 {_fmt_n(t['mom_abs'])} 单</em></div>
    <div class="kpi"><span>同比（较 {escape(p['yoy_label'])}）</span><strong>{_fmt_pct(t['yoy_pct'])}</strong><em>绝对 {_fmt_n(t['yoy_abs'])} 单</em></div>
  </div>
  <h2>分地市对比</h2>
  <table>
    <thead><tr>
      <th>地市</th><th class="num">本月</th><th class="num">上月</th><th class="num">环比增减</th><th class="num">环比%</th>
      <th class="num">去年同月</th><th class="num">同比增减</th><th class="num">同比%</th>
    </tr></thead>
    <tbody>
      {''.join(city_trs) or '<tr><td colspan="8">暂无地市数据</td></tr>'}
    </tbody>
  </table>
  <h2>各重投原因对比</h2>
  <table>
    <thead><tr>
      <th>重投原因</th><th class="num">本月</th><th class="num">上月</th><th class="num">环比增减</th><th class="num">环比%</th>
      <th class="num">去年同月</th><th class="num">同比增减</th><th class="num">同比%</th>
    </tr></thead>
    <tbody>
      {''.join(reason_trs) or '<tr><td colspan="8">暂无原因数据</td></tr>'}
    </tbody>
  </table>
  <p class="foot">数据来源表 {escape(TABLE)} · 由系统按派单时间聚合生成 · 洞察段落由大模型根据关键指标撰写</p>
</div>
</body>
</html>
"""


async def generate_insight(metrics: dict) -> str:
    """用主模型写约 200 字洞察（等价于 analytics 总结角色，不经 task 委派）。"""
    from app.agent.llm import build_llm
    from app.config import get_settings

    p = metrics["period"]
    t = metrics["totals"]
    h = metrics["highlights"]
    top_city = h.get("top_city") or {}
    top_reason = h.get("top_reason") or {}
    worst = h.get("worst_mom_city") or {}
    prompt = (
        f"你是中国移动投诉数据分析专员。根据下列已核实指标，写一段约 180~220 字的中文"
        f"「核心洞察与建议」。只依据数字，不要编造未给出的数据；不要 Markdown 标题；不要寒暄。\n"
        f"月份：{p['label']}（派单时间）\n"
        f"本月总量：{t['cur']}；上月：{t['prev']}；环比%：{t['mom_pct']}；"
        f"去年同月：{t['yoy']}；同比%：{t['yoy_pct']}\n"
        f"单量最高地市：{top_city.get('city','—')}（{top_city.get('cur',0)}单）\n"
        f"环比涨幅最大地市：{worst.get('city','—')}（环比 {worst.get('mom_pct')}%）\n"
        f"最多原因：{top_reason.get('reason','—')}（{top_reason.get('cur',0)}单）\n"
    )
    try:
        llm = build_llm(get_settings())
        msg = await llm.ainvoke(prompt)
        text_out = getattr(msg, "content", None) or str(msg)
        if isinstance(text_out, list):
            text_out = "".join(
                (x.get("text") if isinstance(x, dict) else str(x)) for x in text_out
            )
        return str(text_out).strip()[:800]
    except Exception as exc:
        logger.warning("月报洞察生成失败: %s", exc)
        return (
            f"{p['label']}重投总量 {_fmt_n(t['cur'])} 单，环比 {_fmt_pct(t['mom_pct'])}，"
            f"同比 {_fmt_pct(t['yoy_pct'])}。建议重点关注单量领先地市与头部原因，"
            f"结合一线处置质量持续压降重投。"
        )


async def build_monthly_report(year: int, month: int) -> dict:
    metrics = compute_monthly_metrics(year, month)
    insight = await generate_insight(metrics)
    html = render_report_html(metrics, insight)
    return {
        "period": metrics["period"],
        "totals": metrics["totals"],
        "highlights": metrics["highlights"],
        "insight": insight,
        "html": html,
        "cities": metrics["cities"],
        "reasons": metrics["reasons"],
    }
