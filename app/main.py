import logging
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.agent.factory import build_agent
from app.api.routes import router
from app.config import BASE_DIR, get_settings
from app.services.demo_board import seed_demo_tickets

# LangSmith / 其它运行时环境变量读的是 os.environ；
# pydantic Settings 不会把 .env 里未声明字段注入进程，这里统一加载一次。
load_dotenv(BASE_DIR / ".env", override=False)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    import os

    tracing = os.getenv("LANGSMITH_TRACING", "").lower() in {"1", "true", "yes"}
    project = (os.getenv("LANGSMITH_PROJECT") or "default").strip()
    has_key = bool(os.getenv("LANGSMITH_API_KEY") or os.getenv("LANGCHAIN_API_KEY"))
    if tracing and has_key:
        logger.info("LangSmith 追踪已开启 → project=%s", project)
    elif tracing and not has_key:
        logger.warning("LANGSMITH_TRACING=true 但未配置 LANGSMITH_API_KEY，将无法上报")
    else:
        logger.info("LangSmith 追踪未开启（设置 LANGSMITH_TRACING=true 与 API Key 后生效）")

    settings = get_settings()
    if settings.scheme_db_url:
        logger.info("已配置业务库，启动时不探测连接（避免库不可达时卡住就绪）")
    else:
        logger.info("未配置 SCHEME_DB_URL，跳过业务库连接")

    seed_demo_tickets()
    app.state.agent, app.state.subagents = await build_agent(settings)
    yield


app = FastAPI(title=get_settings().app_name, lifespan=lifespan)
app.include_router(router, prefix="/api")
app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")
# 手机效果演示：/m/ → frontend/mobile/
app.mount("/m", StaticFiles(directory=FRONTEND_DIR / "mobile", html=True), name="mobile")


@app.get("/")
async def index():
    return FileResponse(FRONTEND_DIR / "index.html")
