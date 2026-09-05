---
id: daily-report-reviewer-context-usage
type: execution_plan
status: completed
created_at: 2026-08-20
updated_at: 2026-09-05
sources:
  - user-approved Proposer-Reviewer + context usage design in current turn
related:
  - docs/plans/daily-report-write-repair-hardening-execution-plan.md
  - docs/plans/daily-report-stage-context-loop-execution-plan.md
base_commit: f3fc14c05ff5f3f7d176b5989c2184cdc0febe9e
---

# 日报 Proposer-Reviewer + 全 AI 任务上下文用量统计执行计划

## Implementation Goal

实现两项能力：

1. **日报最终审核（REVIEW）阶段**：在最终确定性校验通过后增加独立模型 Reviewer，对生成结果做规则层面（事实一致性、主题独立性、覆盖充分性、去重、凑数检测）审核；结构化 reject 按 violation 映射到 PLAN 或 WRITE，并最多触发一次中间阶段重试。重试后仍 reject，或 Reviewer 调用不可用/输出不可解析时，允许生成“未评审通过”的日报草稿并持久化，但**不执行自动发布**。
2. **全 AI 任务上下文消耗统计**：所有 AI 任务（抓取/摘要/聚合/日报等）记录每次模型调用的输入/输出/总 token，随任务持久化并展示在任务详情，供后续评估优化。

## Scope Boundaries

- 不改变 Topic/Candidate/Block 映射规则与现有确定性校验职责；REVIEW 只做“结构校验通过但语义不合格”的审核与定向重试。
- REVIEW 重试固定为一次（不新增配置项）；Reviewer 模型、Review 阶段开关、用户自定义提示词通过 `daily_report_review` 提示词配置管理。禁用的 Review 配置仍需以 `enabled=false` 被 runtime 读取，不能因缺少启用配置阻断其他 AI 任务。
- 用户自定义 Review 提示词只作为 user message 的“审核补充指令”；审核输入由代码单独注入，不要求用户维护 `reviewContextJson` 占位符。内部 system prompt、JSON 合同、violation 枚举、禁止改写日报和安全发布规则固定由应用维护，不可被覆盖。
- Reviewer 输入不能只有 `selectedTopics`；必须同时接收代码生成的候选池统计、压缩后的未选高价值候选和 `candidateCoverage`/`planningAudit`，并记录候选输入截断数量。
- 数量上下限、候选 ID、来源映射、重复 identity 和候选覆盖硬规则由代码判断；Reviewer 只判断需要语义判断的事实一致性、主题独立性、内容重复和凑数风险。
- Reviewer 不拥有重试阶段控制权。代码按 violation code 映射 PLAN 或 WRITE；首次 Review 后最多一次 PLAN/WRITE 重试，重试后必须再次 REVIEW，不能递归重试。
- Review `rejected` 与 `unavailable` 都保存 draft、任务标记为 `partial`、禁止自动发布；`passed` 才允许在原有 `dailyReportAutoPublish` 开启时自动发布。Review disabled 保持现有行为。
- 任务与 checkpoint 必须记录 `reviewStatus`、Review violation、重试阶段和候选池审计。新增 Review 阶段后升级 Pipeline 版本，并把 Review 配置签名纳入日报 generation signature。
- 不新增日报状态枚举，复用现有 `draft` 状态；已有 published 报告重新生成时沿用现有 regenerate-to-draft 语义，Review 失败不会把未审核正文留在 published 状态。
- 上下文用量只扩展 `aiCallBreakdownJson` 条目字段，不新增数据库表/列；旧数据缺失 token 字段保持读取兼容。新数据必须标记 token 来源（provider 实际值或字符估算值）。
- Review 使用独立的 `daily_report_review` 用量 breakdown key，不能与普通 `daily_report` 调用混合。
- 不引入并发执行；所有改动由本地主代理串行完成。

## Implementation Units

