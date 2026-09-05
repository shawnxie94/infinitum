---
id: infinitum-daily-report-candidate-review-dedup-audit
type: execution_plan
status: completed
created_at: 2026-08-18
updated_at: 2026-09-05
sources:
  - user-request:daily-report-candidate-review-dedup-audit
related:
  - docs/plans/daily-report-topic-first-execution-plan.md
base_commit: 5511377f9455d646cd8aa0d530d9bb6f1d288f98
---

# 日报候选与去重审计展示执行计划

## 目标

将日报候选快照中的重复过滤结果按来源分开持久化并展示：

- 代码硬过滤的历史重复继续保留；
- ASSESS 阶段 `historyDecision=duplicate` 的 AI 历史重复新增明细；
- 当前候选集合内的重复继续单独保留；
- 三类重复合并到同一个“重复排除”Tab，统计区显示合计数量，条目保留来源标签；
- ASSESS 的历史重复条目保留模型返回的命中历史主题标题，供人工追溯；
- 旧日报快照保持兼容，缺少新字段时按空数组处理。

## 实施 DAG

| Unit | Depends On | Scope | Verification |
|---|---|---|---|
| U1 | - | 扩展日报候选快照/详情 DTO，定义 AI 重复条目字段并保持旧快照兼容 | 类型检查、定向类型消费检查 |
| U2 | U1 | 在生成完成时从 ASSESS ledger 构建 `excludedAssessDuplicates` 并写入 `candidateSnapshot` | 日报集成测试 |
| U3 | U1 | 解析新快照字段并更新候选弹窗，区分硬过滤与 AI 判定重复 | 组件测试或构建检查 |
| U4 | U2/U3 | 增加回归测试并运行日报相关测试、类型检查、lint、diff 检查 | 全部命令通过 |

关键路径：U1 → U2/U3 → U4。共享类型和快照由当前主执行者串行修改，不启动并行写入。

## 变更边界

允许修改：

- `src/lib/daily-report/types.ts`
- `src/lib/daily-report/service.ts`
- `src/lib/daily-report/repository.ts`
- `src/components/daily/daily-report-detail.tsx`
- 日报相关测试
- 本执行计划文件

禁止顺带修改：

- Prisma schema 与数据库迁移
- ASSESS/PLAN 的选题逻辑
- 生产环境数据
- 与日报候选审计无关的 UI 或任务统计

## 验收标准

1. 新生成日报的 `candidateSnapshot` 包含 `excludedAssessDuplicates`。
2. AI 重复条目至少包含候选基础信息、`relevanceScore`、`suggestedBlockKey`、`historyDecision`、`matchedRecentTopicTitle` 和明确的排除原因。
3. 候选弹窗使用一个“重复排除”Tab展示三类重复，统计区显示三类合计数量，每条记录保留规则重复、AI 历史重复或当前重复标签。
4. 旧快照没有 `excludedAssessDuplicates` 时仍可正常加载，显示为空。
5. 任务时间线中的 AI 历史重复数量与弹窗对应分类数量一致。
6. 不改变候选过滤、PLAN 选题或日报正文生成结果。

## 验证计划

- 日报服务集成测试：验证 ASSESS duplicate 被持久化并通过详情 DTO 返回。
- 日报详情组件相关测试或 `npm run build`：验证新分类展示和旧快照兼容。
- `npx tsc --noEmit`
- `npm run lint`
- `git diff --check`

## 风险与处理

- `candidateSnapshot` 是历史持久化 JSON，新增字段必须可选，不能要求旧日报回填。
- ASSESS duplicate 只从已完成的 assessment ledger 构建，不能重新调用模型或改变已生成日报。
- 规则重复与 AI 重复可能针对同一候选出现在不同生成记录中；同一份新快照内按过滤阶段分别归类，不跨类别去重。
