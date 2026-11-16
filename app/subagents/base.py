from dataclasses import dataclass, field

from deepagents import SubAgent

from app.tools import get_tools


@dataclass(frozen=True)
class SubAgentSpec:
    """子智能体声明。工具按名字引用（本地工具 / MCP 工具均可），构建时再解析。"""

    name: str
    description: str  # 主智能体据此决定是否委派，务必写清楚适用场景
    system_prompt: str
    tools: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)  # skills/ 下的子目录名，如 ["billing"]
    model: str | None = None  # 为空则继承主智能体模型
    enabled: bool = True

    def to_deepagents(self) -> SubAgent:
        spec: SubAgent = {
            "name": self.name,
            "description": self.description,
            "system_prompt": self.system_prompt,
            "tools": get_tools(self.tools),
        }
        if self.skills:
            spec["skills"] = [f"/skills/{s}/" for s in self.skills]
        if self.model:
            spec["model"] = self.model
        return spec
