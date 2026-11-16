"""子智能体自动发现：本包下每个模块暴露一个 `SUBAGENT: SubAgentSpec` 即自动注册。"""

import importlib
import pkgutil

from app.subagents.base import SubAgentSpec


def discover_subagents() -> list[SubAgentSpec]:
    specs: list[SubAgentSpec] = []
    for mod in pkgutil.iter_modules(__path__):
        if mod.name == "base":
            continue
        module = importlib.import_module(f"{__name__}.{mod.name}")
        spec = getattr(module, "SUBAGENT", None)
        if isinstance(spec, SubAgentSpec) and spec.enabled:
            specs.append(spec)

    names = [s.name for s in specs]
    if len(names) != len(set(names)):
        raise ValueError(f"子智能体名称重复: {names}")
    return specs


__all__ = ["SubAgentSpec", "discover_subagents"]
