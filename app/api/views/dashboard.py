"""看板相关接口：重投工作台、导出、月报；演示 KPI 接口保留兼容。"""

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.api.schemas import Capabilities, DashboardStats, TicketItem
from app.services.demo_board import get_dashboard_stats, list_tickets
from app.tools import list_tools

router = APIRouter()


class ReworkReportRequest(BaseModel):
    year: int = Field(..., ge=2000, le=2100)
    month: int = Field(..., ge=1, le=12)


@router.get("/health")
async def health():
    """存活检查，不连业务库。库不通时探测会卡到 TCP 超时，打开页面会跟着等。"""
    return {"status": "ok"}


@router.get("/capabilities", response_model=Capabilities)
async def capabilities(request: Request):
    """查看当前已加载的工具和子智能体，便于排查配置是否生效。"""
    return Capabilities(
        tools=list_tools(),
        subagents={s.name: s.description for s in request.app.state.subagents},
    )


@router.get("/dashboard/stats", response_model=DashboardStats)
async def dashboard_stats(request: Request):
    """看板 KPI + 子智能体/工具元信息（演示工单来自 demo_board）。"""
    stats = get_dashboard_stats()
    return DashboardStats(
        **stats,
        subagents={s.name: s.description for s in request.app.state.subagents},
        tools_count=len(list_tools()),
    )


@router.get("/dashboard/tickets", response_model=list[TicketItem])
async def dashboard_tickets(limit: int = 20):
    """最近演示工单列表（仅看板展示，非智能体建单结果）。"""
    return [TicketItem(**t) for t in list_tickets(limit=limit)]


@router.get("/dashboard/chongtou-3node")
async def dashboard_chongtou_3node():
    """最新发单表 · 三节点重投（三级工单量/重投量/重投率）。

    通过可配置 FADAN_API_BASE_URL 调用远端 files + download，在本服务解析。
    """
    from app.config import get_settings
    from app.services.fadan_chongtou import fetch_latest_chongtou_3node

    settings = get_settings()
    return fetch_latest_chongtou_3node(
        settings.fadan_api_base_url,
        timeout=float(settings.fadan_api_timeout_sec or 90),
    )


@router.get("/dashboard/rework")
async def dashboard_rework():
    """三级节点重投看板。查数在 app/services/rework_board.py。"""
    from app.services.rework_board import fetch_rework_board

    return fetch_rework_board()


@router.get("/dashboard/rework/export")
async def dashboard_rework_export(
    year: int | None = Query(None),
    month: int | None = Query(None, ge=1, le=12),
    start: str | None = Query(None, description="派单开始日 YYYY-MM-DD"),
    end: str | None = Query(None, description="派单结束日 YYYY-MM-DD（含）"),
    only_chongtou: bool = Query(True, description="仅导出三节点重投=是"),
):
    """按派单时间从业务库导出 CSV。"""
    from app.services.rework_export import export_rework_csv

    try:
        filename, body, row_count = export_rework_csv(
            year=year,
            month=month,
            start=start,
            end=end,
            only_chongtou=only_chongtou,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return Response(
        content=body.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Export-Rows": str(row_count),
        },
    )


@router.post("/dashboard/rework/report")
async def dashboard_rework_report(body: ReworkReportRequest):
    """月度重投报告：SQL 算环比/同比 + 固定模板 + 模型洞察。"""
    from app.services.rework_report import build_monthly_report

    try:
        return await build_monthly_report(body.year, body.month)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
