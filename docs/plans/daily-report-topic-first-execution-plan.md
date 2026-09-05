---
id: infinitum-daily-report-topic-first
type: execution_plan
status: completed
created_at: 2026-08-18
updated_at: 2026-09-05
sources:
  - user-request:daily-report-topic-first
related:
  - docs/plans/daily-report-prompt-contract-optimization-execution-plan.md
  - docs/trd/daily-report-selection-writing-separation.md
base_commit: 699805f
---

# 日报 Topic-first 执行计划

## 目标

让最终日报条目以日报主题为唯一内容单位：上游聚合只提供事件候选和来源证据，ASSESS 过滤不值得阅读的候选，PLAN 负责归纳最终主题、选择主题和分配栏目，代码负责校验并物化候选关系，WRITE 为每个主题生成一个日报条目。

## 实施范围

- 移除日报阶段基于 `clusterId`、事件字段和 `sourceKey` 的语义分组；保留候选的上游聚合信息作为 PLAN 输入信号。
- PLAN 输入改为 ASSESS 通过的完整候选 brief；不再向模型提供规则生成的 `topicBriefs`。
- PLAN 输出改为按主题分组的 `blockKey + topics[].candidateIds`，不再要求模型同时维护 `topicIds` 与 `candidateIds`。
- 本地校验 PLAN 的主题分组、候选引用、主题唯一性、栏目边界和栏目数量；代码为合法主题生成运行内 `topicId`。
- PLAN_VALIDATE 在 WRITE 前完成候选唯一归属校验；失败时将结构化 violation 反馈给 PLAN 定向修复，不把映射问题推迟到 WRITE。
- PLAN_VALIDATE 在本地按统一 topicPriority 对 Topic 排序，按模板 Block 顺序重排，并在超过 maxItems 时直接截取低优先级 Topic，避免为简单数量超限额外调用 LLM。
- WRITE 接收已物化的选中主题包和对应 Block 规则，但只生成标题、正文和 notes；不输出 `sourceIds` 或修改 Topic-Candidate 映射。
- WRITE 草稿由代码按模板 Block 顺序和 PLAN Topic 顺序归一化，模型返回顺序不作为最终展示顺序。
- 代码根据合法 Topic-Candidate 映射为草稿补齐 `sourceIds`；同一 Topic 只属于一个 Block，避免日报内容跨栏目重复聚焦同一主题。
- WRITE 候选输入只保留标题、摘要、事件、时间、follow-up 和有限证据字段，移除排序、聚合和内部持久化字段。
- 重写 ASSESS、PLAN、WRITE、REPAIR 提示词，只描述当前阶段契约和输入字段，不保留旧流程说明。
- `topicPriority` 的公式版本、分项得分、保留主题和 `maxItems` 截取结果写入 checkpoint，并同步写入任务时间线审计。
- 分离 `DailyReportModelDraft` 与最终 `DailyReportDraft`；模型不负责 `sourceIds`，代码在映射校验后补齐最终来源关系。
- 不修改上游 cluster 聚合、数据库 schema、公开日报内容结构和历史日报数据。

## 关键契约

PLAN 输出：

```json
{
  "schemaVersion": 2,
  "sections": [
    {
      "blockKey": "hot-topics",
      "topics": [
        { "candidateIds": [101, 108] }
      ]
    }
  ]
}
```

代码为每个主题生成 `topicId`，并将其与候选集合和唯一 Block 绑定。WRITE 输入中的每个主题包含 `topicId`、`blockKey`、候选集合和代表候选；模型只返回 `topicId`、标题、正文和 notes，最终 draft item 的 `sourceIds` 由代码从 Topic-Candidate 映射生成。

## 验收标准

1. PLAN 不接收规则生成的主题账本，不要求模型返回 `topicIds`。
2. PLAN 能看到所有 ASSESS 通过候选的受限标题、摘要、评分、事件、来源和时间信号。
3. 一个候选最多属于一个 PLAN 主题，一个主题只能被分配到一个栏目。
4. 一个选中主题最终生成一个唯一 Block 下的日报条目；草稿不能遗漏主题、跨栏目重复主题或为同一主题生成多个条目。
5. PLAN_VALIDATE 的候选重复归属会带结构化 violation 重试 PLAN，WRITE 不负责修复映射。
6. Block 按模板顺序展示；Topic 按统一 topicPriority 降序展示，priority 相同按最小 candidateId 稳定排序。
7. PLAN 超过 Block `maxItems` 时本地截取低优先级 Topic，不因此增加 LLM 调用；其余结构性问题仍走 PLAN_VALIDATE 修复。
8. WRITE 不返回 `sourceIds`；代码根据 Topic 映射补齐并校验来源关系。
9. PLAN、WRITE、REPAIR 提示词不出现旧的 `topicBriefs`、`topicIds + candidateIds`、规则预分组或一次性日报流程说明。
10. 日报定向单测、类型检查、lint 和构建通过。
