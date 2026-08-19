---
id: daily-report-stage-context-loop
type: execution_plan
status: approved
created_at: 2026-08-19
updated_at: 2026-08-19
sources:
  - user-approved daily report stage-local context loop direction in current turn
  - src/lib/daily-report/service.ts
  - src/lib/ai/provider.ts
  - src/lib/daily-report/planning.ts
related:
  - docs/plans/daily-report-write-repair-hardening-execution-plan.md
base_commit: 770cf7097c7f5d5956636c194bc1407b876aa7c9
---

# 日报三阶段阶段内上下文 Loop 执行计划

## Implementation Goal

将日报生成中的 AI 交互收敛为三个阶段：ASSESS、PLAN、WRITE。每个阶段拥有独立的上下文会话，并在阶段内部执行：

```text
AI 初次输出 → 代码解析/校验 → 结构化反馈 → 同一上下文修正
```

只有出现不可修复错误、上下文超限或达到阶段内修复次数上限时，才对当前阶段启动一次全新的完整重试。阶段之间不共享对话历史，只传递经过代码确认的结构化结果。

完成标准：

1. ASSESS、PLAN、WRITE 都具备统一的阶段会话和阶段内修复 loop。
2. PLAN_VALIDATE、WRITE retry、REPAIR 不再作为独立 AI 上下文；它们分别成为 PLAN/WRITE 内部校验与修复轮次。
3. 同一阶段的修复请求使用真实 assistant/user 多轮消息，不重复拼接完整输入。
4. 上下文超限、不可修复错误和超修复次数会触发一次干净的阶段完整重试；重试仍失败才终止任务。
5. checkpoint、任务时间线、AI 调用统计和任务监控恢复入口反映新的三阶段语义。
6. 保留现有 Topic/Candidate/Block 关系、代码校验、候选快照、模板签名和输入 hash 的安全边界。

## Scope Boundaries

- 阶段上下文只在单个 ASSESS batch、PLAN 或 WRITE 内共享；ASSESS、PLAN、WRITE 之间不共享消息历史。
- ASSESS 仍按现有 batch 规模拆分；每个 batch 是一个独立阶段会话。
- 不把完整文章正文引入 PLAN；不把完整候选集引入 WRITE；继续使用现有 compact candidate/brief/topic 输入。
- 不使用服务端 conversation ID 作为必要依赖；会话由应用层消息列表维护，兼容现有 OpenAI-compatible Chat Completions 接口。
- 不允许模型通过修复反馈修改 Topic、Candidate、Block 的关系；关系和 source 映射仍由代码负责。
- 不放宽本地结构校验、required note 校验、模板签名校验、输入快照校验或 Pipeline 版本校验。
- 不新增数据库表或 Prisma schema；checkpoint 继续使用现有 JSON 字段并增加可向后兼容的阶段 loop 数据。
- 不在本次改造中让三个阶段共用一个超大上下文，也不引入跨日报任务的上下文缓存。
- 不修改非日报 AI 流程。

## Shared Contracts

### Stage session

阶段会话至少包含：

- `stage`: `assess | plan | write`
- `attempt`: 当前干净阶段尝试次数
- `repairRound`: 当前上下文修复轮次
- `messages`: 当前会话消息，或可重建消息所需的受控 transcript
- `inputHash`: 阶段初始输入 hash
- `lastOutput`: 最近一次原始模型输出或其受控持久化表示
- `lastViolations`: 最近一次本地校验反馈
- `contextTokenEstimate` / `contextOverflow`: 上下文预算审计字段

正常成功后不长期保留完整 messages；阶段失败、任务取消或需要人工从阶段恢复时，checkpoint 只保留恢复所需的受控 transcript 和摘要。

### Validation feedback

统一使用内部反馈 envelope，不开放给用户配置：

```json
{
  "type": "VALIDATION_FEEDBACK",
  "stage": "PLAN",
  "violations": [
    {
      "code": "duplicate_candidate",
      "candidateIds": [18],
      "message": "候选 18 被多个主题选择"
    }
  ],
  "instruction": "只修正上述问题，返回完整的当前阶段结果。"
}
```

反馈只包含定位问题所需的结构化信息；不重复发送当前上下文中已经存在的完整输入、草稿或候选事实。

## Implementation Units

