# dify-kb-search — Dify 知识库检索技能包（OpenClaw / Claude Skills 兼容）

把自建 Dify 知识库的 RAG 检索能力封装为通用技能包。`SKILL.md` 采用 Claude Skills / OpenClaw 标准格式（frontmatter `name` + `description`），并在技能目录内置零依赖检索脚本，**不依赖 DSH、不依赖 MCP、不依赖任何第三方库**，模型只需运行 `python3` 即可检索知识库。

## 目录结构

```
dify-kb-search/
├── SKILL.md              # 技能定义（OpenClaw 加载 SKILL.md 即识别该技能）
├── scripts/
│   └── search_dify.py    # 零依赖检索脚本（仅 Python 3 标准库）
├── .env.example          # 配置模板（复制为 .env 填写）
└── README.md
```

## 安装到 OpenClaw

1. 把整个 `dify-kb-search/` 目录放到技能目录：
   - 全局：`~/.openclaw/skills/dify-kb-search/`（对所有项目生效）
   - 或项目级：`<项目>/.openclaw/skills/dify-kb-search/`
2. 配置凭证：`cp .env.example .env`，填入你 Dify 实例的真实值：
   ```ini
   DIFY_BASE_URL=http://localhost/v1          # 自建 Dify API 基址
   DIFY_API_KEY=dataset-xxxx                  # 知识库 API 密钥
   DIFY_DATASET_ID=843c57e1-...               # 数据集 UUID
   ```
   也可以用环境变量 `DIFY_BASE_URL` / `DIFY_API_KEY` / `DIFY_DATASET_ID` 代替 .env。
3. 验证：`python3 scripts/search_dify.py "测试查询"` 应返回知识库分段内容。

> 凭证提示：本机 DSH 配置 `~/.dsh/profiles/web/cordis.patch.yml` 的 `dify` 行里已有一份可用的 baseUrl/apiKey/datasetId，可直接抄用。

## 在其他 Claude Skills 兼容宿主中使用

凡是支持 Claude Skills 格式的宿主（Claude Code、各类 skill 加载器），把 `dify-kb-search/` 目录放入其 skills 目录即可。宿主模型会读取 `SKILL.md` 获取指令，并运行 `scripts/search_dify.py` 完成检索。

## 手动调用示例

```bash
python3 scripts/search_dify.py "各市州 重复投诉率 及时率 最新月报"
python3 scripts/search_dify.py "长沙 投诉 工单量" --top-k 4 --score 0.5
python3 scripts/search_dify.py "全文检索示例" --search-method full_text_search
```

参数：`--top-k` 返回条数（默认 4）、`--search-method`（semantic/full_text/hybrid，默认 hybrid）、`--no-rerank` 关闭重排序、`--score` 相关性阈值（默认 0.5）。

## 设计要点（对应 DSH 版 dify-qa 的调优经验）

- **单次调用**：每个问题只检索一次，默认 top_k=4 + 混合检索 + 重排序 + 单段 4000 字符，一次拿回前 4 条最相关片段（含完整表格）。
- **日期收敛**：同指标召回多日期数据时，默认只输出【日期最新】的一份；仅当用户明确指定日期或多日期对比时才输出多份——最少 token、最快响应。
- **正确率 vs 速度**：正确率靠「查询词一次组合完整」（时间/城市/指标全带上）保证，而不是靠多次检索或更大 top_k；单次调用（约 0.1s）+ 收敛输出 = 响应最快。
- 脚本内置 HTTP 超时（30s）与明确的错误输出，输出格式含得分与来源文档名，便于模型判断权威性。
- API key 仅从 .env / 环境变量读取，绝不打进脚本或输出。