"""从 config/mcp_servers.json 加载 MCP 工具，并注册进工具注册表。

工具名统一加服务前缀（如 `crm_query_order`），子智能体在 `tools` 中按此名字引用。
"""

import json
import logging
from pathlib import Path

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient

from app.tools import register_external_tools

logger = logging.getLogger(__name__)


def _load_connections(config_file: Path) -> dict[str, dict]:
    if not config_file.exists():
        return {}
    servers = json.loads(config_file.read_text(encoding="utf-8")).get("servers", {})
    return {
        name: {k: v for k, v in cfg.items() if k != "enabled"}
        for name, cfg in servers.items()
        if cfg.get("enabled", True)
    }


async def load_mcp_tools(config_file: Path) -> list[BaseTool]:
    connections = _load_connections(config_file)
    if not connections:
        return []

    client = MultiServerMCPClient(connections, tool_name_prefix=True)
    tools: list[BaseTool] = []
    # 逐个服务加载，单个 MCP 服务不可用不影响整体启动
    for server in connections:
        try:
            server_tools = await client.get_tools(server_name=server)
            tools.extend(server_tools)
            logger.info("MCP[%s] 加载 %d 个工具", server, len(server_tools))
        except Exception:
            logger.exception("MCP[%s] 加载失败，已跳过", server)

    register_external_tools(tools)
    return tools
