---
name: complaint-db-analysis
description: 基于业务 PostgreSQL 做投诉工单/方案库数据分析。当用户要统计投诉量、地市分布、重复投诉、超时、方案闭环、按时间聚合，或需要从工单库/方案库取数时使用。
---

# 投诉工单与方案库数据分析

通过只读工具查询业务库。**所有数字与时间范围必须来自当次查询结果，禁止编造或改写。**

## 硬性约束（必须遵守）

1. **禁止编造**：单量、占比、排名、时间区间一律以 `scheme_db_query` 返回为准；不得用「默认最近 30 天」「今年以来」等未实查口径。
2. **默认近一个月**：用户未指定时间时，按该表时间字段取**有数据的最近自然月**分析（先按月 `GROUP BY` 取 max 月）；开篇写明统计月份；并查上月做**环比**（增减与 %）。禁止用全表累计冒充「近一个月」。
3. **用户指定时间必须按字段过滤后重查**：禁止只改文案不重跑 SQL；指定某月时同样给出环比。
4. **表与时间字段对应**（不要串用）：
   - `chongtou_root_cause_detail` → **`"派单时间"`**（详见 chongtou-root-cause-analysis）
   - `complaint_work_order` → `"投诉受理时间"`（无派单时间则用此列，勿捏造）
   - `complaint_work_scheme_library` → `"方案建立时间"`
5. 查不到或报错如实说明，不要补假数。
6. **同粒度占比**：地市/原因占总量时，分子与分母同一 SQL、同一 WHERE；禁止用全表探针当分母。
7. **按月过滤**：优先 `substring(时间列 from 1 for 7) = 'YYYY-MM'`；半开区间右端用次月 1 日，禁止 `< 月末日`。
8. **输出前自检**：文案时段=SQL 过滤、占比可复算；对不上就重查，禁止改文案圆场。

先 `scheme_db_list_tables` / `scheme_db_describe_table` 确认字段，再 `scheme_db_query`。

## 可用表

| 逻辑名 | 物理表 | 用途 | 默认时间字段 |
|--------|--------|------|----------------|
| `complaint` | `complaint_work_order` | 投诉工单明细（量大） | `"投诉受理时间"` |
| `scheme` | `complaint_work_scheme_library` | 解决方案库 | `"方案建立时间"` |
| `chongtou` | `chongtou_root_cause_detail` | 三节点重投归因明细 | **`"派单时间"`**（见 chongtou-root-cause-analysis） |

## 常用字段（节选）

**工单 `complaint_work_order`**：`工单编号`、`投诉受理时间`、`投诉所在城市`、`受理地市`、`投诉标题`、`投诉描述`、`重复投诉次数`、`紧急程度`、`投诉业务类型`、`是否超时`、`超时天数`、`投诉原因一级分类`、`处理结果`、`归档时间`

**方案 `complaint_work_scheme_library`**：`方案编号`、`工单主题`、`所属地市`、`所属区县`、`问题描述`、`方案类型`、`方案建立时间`、`预计完成时间`、`是否超时`、`当前状态`、`关联工单数`、`客服回复口径`

## 查询规范

1. 只写 `SELECT` / `WITH ... SELECT`；中文列名必须双引号，例如 `"所属地市"`。
2. 每个分析问题尽量 **1～3 次查询** 拿齐聚合结果（含时间探针），避免拉全表明细。
3. 大表优先 `COUNT` / `GROUP BY`；需要明细时加时间或地市过滤，并依赖工具侧 `LIMIT`。
4. 文本时间列比较前：`NULLIF(btrim(列::text),'')::timestamp`；非法值跳过并在口径说明。
5. 不确定字段时先 `scheme_db_describe_table`，禁止猜测列名。

## 示例：时间探针 + 聚合

```sql
-- 1) 先看真实区间（以工单为例）
SELECT
  MIN(NULLIF(btrim("投诉受理时间"::text), '')::timestamp) AS min_t,
  MAX(NULLIF(btrim("投诉受理时间"::text), '')::timestamp) AS max_t,
  COUNT(*) AS n
FROM complaint_work_order;

-- 2) 再在真实或用户指定区间上聚合
SELECT "投诉所在城市", COUNT(*) AS cnt
FROM complaint_work_order
WHERE NULLIF(btrim("投诉受理时间"::text), '')::timestamp >= TIMESTAMP '2026-05-01'
  AND NULLIF(btrim("投诉受理时间"::text), '')::timestamp <  TIMESTAMP '2026-11-01'
GROUP BY 1
ORDER BY cnt DESC
LIMIT 20
```

（示例日期勿照抄；以探针或用户指定为准。）

```sql
SELECT "所属地市", COUNT(*) AS cnt
FROM complaint_work_scheme_library
WHERE "是否超时" = '是'
GROUP BY 1
ORDER BY cnt DESC
```

## 输出

- **一般问答（默认）**：约 200～300 字；须含统计月份、关键结论、**环比**、最多一张表 + 文末来源表。不要动辄「深度分析报告」分章长文。
- **深度分析 / 报告**：仅当用户明确要求时，再用 `###` 分节（整体 → 结构 → 可选要点，含环比）。
- **数据来源固定文末**：markdown 表两列「数据来源 | 时间维度」；不要罗列过滤明细。
- 查不到或报错如实说明，不要编造。
