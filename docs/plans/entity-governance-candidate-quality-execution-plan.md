---
id: entity-governance-candidate-quality
type: execution_plan
status: completed
created_at: 2026-08-17
updated_at: 2026-09-05
sources:
  - src/lib/entities/similarity.ts
  - src/lib/entities/service.ts
  - src/lib/admin/actionable-monitor.ts
  - src/components/admin/entity-settings-panel.tsx
  - production candidate audit from v0.2.1-rc4
related: []
base_commit: 874c89cfe3799e9969621e3c18c7a86ace71ec43
---

# 实体治理候选质量优化执行计划

## Implementation Goal

将实体治理建议从“关键词重叠候选”收敛为“同一实体候选”：保留中英文/括号/词序/格式变体，排除产品与公司、事件与公司、关系短语等包含或共现误报；取消低使用量真实别名的默认硬过滤，并保持自动合并门槛不降低。

第一阶段不引入模型或 schema 字段，使用现有 `reason`、`confidence`、`affectedItemCount` 和 `sharedItemCount` 完成可解释规则优化。

## Acceptance Criteria

- AC-1: `token_overlap` 不再默认生成实体合并候选；严格子集/包含关系不进入默认治理建议。
- AC-2: `singular_match` 遇到“与/和/及/、/vs/”等关系连接词时不再判为同一实体。
- AC-3: `sharedItemCount` 不再提升实体相似度；同文共现只作为谨慎提示。
- AC-4: 默认治理列表不再要求 `affectedItemCount >= 3`，真实低频别名可以按置信度优先展示。
- AC-5: 生产样本中 DeepSeek、Qwen Image、SSI、ICE、AISI 等格式/别名变体可进入人工候选；Apple Watch→苹果、Anthropic IPO→Anthropic、ChatGPT 与 Gemini 等不进入默认候选。
- AC-6: 自动合并阈值保持 `0.98`，不因本次优化扩大自动合并范围。
- AC-7: 实体 API、预计算、监控、Admin 组件相关测试通过，TypeScript 检查通过。
- AC-8: 旧版本持久化的 `token_overlap` 候选不会出现在默认治理列表，即使尚未执行预计算。
- AC-9: 自动合并执行前使用当前算法刷新候选，并且只处理允许自动合并的严格格式匹配候选。

## Implementation DAG

| Unit | Depends On | Scope | Verification |
|---|---|---|---|
| U1 | — | 收紧相似度规则和共现加分逻辑 | entity similarity unit tests |
| U2 | U1 | 调整候选预计算/列表过滤/提示文案 | admin entities integration tests |
| U3 | U2 | 补充生产样本回归和 UI/监控契约 | focused integration/component tests |
| U4 | U3 | 集成验证和 diff 检查 | `tsc`, lint, focused tests |

Critical path: U1 → U2 → U3 → U4

## Write Ownership

Allowed paths:

- `src/lib/entities/similarity.ts`
- `src/lib/entities/service.ts`
- `tests/unit/entity-similarity.test.ts`
- `tests/integration/admin-entities-api.test.ts`
- `tests/integration/actionable-monitor.test.ts`
- `tests/components/entity-settings-panel.test.tsx`
- `docs/plans/entity-governance-candidate-quality-execution-plan.md`

Forbidden writes:

- Existing unrelated dirty files: `src/lib/clusters/decisions.ts`, `tests/integration/admin-cluster-api.test.ts`, `docs/plans/cluster-review-orphan-fix-execution-plan.md`
- Prisma schema, SQLite setup, migrations, production database, entity merge endpoints, ingestion and feed paths

## Execution Sequence

1. Add characterization tests for same-entity aliases, relation phrases, subset overlap, edit-distance candidates, and co-occurrence scoring.
2. Change similarity classification: keep exact/ordered-token/edit candidates, reject relation markers and token-subset overlap from merge suggestions, remove co-occurrence boost.
3. Remove the default affected-item hard filter from the suggestion list and retain impact as a secondary sort signal; keep auto-merge at `0.98`.
4. Add compatibility filtering for persisted legacy candidates and refresh/allowlist guards for automatic merge.
5. Update reasons/UI-facing messaging and monitor behavior only as required by the existing response contract.
6. Run focused tests, TypeScript, lint, and inspect the final diff for scope.

## Rollout and Residual Risk

- Existing persisted candidates are replaced by the next Admin refresh or scheduled precompute; the API and auto-merge path also guard against legacy candidates before that refresh.
- The first phase intentionally avoids schema changes. If the resulting review pool still needs explicit tiers or audit scores, add `candidateClass`, `priorityScore`, and `riskFlagsJson` in a later migration-backed phase.
- Automatic merge remains conservative and is not made reachable by lowering the confidence threshold.
