"""只负责把视图挂到 /api，不写具体接口。"""

from fastapi import APIRouter

from app.api.views.chat import router as chat_router
from app.api.views.dashboard import router as dashboard_router

router = APIRouter()
router.include_router(dashboard_router)
router.include_router(chat_router)