| ID | Unit | Description | Actor | Risk |
|---|---|---|---|---|
| U1 | AI 用量采集契约 | provider 在每次底层模型调用返回后截获 `response.usage`（缺省按字符估算），新增 `AiProviderOptions.onUsage`、`AiCallUsage` 和 retry/fallback 元数据；区分 provider/estimated | Local lead | Medium |
| U2 | 任务用量追踪与持久化 | `createTaskAiUsageTracker.addUsage` + breakdown token 字段与 `daily_report_review` key；tasks/types 与 tasks/service 序列化兼容 | Local lead | Medium |
| U3 | 全调用点接入 | daily-report / ingestion / clusters / items / processing-recovery 创建 provider 时传入 `onUsage`；覆盖 transient retry、JSON retry、fallback 的每次调用 | Local lead | Medium |
| U4 | 任务详情展示 | 任务卡片 AI Calls 增加 token 汇总；详情弹窗按 key 展示输入/输出/总 tokens，并标记实际/估算 | Local lead | Low |
| U5 | Review 提示词配置 | `PromptConfigType` 新增 `daily_report_review`；默认 prompt、settings 类型/种子/runtime 可选加载、SQLite 升级、Admin 开关/独立模型/用户提示词 | Local lead | High |
| U6 | Reviewer 合同与 Provider | `DailyReportReviewInput/Result`、violation code、候选池 review context、`AiProvider.reviewDailyReport`、内部提示词 + 用户提示词合并、JSON 解析 | Local lead | High |
| U7 | 候选池审计 | 复用并扩展 `buildDailyReportCandidateCoverage`/`planningAudit`，生成候选统计、按栏目计数、top 未选候选和截断审计 | Local lead | High |
| U8 | 日报 REVIEW 状态机与发布闸门 | REVIEW 节点、reject→PLAN/WRITE 一次重试、二次 Review、reviewStatus/checkpoint/timeline/recovery、draft fallback、禁止自动发布 | Local lead | High |
| U9 | 任务详情与用量展示 | 更新任务 monitor、metrics/parser 和 `daily_report_review` breakdown 展示 | Local lead | Medium |
| U10 | 测试与验证 | Review disabled/pass/reject/unavailable、PLAN/WRITE 重试、候选池丰富度、已有 published 报告、逐次 token、旧 breakdown/checkpoint、tsc/lint/schema/build 回归 | Local lead | High |

## Review Contract

### Input

Reviewer 至少接收：

- `draft`：经过确定性校验和 source mapping 的最终日报草稿；
- `selectedTopics`：主题、候选和栏目关系；
- `candidatePool`：原始候选数、ASSESS 后可规划候选数、历史过滤数、按栏目计数、top 未选候选；
- `selectionAudit`：`candidateCoverage`、`planningAudit`、已选数量、按栏目已选数量、候选输入截断数；
- 模板中的栏目规则、日报日期和 Review 用户提示词。

候选数量、栏目上下限、candidate ID、source mapping、重复 identity 等硬规则由代码先行判断；模型不负责替代这些规则。

### Output

```json
{
  "verdict": "pass | reject",
  "violations": [
    {
      "code": "coverage_insufficient",
      "severity": "error | warning",
      "message": "...",
      "topicIds": ["topic-1"],
      "candidateIds": [18],
      "evidence": "...",
      "guidance": "下一次 PLAN 或 WRITE 重试应重点修复什么"
    }
  ],
  "summary": "..."
}
```

内部 system prompt 必须显式给出上述 JSON Schema、violation code 含义、evidence 和 guidance 要求以及 pass/reject 的 error 级约束；用户补充指令不得承担协议说明职责。代码负责再次校验 verdict、violation code、topic/candidate ID、evidence、guidance 和字段范围；Reviewer 不能返回日报正文，也不能修改 Topic/Candidate/Block 关系。

推荐的 retry 映射：

| Violation | Retry |
|---|---|
| `coverage_insufficient` / `candidate_omitted` / `topic_not_independent` | PLAN，然后重新 WRITE |
| `factual_inconsistency` / `duplicated_content` | WRITE |
| `padding_content` | PLAN，然后重新 WRITE |
| Reviewer API 失败、超时、非法 JSON | 不重跑内容阶段，保存 `unavailable` draft |

## Implementation DAG

| Unit | Depends On | Why |
|---|---|---|
| U1 | None | 用量类型与逐次截获是全部用量链路的契约基础 |
| U2 | U1 | 追踪器需要消费 provider 上报的 usage |
| U3 | U1, U2 | 各任务调用点需要追踪器与 provider 回调 |
| U4 | U2, U3 | 展示依赖已持久化的 breakdown token 字段 |
| U5 | None | Review 配置独立于用量链路 |
| U6 | U5 | Reviewer provider 需要读取 `daily_report_review` 配置 |
| U7 | None | Review 输入依赖现有候选、覆盖和规划审计，可先固定代码合同 |
| U8 | U5, U6, U7 | 服务集成需要配置、Provider 和候选池审计合同 |
| U9 | U2, U3, U8 | 展示依赖用量 key 和 Review 阶段数据 |
| U10 | U1..U9 | 回归覆盖完整新链路 |

