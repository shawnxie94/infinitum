---
id: daily-report-write-repair-hardening
type: execution_plan
status: completed
created_at: 2026-08-18
updated_at: 2026-09-05
sources:
  - user-approved daily report WRITE/REPAIR hardening direction in current turn
related:
  - docs/plans/daily-report-prompt-config-convergence-execution-plan.md
base_commit: 5511377f9455d646cd8aa0d530d9bb6f1d288f98
---

> 历史方案说明：当前实现已由 [日报三阶段阶段内上下文 Loop 执行计划](./daily-report-stage-context-loop-execution-plan.md) 取代。本文中的独立 REPAIR、PLAN_VALIDATE 和旧恢复选项仅保留用于说明演进背景，不代表当前运行协议。

# 日报 WRITE/REPAIR 健壮性优化执行计划

## Implementation Goal

修复日报生成中“模型正文缺少栏目必填要点、结构性 WRITE 错误阻断可修复问题、失败任务恢复过于刚性”的问题。WRITE 阶段按主题接收必填要点清单，出现结构性校验错误时带结构化反馈完整重试一次；REPAIR 阶段接收受影响主题的事实输入并只返回可合并的 notes 补丁。任务监控允许用户在有效 checkpoint 范围内选择全部重试或从指定阶段继续。代码负责合并和重新校验，保持 Topic/Candidate/Block 关系不变。对可选栏目增加不满足要求条目的安全剔除与审计能力，不凭空补造事实。

## Scope Boundaries

- 不改变 Topic 1 ── * Candidate、Candidate 1 ── 1 Topic 的映射规则。
- 不允许 WRITE/REPAIR 修改 Topic、Candidate、Block 的关联关系。
- 不修改数据库 schema、生产配置、默认提示词的用户可配置字段语义。
- 不放宽 required note 校验；只有代码合并合法补丁或安全剔除可选栏目条目。
- 不新增独立 LLM 阶段；结构性错误只允许额外完整重试一次 WRITE，REPAIR 仍为现有 notes 补丁阶段。
- 不允许人工恢复跳过输入快照、模板签名或 Pipeline 版本校验；每个恢复起始阶段必须按代码规则清除其后的 checkpoint 产物。
- “从校验继续”不作为独立恢复选项；结构性校验问题推荐从 WRITE 继续，notes 缺失问题推荐从 REPAIR 继续。

## Implementation Units

| ID | Unit | Description | Actor | Risk |
|---|---|---|---|---|
| U1 | Repair contract | 增加主题级必填要点、结构化违规字段与 notes patch 类型/解析协议 | Local lead | High |
| U2 | Prompt inputs | WRITE/WRITE 重试/REPAIR 增加 requiredNotes、结构化违规反馈与受影响候选事实，收紧输出说明 | Local lead | High |
| U3 | Retry and patch flow | 结构性错误最多重试一次 WRITE；可修复 notes 违规走 patch 合并，保持正文、映射、栏目和顺序不变 | Local lead | High |
| U4 | Safe fallback | 可选栏目在修复仍失败时剔除不合格条目并记录审计，必填栏目继续失败 | Local lead | Medium |
| U5 | Regression tests | 覆盖混合违规触发 WRITE 重试、notes patch、修复失败剔除和映射不变性 | Local lead | High |
| U6 | Integration verification | 运行日报测试、类型/lint/build 与本地 Compose 真实日报回归 | Local lead | High |
| U7 | Manual recovery | 任务监控统一显示“重新生成”并弹窗选择全部重试或合法阶段继续；后端按起始阶段重置 checkpoint 并记录审计 | Local lead | High |

## Implementation DAG

| Unit | Depends On | Why |
|---|---|---|
| U1 | None | 下游 prompt、服务和测试共享新类型/违规协议 |
| U2 | U1 | Provider 需要使用统一的 repair context 与 patch contract |
| U3 | U1, U2 | 服务重试与合并逻辑必须匹配 provider 返回协议 |
| U4 | U3 | 只有补丁合并和二次校验完成后才能安全剔除条目 |
| U5 | U1, U2, U3, U4 | 测试需要覆盖完整新链路 |
| U6 | U5 | 运行态回归必须基于已通过的代码回归 |
| U7 | U3, U5 | 人工恢复依赖稳定的阶段 checkpoint、重试契约和回归覆盖 |

Critical path: U1 -> U2 -> U3 -> U4 -> U5 -> U6

Shared-write strategy: serial shared writer in the current worktree. Provider、服务、类型和测试存在强耦合，不并行写入。

## Execution Sequence

1. 定义 notes patch、结构化 violation 与 repair context；先运行类型和相关单测确认契约可编译。
2. 修改 WRITE/REPAIR provider 输入输出协议，补充每个 selected topic 的 requiredNotes 和候选事实。
3. 在日报 service 中实现结构性 WRITE 重试、patch 合并、二次校验和可选栏目安全剔除；更新 checkpoint/audit 记录。
4. 增加回归测试，覆盖模型遗漏 required note、补丁成功、补丁失败与候选映射保持不变。
5. 运行相关测试、全量测试/lint/typecheck/build，并重新通过本地 Compose 触发一次真实日报。
6. 扩展任务监控重试接口和弹窗，验证全部重试、从 PLAN/WRITE/REPAIR 继续及非法 checkpoint 拒绝。

## Verification Plan

- `npx vitest run tests/unit/ai-provider.daily-report-stages.test.ts tests/unit/daily-report-planning.test.ts tests/integration/daily-report-service.test.ts`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- `git diff --check`
- `docker compose up -d --build`
- 通过本地管理接口触发一次日报，确认任务至少完成 ASSESS、PLAN、WRITE、校验/修复和持久化路径；如模型仍产生不可修复内容，确认可选栏目剔除与审计结果符合预期。

## Acceptance Criteria

1. WRITE 输入能逐主题看到 required note 的 label/instruction，并能看到对应候选事实；结构性校验失败时重试输入包含结构化违规反馈。
2. REPAIR 输入包含违规主题的候选事实，且 REPAIR 只返回 notes patch，不返回完整日报草稿。
3. 代码合并 patch 后保留原有 headline、body、Block 顺序、Topic 顺序和 Topic/Candidate 映射。
4. required note 仍按 label 原样匹配且 text 非空校验。
5. 可选栏目中修复失败的条目可在满足最小条数时被安全剔除，并写入 task audit/checkpoint；必填栏目不静默发布。
6. 本次真实失败场景中，结构性错误会触发一次完整 WRITE 重试；重试后剩余的 notes 缺失可通过 patch 修复，或按安全策略被剔除，不再因混合违规直接跳过修复。
7. 失败日报任务统一显示“重新生成”；用户可选择“全部重试”或系统允许的阶段继续，恢复后保留阶段前结果并清除后续失效产物。
8. 选择“从 WRITE 继续”时复用 PLAN；选择“从 REPAIR 继续”时复用合法草稿；输入快照、模板签名或 Pipeline 版本变化时拒绝恢复并要求全部重试。

## Plan Deviations

- 如果当前公开的 `DailyReportViolation` 结构不足以承载 itemIndex/noteLabel，将增加可选字段，不改变已有错误码和历史 checkpoint 的读取兼容性。
- 如果现有任务状态不支持“部分完成”而直接扩展状态会扩大范围，则先记录 `omittedItems` 审计并保持任务失败，避免未经确认改变发布语义。

## Remote Handoff Inputs

本任务不建议并行或远程委派。所有实现单元共享 provider/service/types/test 契约，由当前本地 lead 串行完成。