| ID | Unit | Description | Actor | Risk |
|---|---|---|---|---|
| U1 | Stage loop contract | 在 Provider/日报类型中定义阶段会话、阶段输出、校验反馈、loop 结果和审计结构 | Local lead | High |
| U2 | Conversation transport | 将现有一次性 completion 和 JSON parse retry 改为可追加 assistant/user 消息的阶段会话；保留 provider fallback 和 transient retry | Local lead | High |
| U3 | ASSESS loop | 每个 ASSESS batch 使用独立上下文，完成解析、字段校验、反馈修正和一次干净阶段重试 | Local lead | High |
| U4 | PLAN loop | 合并 PLAN/PLAN_VALIDATE，复用同一上下文完成 plan 校验反馈与修正；保留代码排序和超限截取审计 | Local lead | High |
| U5 | WRITE loop | 合并 WRITE retry/REPAIR，复用同一上下文完成草稿校验、完整草稿修正、notes 修正和一次干净阶段重试 | Local lead | High |
| U6 | Checkpoint/recovery/timeline | 记录阶段 loop 状态、修复次数、完整重试、上下文超限；恢复入口收敛为 ALL/ASSESS/PLAN/WRITE | Local lead | High |
| U7 | Regression coverage | 覆盖同上下文消息序列、可修复反馈、不可修复干净重试、上下文超限、三阶段隔离和旧 checkpoint 兼容 | Local lead | High |
| U8 | Runtime verification | 类型、lint、日报相关测试、构建、Compose 重建和运行态 smoke check | Local lead | Medium |

## Node Contracts

### U1–U2: Shared stage-loop contract and transport

- Contract linkage: `plan_id=daily-report-stage-context-loop`, `base_commit=770cf7097c7f5d5956636c194bc1407b876aa7c9`, `acceptance_ids=A1,A2,A3`
- Required capabilities: TypeScript API contract design, OpenAI-compatible chat message handling, JSON parsing and error classification
- Required skills: `change-impact-analysis`, `implement-plan`
- Write ownership: `src/lib/ai/provider.ts`, `src/lib/daily-report/types.ts`, shared AI helper files, related unit tests
- Forbidden writes: database schema, non-daily-report Provider methods, production configuration
- Verification: focused Provider/session tests; `npx tsc --noEmit`
- Evidence required: passed test output, changed file list, no non-daily Provider contract regressions
- Handoff readiness: a stage session can append prior assistant output and validation feedback without rebuilding the initial prompt

### U3: ASSESS loop

- Contract linkage: `plan_id=daily-report-stage-context-loop`, `base_commit=770cf7097c7f5d5956636c194bc1407b876aa7c9`, `acceptance_ids=A4,A5`
- Required capabilities: candidate assessment validation, batch checkpoint semantics, context budget handling
- Required skills: `implement-plan`
- Write ownership: `src/lib/daily-report/service.ts`, `src/lib/daily-report/planning.ts`, ASSESS tests
- Forbidden writes: PLAN/WRITE prompt semantics except shared contract changes required by U1–U2
- Verification: ASSESS batch success, same-context repair, batch isolation and context-overflow fallback tests
- Evidence required: message arrays prove initial input is not duplicated and each batch has independent session state
- Handoff readiness: all assessment batches produce validated assessments or a terminal checkpoint with retry metadata

### U4: PLAN loop

- Contract linkage: `plan_id=daily-report-stage-context-loop`, `base_commit=770cf7097c7f5d5956636c194bc1407b876aa7c9`, `acceptance_ids=A6,A7`
- Required capabilities: plan normalization, topic/candidate invariants, max-item truncation audit
- Required skills: `implement-plan`
- Write ownership: `src/lib/daily-report/service.ts`, `src/lib/daily-report/planning.ts`, PLAN/provider tests
- Forbidden writes: changing candidate eligibility rules or Topic/Candidate/Block semantics
- Verification: valid plan no extra call; repairable violation uses same messages; unrepairable violation creates exactly one clean retry; `topicPriority` audit remains intact
- Evidence required: call log with context IDs/message counts and checkpoint planning audit
- Handoff readiness: valid PLAN output is materialized once and can be consumed by WRITE without PLAN conversation history

### U5: WRITE loop

