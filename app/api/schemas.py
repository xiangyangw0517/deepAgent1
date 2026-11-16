from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    session_id: str = Field(..., description="会话 ID，同一 ID 共享多轮上下文")
    message: str = Field(..., min_length=1)


class ChatResponse(BaseModel):
    session_id: str
    reply: str


class Capabilities(BaseModel):
    tools: dict[str, str]
    subagents: dict[str, str]


class TicketItem(BaseModel):
    ticket_id: str
    phone: str
    category: str
    summary: str
    urgency: str
    status: str
    created_at: str


class DashboardStats(BaseModel):
    total: int = 0
    today: int = 0
    processing: int = 0
    closed: int = 0
    urgent: int = 0
    by_category: dict[str, int] = Field(default_factory=dict)
    by_status: dict[str, int] = Field(default_factory=dict)
    by_urgency: dict[str, int] = Field(default_factory=dict)
    subagents: dict[str, str] = Field(default_factory=dict)
    tools_count: int = 0
