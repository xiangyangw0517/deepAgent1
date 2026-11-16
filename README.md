# 移动投诉智能体（Deep Agents + FastAPI）

基于 [Deep Agents](https://docs.langchain.com/oss/python/deepagents) 的投诉受理骨架：主智能体调度，子智能体专责处理，工具 / skills / MCP 均可插拔扩展。

## 架构

```
客户端
  │  POST /api/chat  或  /api/chat/stream
  ▼
FastAPI (app/api)
  │
  ▼
create_deep_agent (app/agent/factory.py)  ← 只负责组装，不放业务
  ├── 主智能体声明      app/agent/main_agent.py
  ├── 本地工具注册表    app/tools/          (@register_tool 自动发现)
  ├── MCP 工具          config/mcp_servers.json → app/mcp/loader.py
  ├── 子智能体          app/subagents/      (暴露 SUBAGENT 自动发现)
  └── Skills            skills/<域>/<skill>/SKILL.md
```

### 运行时流程

1. 用户诉求进入主智能体（投诉受理调度员）
2. 周报/月报：主智能体直接调用 `generate_dify_report`（Dify blocking，return_direct 原样输出）
3. 其他投诉/分析：按 `skills/common` 分类，通过 `task` 委派子智能体
4. 主智能体汇总结论，按安抚话术回复（当前未对接建单/账务/网管）

当前子智能体：`analytics-agent`、`ticket-agent`。

## 快速开始

```bash
cd deepAgent1
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 填入 LLM_API_KEY 等

source .venv/bin/activate
uvicorn app.main:app --reload --port 9001
```

浏览器打开 [http://localhost:9001](http://localhost:9001)：左侧数据看板，右侧 AI 对话（SSE 流式）。

手机效果演示（底部 Tab：看板 / 对话 / 我的）：[http://localhost:9001/m/](http://localhost:9001/m/)

### 离线依赖 / Docker

统一入口：[`offline/setup.sh`](offline/setup.sh)；`docker-compose.yml` **默认纯离线**（`OFFLINE=1`、`pull_policy: never`、构建 `network: none`）。

```bash
# 有网机器准备产物
./offline/setup.sh                      # Linux amd64 wheels → offline/wheels/
./offline/setup.sh --with-docker-image  # 导出基础镜像 tar
# 拷到离线机后：
./offline/setup.sh load-image
docker compose up -d --build            # 不访问公网；需本地已有 slim 镜像 + wheels
# 临时在线构建才用：OFFLINE=0 docker compose up -d --build
```

| 接口 | 说明 |
|------|------|
| `GET /` | 前端控制台（看板 + 对话） |
| `GET /api/health` | 健康检查 |
| `GET /api/capabilities` | 已加载工具 / 子智能体 |
| `GET /api/dashboard/stats` | 看板 KPI（演示数据）+ 子智能体 / 工具数 |
| `GET /api/dashboard/tickets` | 最近演示工单列表（仅看板展示） |
| `POST /api/chat` | 同步对话（`session_id` + `message`） |
| `POST /api/chat/stream` | SSE 流式（token / tool_call / tool_result / done） |

示例：

```bash
curl -s http://localhost:9001/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"u1","message":"我是13800000000，这个月莫名其妙多扣了视频彩铃的钱"}'
```

## 如何扩展（约定优于配置）

### 1. 加本地工具

在 `app/tools/` 新建模块，用装饰器注册即可，无需改 factory：

```python
from app.tools.registry import register_tool

@register_tool
def query_xxx(phone: str) -> dict:
    """工具说明会出现在模型侧。"""
    ...
```

在子智能体 / 主智能体的 `tools=[...]` 里按**名字**引用。

### 2. 加子智能体

在 `app/subagents/` 新建文件，导出 `SUBAGENT`：

```python
from app.subagents.base import SubAgentSpec

SUBAGENT = SubAgentSpec(
    name="service-agent",
    description="主智能体据此决定是否委派，写清适用场景",
    system_prompt="...",
    tools=["scheme_db_query"],
    skills=["service"],   # 可选，对应 skills/service/
)
```

### 3. 加 Skill

```
skills/
  <域>/                 # 如 common、billing、knowledge
    <skill-name>/
      SKILL.md          # frontmatter: name + description
```

主智能体在 `app/agent/main_agent.py` 的 `SKILLS` 里声明域目录名；子智能体在 `SubAgentSpec.skills` 里声明。

已内置 `skills/knowledge/dify-kb-search`（Dify 知识库检索）。配套工具 `search_dify_kb`，配置见 `.env` 的 `DIFY_*`。

已内置业务库分析：子智能体 `analytics-agent`（`skills/analytics` + `scheme_db_*`）。配置见 `.env` 的 `SCHEME_DB_*`。

已内置周报/月报：主智能体工具 `generate_dify_report`（`return_direct`，配置 `DIFY_REPORT_*`）。不经子智能体，避免大报告被模型二次复述。

### 4. 加 MCP 能力

编辑 `config/mcp_servers.json`，将对应服务 `enabled` 设为 `true`。启动时加载，工具名带服务前缀（如 `crm_query_order`），再在子智能体 `tools` 列表中引用即可。

## 目录一览

```
app/
  main.py                 # FastAPI 入口 + lifespan 组装 agent
  config.py               # 环境变量
  agent/                  # LLM、主智能体声明、factory 组装
  api/                    # 路由与 schema
  tools/                  # 本地工具（自动发现）
  subagents/              # 子智能体（自动发现）
  mcp/                    # MCP 加载
config/mcp_servers.json
skills/                   # 领域知识 skills
```

后续可补：真实 BOSS/CRM 对接、持久化 checkpointer、鉴权、更多业务子智能体。
