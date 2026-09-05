---
id: infinitum-cluster-review-orphan-fix
type: execution_plan
status: completed
created_at: 2026-08-17
updated_at: 2026-09-05
sources:
  - production diagnosis from 2026-08-17
related:
  - src/lib/clusters/decisions.ts
  - src/lib/clusters/service.ts
  - src/lib/ai/provider.ts
  - src/config/prompts.ts
  - src/config/constants.ts
  - src/lib/clusters/helpers.ts
  - tests/integration/admin-cluster-api.test.ts
  - tests/integration/cluster-assignment.test.ts
  - tests/unit/ai-provider.test.ts
base_commit: 874c89c
---

# 聚合待定覆盖、孤儿决策与 ambiguous 协议执行计划

## Implementation Goal

修复生产中“聚合待定数量非零、弹窗列表为空”的数据流不一致，并让聚合合并具备真实的灰区复核语义：受影响聚合不能被普通扫描上限截断；左右聚合已删除的历史 decision 不进入待定队列；AI 对每个候选 Pair 返回明确的 `approved`、`declined` 或 `ambiguous`。

完成标准：

- 有效候选仍按现有 API DTO、排序、分页和操作行为返回。
- 任一侧聚合已删除的 decision 不计入 `total`，也不进入 `candidates`。
- 受影响 `liveClusterIds` 全量纳入扫描，普通近期聚合仍受现有扫描上限保护。
- AI 新协议逐对返回 `approved`、`declined`、`ambiguous`；漏返回的 Pair 写入 `failed`，不静默降级为 `declined`。
- 补充孤儿 decision、混合有效/无效记录、dirty-first、AI ambiguous 和协议兼容回归测试。
- 不改 Prisma schema、SQLite snapshot、前端 API 协议或生产数据；保留旧 AI merge groups 兼容回退。

## Implementation Units

| ID | Unit | Description | Actor | Risk |
|---|---|---|---|---|
| U1 | 有效候选查询 | 将聚合存在性过滤前置到查询/分页，并让 total 与 candidates 同源 | Local lead | Medium |
| U2 | dirty-first 扫描 | 将受影响聚合从普通 1000 条扫描池中解耦，全量补入候选池 | Local lead | Medium |
| U3 | AI 判定协议 | 新增逐对 verdict 解析与 ambiguous 传递，保留旧 merge groups 回退 | Local lead | Medium |
| U4 | 决策落库与执行 | 保存 AI verdict/reason/confidence；仅 approved 执行合并，failed 可重试 | Local lead | High |
| U5 | 回归测试 | 覆盖孤儿、dirty-first、ambiguous、漏返回和旧协议兼容 | Local lead | Medium |
| U6 | 验证 | 运行聚合单测/集成测试、类型、lint 和 diff 检查 | Local lead | Low |

## Implementation DAG

| Unit | Depends On | Why |
|---|---|---|
| U1 | None | 先修复后端数据契约 |
| U2 | U1 | 扩展扫描范围但不改变普通池上限 |
| U3 | None | AI provider 与 Prompt 是独立协议边界 |
| U4 | U3 | 服务层消费新 verdict 并保持执行安全 |
| U5 | U1, U2, U3, U4 | 测试锁定完整链路 |
| U6 | U1, U2, U3, U4, U5 | 对最终实现做验证 |

Critical path: U1 -> U2; U3 -> U4; (U1, U2, U3, U4) -> U5 -> U6

Shared-write nodes: U1, U2, U3, U4 and U5 are serial because they touch the same cluster merge contract and runtime path.

## Execution Sequence

1. 在 `listClusterReviewCandidates` 中按有效聚合关系过滤 decision，再应用排序、分页和 total。
2. 将 `liveClusterIds` 作为强制纳入集合与普通近期扫描池合并去重。
3. 为 AI provider 增加逐对决策解析，Prompt 明确要求完整返回每个输入 Pair。
4. 服务层优先消费新决策；approved 形成合并组，ambiguous/declined/failed 分别落库。
5. 扩展聚合 API、聚合执行和 AI provider 测试。
6. 运行聚合相关单测/集成测试，再运行 `npx tsc --noEmit`、`npm run lint` 和 `git diff --check`。

## Scope and Exclusions

- Allowed writes: `src/lib/clusters/decisions.ts`, `src/lib/clusters/service.ts`, `src/lib/ai/provider.ts`, `src/config/prompts.ts`, `src/config/constants.ts`, `src/lib/clusters/helpers.ts`, `tests/integration/admin-cluster-api.test.ts`, `tests/integration/cluster-assignment.test.ts`, `tests/unit/ai-provider.test.ts`, this plan artifact.
- Forbidden writes: `prisma/schema.prisma`, `scripts/setup-sqlite.mjs`, production database, deployment config, unrelated UI.
- Production cleanup is a separate controlled operation after the code fix and backup readiness确认；本计划不执行。

## Phase 2: Prompt protocol convergence

基于本地运行验证发现，代码默认的 `cluster_merge` Prompt 已切换到 `decisions` 协议，但数据库中已有的默认 Prompt 仍可能保留 `approvedPairs`。本阶段补齐运行时配置迁移和收敛约束：

- 对精确匹配已知旧版内容的默认 `cluster_merge` Prompt 做幂等自动迁移；不覆盖管理员自定义内容。
- 新建或修改的 `cluster_merge` Prompt 禁止继续声明旧的 `approvedPairs`、`pairs` 或 `mergeGroups` 输出协议。
- 保留旧输出解析与 Provider fallback 作为临时兼容，并通过 `legacy_*` reason code 观察使用量。
- 聚合任务时间线增加 `旧协议Pair` 计数，区分新协议调用和兼容路径。
- 不新增 schema 字段；迁移以旧版 Prompt 精确匹配为边界，避免引入运行时版本字段。

Additional allowed writes:

- `src/lib/settings/core.ts`
- `tests/integration/admin-settings-service.test.ts`
- `tests/unit/ai-provider.test.ts`
- `tests/integration/admin-settings-api.test.ts`

Phase 2 acceptance:

- 本地已有旧版默认 `cluster_merge` Prompt 时，读取运行时配置会自动替换为新版 `decisions` Prompt。
- 管理员自定义的旧内容不被自动覆盖，但新保存的旧协议 Prompt 会被拒绝。
- 新协议和旧协议兼容测试均通过；legacy 输出仍可被识别并转成 decision ledger。

## Verification Plan

- Existing valid candidate test remains green.
- Orphan decisions are excluded from both `candidates` and `total`.
- When invalid decisions precede valid decisions, page 1 still returns the requested number of valid candidates and correct total.
- Explicit live cluster IDs are included even when outside the ordinary scan limit.
- New AI decision JSON persists `ambiguous` and its reason; omitted pairs persist as `failed`.
- Legacy `approvedPairs` AI responses remain executable during compatibility rollout.
- TypeScript, lint, and diff checks pass.
