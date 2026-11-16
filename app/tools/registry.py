"""工具注册表。

所有本地工具通过 `@register_tool` 注册，MCP 工具在启动时通过 `register_external_tools` 注册。
主智能体、子智能体都按名字从这里取工具，互不耦合。
"""

from collections.abc import Iterable

from langchain_core.tools import BaseTool, tool

_TOOLS: dict[str, BaseTool] = {}


def register_tool(func=None, **tool_kwargs):
    """装饰器：把函数包装成 LangChain Tool 并注册。

    用法：
        @register_tool
        def scheme_db_ping() -> dict: ...
    """

    def decorator(f):
        t = f if isinstance(f, BaseTool) else tool(f, **tool_kwargs)
        if t.name in _TOOLS:
            raise ValueError(f"工具名重复: {t.name}")
        _TOOLS[t.name] = t
        return t

    return decorator(func) if func is not None else decorator


def register_external_tools(tools: Iterable[BaseTool]) -> None:
    for t in tools:
        _TOOLS[t.name] = t


def get_tool(name: str) -> BaseTool:
    try:
        return _TOOLS[name]
    except KeyError as e:
        raise KeyError(f"未注册的工具: {name}，已注册: {sorted(_TOOLS)}") from e


def get_tools(names: Iterable[str]) -> list[BaseTool]:
    return [get_tool(n) for n in names]


def list_tools() -> dict[str, str]:
    return {name: t.description for name, t in _TOOLS.items()}
