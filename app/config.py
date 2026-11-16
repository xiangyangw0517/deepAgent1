"""全局配置：统一从环境变量 / .env 读取。"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BASE_DIR / ".env", extra="ignore")

    app_name: str = "移动投诉智能体"

    # OpenAI 兼容接口（通义千问 / DeepSeek / 自建 vLLM 等均可）
    llm_model: str = "qwen-plus"
    llm_base_url: str | None = None
    llm_api_key: str = ""
    llm_temperature: float = 0.2

    skills_dir: Path = BASE_DIR / "skills"
    mcp_config_file: Path = BASE_DIR / "config" / "mcp_servers.json"

    # Dify 知识库（与 skills/knowledge/dify-kb-search 共用）
    dify_base_url: str = "http://127.0.0.1:5001/v1"
    dify_api_key: str = ""
    # 兼容单库：等同于 DIFY_DATASETS 里的「默认」
    dify_dataset_id: str = ""
    # 方案 C：命名多库，格式 名称:uuid,名称:uuid（逗号分隔）
    # 例：投诉口径:843c57e1-...,网络指标:bbbbbbbb-...
    dify_datasets: str = ""
    # 未传 dataset 参数时使用的库名；空则优先「默认」，否则取 DIFY_DATASETS 第一项
    dify_dataset_default: str = ""

    # Dify 周报/月报对话应用（/v1/chat-messages，Bearer app-xxx）
    dify_report_base_url: str = "http://localhost/v1"
    dify_report_api_key: str = ""
    dify_report_user: str = "complaint-agent"
    # 内网优先 blocking；若应用不支持会自动回退 streaming
    dify_report_response_mode: str = "blocking"
    dify_report_timeout_sec: int = 180

    # 业务 PostgreSQL（方案库 / 投诉工单 / 重投归因，供数据分析 skill 使用）
    scheme_db_url: str = ""
    scheme_db_scheme_table: str = "complaint_work_scheme_library"
    scheme_db_complaint_table: str = "complaint_work_order"
    scheme_db_chongtou_table: str = "chongtou_root_cause_detail"
    scheme_db_max_rows: int = 100
    scheme_db_timeout_ms: int = 60000
    # 重投原因 3/4 类：派单间隔阈值（天）
    chongto_repeat_gap_days: int = 3

    # 发单表服务（complaint-agent）。测试/生产只改此 BASE，勿写死端口。
    # 使用已有接口：GET /api/v1/fadan/files 、GET /api/v1/fadan/download/{filename}
    fadan_api_base_url: str = "http://127.0.0.1:8002"
    fadan_api_timeout_sec: float = 90


@lru_cache
def get_settings() -> Settings:
    return Settings()
