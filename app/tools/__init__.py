"""本包下所有模块会被自动导入，模块内用 `@register_tool` 注册即可生效。"""

import importlib
import pkgutil

from app.tools.registry import get_tool, get_tools, list_tools, register_external_tools, register_tool


def autodiscover() -> None:
    for mod in pkgutil.iter_modules(__path__):
        if mod.name != "registry":
            importlib.import_module(f"{__name__}.{mod.name}")


__all__ = [
    "autodiscover",
    "get_tool",
    "get_tools",
    "list_tools",
    "register_external_tools",
    "register_tool",
]