- Contract linkage: `plan_id=daily-report-stage-context-loop`, `base_commit=770cf7097c7f5d5956636c194bc1407b876aa7c9`, `acceptance_ids=A8,A9,A10`
- Required capabilities: draft validation, notes requirements, source relation materialization, safe optional-topic omission
- Required skills: `implement-plan`
- Write ownership: `src/lib/daily-report/service.ts`, `src/lib/daily-report/planning.ts`, WRITE/provider tests
- Forbidden writes: source relation changes by model, new independent REPAIR AI stage, weakening required-note checks
- Verification: complete draft success; structural and notes violations corrected in same WRITE context; context overflow and repair-limit fallback; final mapping invariants
- Evidence required: raw assistant output + structured feedback sequence in test fixture, final draft validation pass
- Handoff readiness: WRITE returns a validated model draft or a terminal checkpoint that can be resumed from WRITE

### U6: Checkpoint/recovery/timeline

- Contract linkage: `plan_id=daily-report-stage-context-loop`, `base_commit=770cf7097c7f5d5956636c194bc1407b876aa7c9`, `acceptance_ids=A11,A12`
- Required capabilities: backward-compatible checkpoint parsing, task monitor API/UI and timeline audit
- Required skills: `implement-plan`
- Write ownership: `src/lib/tasks/types.ts`, `src/lib/tasks/checkpoint.ts`, `src/lib/tasks/service.ts`, `src/lib/daily-report/timeline.ts`, retrigger route, task monitor UI/tests
- Forbidden writes: schema migration, non-daily task retry semantics, production data
- Verification: old checkpoint parse; manual recovery options only ALL/ASSESS/PLAN/WRITE; failed WRITE loop resumes safely; timeline shows internal repair/full retry metrics under owning stage
- Evidence required: service and component test output, serialized checkpoint fixture
- Handoff readiness: no UI/API exposes REPAIR as an independent AI recovery stage

### U7–U8: Verification and runtime

- Contract linkage: `plan_id=daily-report-stage-context-loop`, `base_commit=770cf7097c7f5d5956636c194bc1407b876aa7c9`, `acceptance_ids=A1-A12`
- Required capabilities: regression test selection, Docker Compose runtime verification
- Required skills: `implement-plan`
- Write ownership: tests and plan evidence only; no new production behavior outside U1–U6
- Forbidden writes: production database, deployment configuration, unrelated test cleanup
- Verification: focused tests, `npx tsc --noEmit`, `npm run lint`, `npm run build`, `git diff --check`, `docker compose up -d --build`, `docker compose ps`, local HTTP 200
- Evidence required: command exit codes, test counts, Compose service status and smoke response
- Handoff readiness: implementation is ready for `prepare-commit`; no production deployment is included in this plan

## Acceptance Criteria

- A1: 三个阶段都有独立上下文；ASSESS、PLAN、WRITE 之间不复用 messages。
- A2: 同阶段修正请求包含上一轮 assistant 输出和结构化 validation feedback，而不是新建单轮请求。
- A3: 初始阶段输入在修正轮次中不被重复拼接，反馈不重复携带完整草稿或候选事实。
- A4: ASSESS 每个 batch 独立 loop，单 batch 失败不会污染其他 batch。
- A5: ASSESS 可修复错误在当前 batch 上下文内修正；上下文超限只对该 batch 触发一次干净重试。
- A6: PLAN_VALIDATE 不再触发独立上下文，PLAN 校验反馈在 PLAN loop 内完成。
- A7: PLAN 的代码排序、topicPriority、最大条数截取和审计结果保持不变。
- A8: WRITE 结构错误和 required note 缺失统一在 WRITE loop 内修正，模型始终返回完整日报草稿。
- A9: WRITE 不允许模型修改 Topic/Candidate/Block 关系，sourceIds 继续由代码构建。
- A10: 修复轮次耗尽或不可修复时，当前阶段最多进行一次干净完整重试，仍失败才终止。
- A11: checkpoint、timeline、AI usage 记录 repair rounds/full retries/context overflow，任务监控恢复只提供全部、ASSESS、PLAN、WRITE。
- A12: 旧 checkpoint 无 loop 字段时仍可安全解析；输入 hash、模板签名、Pipeline 版本变化时仍拒绝阶段恢复。

## Implementation DAG

| Unit | Depends On | Why |
|---|---|---|
| U1 | None | 先固定阶段会话和反馈协议，避免 Provider 与 Service 各自定义重试语义 |
| U2 | U1 | Service 需要底层真实多轮消息会话 |
| U3 | U1,U2 | ASSESS 依赖通用 loop 和 batch checkpoint |
| U4 | U1,U2 | PLAN 依赖通用 loop和已有 plan validator |
| U5 | U1,U2 | WRITE 依赖通用 loop和 draft validator |
| U6 | U3,U4,U5 | checkpoint、恢复和时间线必须反映三个阶段的最终语义 |
| U7 | U1-U6 | 测试覆盖完整链路和兼容边界 |
| U8 | U7 | 运行态验证基于通过的代码回归 |

