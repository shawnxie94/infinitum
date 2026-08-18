---
id: infinitum-daily-report-prompt-contract-optimization
type: execution_plan
status: approved
created_at: 2026-08-18
updated_at: 2026-08-18
sources:
  - user-request:daily-report-prompt-contract-optimization
related:
  - docs/plans/daily-report-selection-writing-separation-execution-plan.md
base_commit: 63be0ebcf2cd511e7e9e90b551281f2daff98d48
---

# 日报模型提示词与阶段契约优化执行计划

## 目标

在不破坏 `topic -> section -> write` 约束的前提下，缩短日报流水线的模型输入输出：

- ASSESS 输出收敛为 `candidateId`、`isWorthReading`、`relevanceScore`、`suggestedBlockKey`。
- ASSESS batch checkpoint 继续保留全部候选的四字段结果，用于覆盖校验和断点恢复；PLAN 不再接收 `isWorthReading=false` 的 assessment 明细。
- 为可读 topic 生成有大小上限的 `topicBrief`，将摘要、事件、日期、来源和排序信号补给 PLAN，不恢复旧版长 `evidenceSummary/eventHint` 输出。
- PLAN 保留栏目规划所需的 `schemaVersion`、`sections[].blockKey/topicIds/candidateIds`，删除标题、排除列表、解释性字段。
- 为 ASSESS、PLAN、WRITE、REPAIR 补充精确而紧凑的输入字段说明、优先级和字段来源边界。
- 同步类型、校验、checkpoint 续跑和测试。

## 实施 DAG

| Unit | Depends On | Scope | Verification |
|---|---|---|---|
| U1 | - | 锁定阶段字段消费关系与兼容边界 | 类型/调用点检查 |
| U2 | U1 | 更新 ASSESS/PLAN 类型、可读 assessment ledger、topicBrief、提示词、输入字段说明和校验 | 定向 unit tests |
| U3 | U2 | 更新服务 checkpoint、PLAN_VALIDATE、WRITE/REPAIR 关联契约，保持全量 assessment 恢复数据 | 定向 integration tests |
| U4 | U3 | 审查脏工作树范围并运行最终检查 | `vitest`、`tsc`、`lint`、`git diff --check` |

关键路径：U1 → U2 → U3 → U4。共享写入由当前主执行者串行完成；不启动并行写入。

## 变更边界

允许修改：

- `src/lib/daily-report/types.ts`
- `src/lib/daily-report/planning.ts`
- `src/lib/daily-report/service.ts`
- `src/lib/daily-report/persistence.ts`
- `src/lib/ai/provider.ts`
- 日报相关 unit/integration tests
- 本执行计划文件

禁止顺带修改：生产配置、数据库 schema、无关 ingestion/cluster 改动、部署文件。

## 验收标准

1. ASSESS 模型输出只要求四个字段，旧的 `eventHint`、`evidenceSummary`、`exclusionReason`、`confidence` 不再进入新 checkpoint/ledger。
2. PLAN 输出只包含 `schemaVersion` 和 section 的 `blockKey/topicIds/candidateIds`，本地校验继续阻止未知 Block、未知 topic、候选归属错误、重复分配和栏目数量越界。
3. PLAN 仍能看到 section-level Block 定义；WRITE 仍能看到完整 Block 定义和正文规则。
4. PLAN 只接收可读 assessment 和可读 topic 的 bounded brief；brief 至少覆盖摘要片段、candidateScore、relevanceScore、来源/条目数、日期和 follow-up 信号。
5. 各阶段输入提示词对候选、assessment、topicBrief、topic、plan、draft、violation 的字段语义有紧凑说明，不残留旧的一次性日报流程或要求模型生成旧字段。
6. 旧的失败/续跑 checkpoint 遇到新契约时不会静默误用；输入 hash/pipeline version 能阻止不兼容的 checkpoint 继续执行。
7. 日报相关定向测试、类型检查、lint 和 diff 检查通过。

## 风险与处理

- 现有未提交改动涉及 `src/lib/ai/provider.ts` 和 `src/config/prompts.ts`，实现时只保留与本任务相关的日报 prompt 区域，不能覆盖其余用户改动。
- 旧 checkpoint 可能包含完整 assessment；新 pipeline 版本或输入 hash 变化后应按现有 mismatch 逻辑重新生成，而不是把旧字段当作新 DTO。
- `suggestedBlockKey` 是 PLAN 的软提示，不替代本地 Block 合法性和数量校验。
- PLAN brief 只使用本地候选 DTO 的截断内容和排序信号；不把原文、URL 或完整证据送入 PLAN。所有 brief 都必须有总大小上限，超限时优先保留标题、事件字段和排序信号。