Critical path: U1 -> U2 -> U3 -> U4；U5 -> U6/U7 -> U8 -> U9；U10 收口
Risk-first nodes: U5（schema/配置面）、U6（Provider 合同）、U8（管线状态机/发布闸门）
Shared-write nodes: U1/U6（同改 provider.ts）、U8（service.ts/timeline.ts/types.ts/persistence/recovery）——串行单写

## Execution Sequence

1. U1：provider 用量截获契约（每次底层请求、CompletionResponse.usage、AiCallUsage、onUsage、估算来源、retry/fallback 元数据），跑 tsc + 既有 provider 单测。
2. U2：ai-usage/tasks 类型与持久化扩展，补 ai-usage 单测。
3. U3：逐个接入默认运行路径的 provider 创建点和 task tracker，跑各任务相关测试子集 + tsc。
4. U4：任务卡片与详情弹窗展示 token，跑组件相关构建/单测。
5. U5：Review 提示词配置全链路（schema enum + setup-sqlite + seed + optional runtime + admin UI），跑 schema/SQLite/settings 测试。
6. U6：Reviewer 输入输出合同、内部规则 + 用户提示词、Provider 方法和解析，跑 Provider/Review 单测。
7. U7：候选池统计、top 未选候选和截断审计，跑 `tests/unit/daily-report.test.ts` / planning 单测。
8. U8：service Review 状态机（reject→PLAN/WRITE 一次重试、二次 Review、draft fallback、publish gate）、timeline/checkpoint/recovery/persistence，跑日报集成测试。
9. U9：更新任务详情、metrics/parser 和所有 token breakdown 测试。
10. U10：运行推荐测试子集、全量测试（可行时）、lint、tsc、build、git diff --check，并进行本地运行态日报 smoke。

## Verification Plan

- U1/U2/U6：`npx vitest run tests/unit/ai-provider.daily-report-stages.test.ts tests/unit/ai-usage.test.ts`（新增逐次 usage/retry/review tests）
- U3：`npx tsc --noEmit` + `npx vitest run tests/integration/daily-report-service.test.ts tests/integration/ingestion-service.test.ts tests/integration/item-regeneration.test.ts tests/integration/background-task-service.test.ts`
- U4/U9：`npx vitest run tests/components/task-monitor-panel.test.tsx tests/integration/background-task-service.test.ts tests/integration/ingestion-metrics-service.test.ts`
- U5：`npm run schema:generate && npx vitest run tests/integration/sqlite-setup.test.ts` + settings 相关单测
- U7：`npx vitest run tests/unit/daily-report.test.ts tests/unit/daily-report-planning.test.ts`
- U8：`npx vitest run tests/integration/daily-report-service.test.ts tests/unit/daily-report-recovery.test.ts`
- U10：`npm test`（全量，会重置 test DB）与/或 `npm run lint`、`npx tsc --noEmit`、`npm run build`、`git diff --check`

## Acceptance Criteria

- Review 配置可在 Admin 选择独立模型、开关 REVIEW 阶段、编辑用户自定义提示词；关闭后日报管线行为与现状一致，runtime 不因 disabled Review 缺少可用配置而失败。
- Reviewer 输入包含最终 draft、selectedTopics、候选池统计、压缩后的未选高价值候选、candidateCoverage、planningAudit 和截断审计。
- REVIEW 首轮结构化 reject 按 violation code 自动重试一次 PLAN 或 WRITE；重试后再次 REVIEW，最多两次 Review 调用且不递归重试。
- Review reject 或 unavailable 时持久化 draft、任务以 partial 结束、`reviewStatus` 可追踪且不自动发布；Review pass 才能进入原有自动发布逻辑。
- 已有 published 日报重新生成时沿用既有 draft transition；Review 失败不会自动发布，且已有回归测试覆盖该行为。
- 任务详情可见 `daily_report_review` 独立 breakdown，以及每个 key 的输入/输出/总 tokens 和实际/估算来源。
- 每次底层模型请求（包括 JSON retry、transient retry、fallback）都被统计；旧 breakdown/checkpoint 可读取。
- 全量测试、lint、tsc、build 通过；工作树只包含本计划范围内的改动。

## Plan Deviations

已落地的实现细化：每条 violation 增加必填的 `guidance`，用于下一次 PLAN/WRITE 重试；`padding_content` 与候选取舍有关，映射到 PLAN 后重新 WRITE。Review 调用本身仍按 Provider 的 transient/JSON retry 规则重试，逻辑阶段最多执行两次。

## Remote Handoff Inputs

本批次不委派远程执行：U1-U10 强耦合 provider/service/types/tests，统一由本地主代理串行实施，实施完成后按 prepare-commit 收口。
