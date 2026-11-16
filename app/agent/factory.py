"""把工具、子智能体、skills、MCP 组装成一个 deep agent。

这里只负责「组装」，不放业务逻辑；新增能力请到对应目录添加，而不是改这里。
"""

import logging

from deepagents import FilesystemPermission, create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend, StateBackend
from langgraph.checkpoint.memory import InMemorySaver

from app import tools as tool_pkg
from app.agent import main_agent
from app.agent.llm import build_llm
from app.config import Settings
from app.mcp.loader import load_mcp_tools
from app.subagents import discover_subagents

logger = logging.getLogger(__name__)


def _build_backend(settings: Settings) -> CompositeBackend:
    # 默认文件系统为会话内的虚拟文件（智能体的草稿区），/skills/ 映射到本地 skills 目录
    return CompositeBackend(
        default=StateBackend(),
        routes={"/skills/": FilesystemBackend(root_dir=settings.skills_dir, virtual_mode=True)},
    )


async def build_agent(settings: Settings):
    tool_pkg.autodiscover()
    await load_mcp_tools(settings.mcp_config_file)

    subagents = discover_subagents()
    logger.info("已加载子智能体: %s", [s.name for s in subagents])

    agent = create_deep_agent(
        model=build_llm(settings),
        tools=tool_pkg.get_tools(main_agent.TOOLS),
        system_prompt=main_agent.SYSTEM_PROMPT,
        subagents=[s.to_deepagents() for s in subagents],
        skills=[f"/skills/{s}/" for s in main_agent.SKILLS],
        backend=_build_backend(settings),
        permissions=[FilesystemPermission(operations=["write"], paths=["/skills/**"], mode="deny")],
        checkpointer=InMemorySaver(),  # 多轮会话记忆；生产环境换成 Redis/Postgres checkpointer
        name="complaint-agent",
    )
    return agent, subagents