Critical path: U1 → U2 → U3/U4/U5 → U6 → U7 → U8

Risk-first nodes: U1, U2, U5

Shared-write nodes: U1, U2, U3, U4, U5, U6；全部由 Local lead 在同一 worktree 串行执行。

## Execution Sequence

1. 先增加阶段会话和反馈协议的 characterization tests，确认旧 Provider 调用协议仍可工作。
2. 实现 Provider 多轮消息会话和上下文预算/错误分类；验证消息序列和旧非日报 AI 方法。
3. 迁移 ASSESS batch loop；验证 batch 隔离、修复和干净重试。
4. 迁移 PLAN loop；删除独立 PLAN_VALIDATE AI 语义，保留代码排序、截取和审计。
5. 迁移 WRITE loop；删除独立 REPAIR AI 语义，统一返回完整草稿并保留安全剔除。
6. 更新 checkpoint、恢复接口、任务时间线和监控 UI；移除“从 REPAIR 继续”。
7. 运行相关测试、类型/lint/build、全量可行回归和本地 Compose smoke check。
8. 汇总 diff，交给 `prepare-commit`，不在本计划内提交或生产部署。

## Actor Parallelization Plan

Recommendation: serial shared writer。

Reasoning:

- Provider interface、日报 Service、checkpoint 和 timeline 共享同一阶段语义，存在高耦合。
- 并行修改会导致消息协议、attempt 计数和恢复语义冲突。
- 可以在实现前做只读分析，但代码实现和测试集成必须由一个 writer 按 DAG 顺序完成。

- Impact decision: `serial_shared_writer`
- Worktree required: no；当前工作区已有用户未提交改动，继续在同一 worktree 串行修改并保留这些改动。

## Verification Plan

### Node-level

- U1/U2: `npx vitest run tests/unit/ai-provider.daily-report-stages.test.ts tests/unit/daily-report-stage-session.test.ts`
- U3: ASSESS batch loop tests and `tests/integration/daily-report-service.test.ts`
- U4: PLAN loop tests and planning audit assertions
- U5: WRITE/validation/repair tests and source mapping assertions
- U6: `npx vitest run tests/integration/background-task-service.test.ts tests/components/task-monitor-panel.test.tsx`

### Integration

- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- `git diff --check`
- `docker compose up -d --build`
- `docker compose ps`
- `curl -fsS -o /tmp/infinitum-local-root.html -w '%{http_code}\n' http://localhost:3001/`

### Acceptance evidence

- Test spy proves a repair call sends `[system, user initial, assistant previous output, user validation feedback]` for the same stage session.
- Test spy proves ASSESS batch 2 does not receive ASSESS batch 1 messages.
- Test proves a context-overflow error starts exactly one clean full retry and then terminates if it fails again.
- Checkpoint fixture proves old JSON parses and new loop metadata round-trips.
- Timeline/task monitor fixture proves only ASSESS/PLAN/WRITE recovery choices are exposed.

## Open Questions and Risks

- Prompt-cache hit rate depends on the configured OpenAI-compatible provider; the implementation should preserve stable prefixes but must not treat cache hits as a correctness requirement.
- A WRITE output can be large enough that appending the previous assistant output plus feedback exceeds the context window. The loop must estimate/guard before appending and fall back to a clean retry.
- Persisting full messages in checkpoint can increase task-row size. Keep full transcript only for active failed/cancelled stage recovery and clear it on success; store compact audit fields for completed stages.
- Existing manual recovery currently exposes REPAIR. U6 must migrate this to WRITE without breaking older checkpoints containing `resumeFrom: repair`; old values should be interpreted as WRITE recovery or rejected with a clear fallback to full retry, never silently execute an unknown stage.
- Provider transport retries for transient network/circuit-breaker errors remain separate from semantic repair rounds and must not append duplicate assistant messages.

## Plan Deviations

None at plan approval time.

## Remote Handoff Inputs

No remote or parallel actor is recommended. The change is intentionally serial because the Provider,日报 Service, checkpoint and task monitor contracts share one writer boundary.
