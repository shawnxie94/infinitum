---
id: infinitum-cluster-time-semantics-optimization
type: execution_plan
status: approved
created_at: 2026-08-20
updated_at: 2026-08-20
sources:
  - src/lib/ingestion/item-processor.ts
  - src/lib/clusters/helpers.ts
  - src/lib/clusters/identity.ts
  - src/lib/clusters/repository.ts
  - src/lib/clusters/service.ts
  - tests/integration/cluster-assignment.test.ts
  - tests/integration/ingestion-service.test.ts
related: []
base_commit: 664b4e48cda04b13d692a187aaa760252888b2a2
---

# Infinitum 聚类时间语义优化执行计划

## Implementation Goal

修复发布时间缺失时把抓取时间当作可信聚类时间窗的问题，并降低小幅 `eventDate` 漂移在本地规则中的硬阻断；保留现有 7 天已知发布时间窗口、重复事件隔离能力、人工 `cannot_link` 约束和 feed 时间过滤语义。

完成标准：

- `publishedAtKnown=false` 不再把 `publishedAt` 的抓取时回退值当作可信发布时间；候选召回改用 `createdAt` ±7 天，并继续让 `eventDate` 只作为匹配证据。
- `eventDate` 继续作为匹配证据；精确 fingerprint 的现有 bucket 先保留，避免唯一键碰撞和历史数据兼容风险。
- 两天以内的精确日期漂移不再被本地规则直接判为硬冲突，而是进入 AI 灰区。
- 补充缺失发布时间、eventDate 精确/粗粒度/缺失、日期小幅漂移的回归测试。
- 相关单元和集成测试通过，lint 通过。

## Implementation Units

| ID | Unit | Description | Actor | Risk |
|---|---|---|---|---|
| U1 | 时间召回契约 | 让候选范围区分可信发布时间和无可信发布时间；无发布时间时使用入库时间召回，保持已知发布时间行为不变 | Local lead | High |
| U2 | 日期证据软化 | 保留现有 event bucket 身份兼容；为聚类评分增加小幅精确日期漂移的软兼容路径 | Local lead | Medium |
| U3 | 回归测试 | 覆盖无发布时间、事件日期匹配、日期漂移和重复事件隔离 | Local lead | Medium |
| U4 | 集成验证 | 运行聚类/摄入相关测试与 lint，检查 dirty diff 和计划边界 | Local lead | Medium |

## Implementation DAG

| Unit | Depends On | Why |
|---|---|---|
| U1 | None | 先固定时间语义和候选查询契约 |
| U2 | U1 | 即时身份和候选召回必须使用一致的时间语义 |
| U3 | U1, U2 | 测试需要锁定新旧行为边界 |
| U4 | U3 | 最终验证依赖代码和回归测试完成 |

Critical path: U1 -> U2 -> U3 -> U4
Risk-first nodes: U1, U2
Shared-write nodes: U1, U2, U3

## Execution Sequence

1. 修改候选召回辅助函数，保持已知发布时间的现有行为。
2. 在聚类服务和仓储层接入 `publishedAtKnown` 的时间字段选择，并在聚类评分层软化小幅日期漂移。
3. 先运行聚类单元测试，再补并运行集成回归测试。
4. 运行摄入与聚类相关集成测试、lint，检查未触碰 schema/feed 查询约束。

## Actor Parallelization Plan

Recommendation: serial shared writer。

所有实现节点会修改聚类共享辅助函数和同一组集成测试，串行执行比并行合并更安全；不需要额外 worktree。

## Verification Plan

- `vitest run tests/unit/cluster-identity.test.ts tests/unit/cluster-normalization.test.ts`
- `vitest run tests/integration/cluster-assignment.test.ts tests/integration/ingestion-service.test.ts`
- `npm run lint`
- 检查 `git diff --check`，确认没有 schema、feed 时间过滤和无关文件改动。

## Scope Boundaries

- 本次不改 Prisma schema，不增加 eventDate confidence 字段，也不把 eventDate 作为候选查询的主时间字段。
- 本次不改变公开 feed 使用 `items.createdAt` 的时间过滤语义。
- 本次不重写 AI prompt、merge 图算法或 must-link 语义；这些作为后续独立优化。
- 如果无发布时间的全库召回需要新增物化字段或显著改变查询成本，保留最小安全实现并记录为后续工作。

## Open Risks

- 无发布时间且无 eventDate 的条目没有可靠时间锚点，不能保证历史事件召回；实现应避免伪装成精确时间，而不是扩大到无界全库扫描。
- eventDate 不包含来源类型和模型置信度，本次只能通过软化评分阶段的日期影响降低风险，不能完全解决日期抽取错误。
