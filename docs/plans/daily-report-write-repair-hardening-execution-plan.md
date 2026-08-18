---
id: daily-report-write-repair-hardening
type: execution_plan
status: approved
created_at: 2026-08-18
updated_at: 2026-08-18
sources:
  - user-approved daily report WRITE/REPAIR hardening direction in current turn
related:
  - docs/plans/daily-report-prompt-config-convergence-execution-plan.md
base_commit: 5511377f9455d646cd8aa0d530d9bb6f1d288f98
---

# 日报 WRITE/REPAIR 健壮性优化执行计划

## Implementation Goal

修复日报生成中“模型正文缺少栏目必填要点、单次完整草稿修复失败导致整任务失败”的问题。WRITE 阶段按主题接收必填要点清单，REPAIR 阶段接收受影响主题的事实输入并只返回可合并的 notes 补丁；代码负责合并、保持 Topic/Candidate/Block 关系不变并重新校验。对可选栏目增加不满足要求条目的安全剔除与审计能力，不凭空补造事实。

## Scope Boundaries

- 不改变 Topic 1 ── * Candidate、Candidate 1 ── 1 Topic 的映射规则。
- 不允许 WRITE/REPAIR 修改 Topic、Candidate、Block 的关联关系。
- 不修改数据库 schema、生产配置、默认提示词的用户可配置字段语义。
- 不放宽 required note 校验；只有代码合并合法补丁或安全剔除可选栏目条目。
- 不在本次引入新的 LLM 调用阶段；REPAIR 仍为现有阶段，但改为补丁协议。

## Implementation Units

| ID | Unit | Description | Actor | Risk |
|---|---|---|---|---|
| U1 | Repair contract | 增加主题级必填要点、结构化违规字段与 notes patch 类型/解析协议 | Local lead | High |
| U2 | Prompt inputs | WRITE/REPAIR 增加 requiredNotes 与受影响候选事实，收紧输出说明 | Local lead | High |
| U3 | Patch merge | 代码合并 REPAIR notes patch，保持正文、映射、栏目和顺序不变 | Local lead | High |
| U4 | Safe fallback | 可选栏目在修复仍失败时剔除不合格条目并记录审计，必填栏目继续失败 | Local lead | Medium |
| U5 | Regression tests | 覆盖缺失数据要点、补丁合并、修复失败剔除和映射不变性 | Local lead | High |
| U6 | Integration verification | 运行日报测试、类型/lint/build 与本地 Compose 真实日报回归 | Local lead | High |

## Implementation DAG

| Unit | Depends On | Why |
|---|---|---|
| U1 | None | 下游 prompt、服务和测试共享新类型/违规协议 |
| U2 | U1 | Provider 需要使用统一的 repair context 与 patch contract |
| U3 | U1, U2 | 服务合并逻辑必须匹配 provider 返回协议 |
| U4 | U3 | 只有补丁合并和二次校验完成后才能安全剔除条目 |
| U5 | U1, U2, U3, U4 | 测试需要覆盖完整新链路 |
| U6 | U5 | 运行态回归必须基于已通过的代码回归 |

Critical path: U1 -> U2 -> U3 -> U4 -> U5 -> U6

Shared-write strategy: serial shared writer in the current worktree. Provider、服务、类型和测试存在强耦合，不并行写入。

## Execution Sequence

1. 定义 notes patch、结构化 violation 与 repair context；先运行类型和相关单测确认契约可编译。
2. 修改 WRITE/REPAIR provider 输入输出协议，补充每个 selected topic 的 requiredNotes 和候选事实。
3. 在日报 service 中实现 patch 合并、二次校验和可选栏目安全剔除；更新 checkpoint/audit 记录。
4. 增加回归测试，覆盖模型遗漏 required note、补丁成功、补丁失败与候选映射保持不变。
5. 运行相关测试、全量测试/lint/typecheck/build，并重新通过本地 Compose 触发一次真实日报。

## Verification Plan

- `npx vitest run tests/unit/ai-provider.daily-report-stages.test.ts tests/unit/daily-report-planning.test.ts tests/integration/daily-report-service.test.ts`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- `git diff --check`
- `docker compose up -d --build`
- 通过本地管理接口触发一次日报，确认任务至少完成 ASSESS、PLAN、WRITE、校验/修复和持久化路径；如模型仍产生不可修复内容，确认可选栏目剔除与审计结果符合预期。

## Acceptance Criteria

1. WRITE 输入能逐主题看到 required note 的 label/instruction，并能看到对应候选事实。
2. REPAIR 输入包含违规主题的候选事实，且 REPAIR 只返回 notes patch，不返回完整日报草稿。
3. 代码合并 patch 后保留原有 headline、body、Block 顺序、Topic 顺序和 Topic/Candidate 映射。
4. required note 仍按 label 原样匹配且 text 非空校验。
5. 可选栏目中修复失败的条目可在满足最小条数时被安全剔除，并写入 task audit/checkpoint；必填栏目不静默发布。
6. 本次真实失败场景中，两个“数据与洞察”条目可通过 patch 修复，或按安全策略被剔除，不再因为完整草稿重写失败而直接丢失整份日报。

## Plan Deviations

- 如果当前公开的 `DailyReportViolation` 结构不足以承载 itemIndex/noteLabel，将增加可选字段，不改变已有错误码和历史 checkpoint 的读取兼容性。
- 如果现有任务状态不支持“部分完成”而直接扩展状态会扩大范围，则先记录 `omittedItems` 审计并保持任务失败，避免未经确认改变发布语义。

## Remote Handoff Inputs

本任务不建议并行或远程委派。所有实现单元共享 provider/service/types/test 契约，由当前本地 lead 串行完成。
