---
id: infinitum-daily-report-prompt-config-convergence
type: execution_plan
status: completed
created_at: 2026-08-18
updated_at: 2026-09-05
sources:
  - user-request:daily-report-prompt-config-convergence
related:
  - docs/plans/daily-report-topic-first-execution-plan.md
base_commit: 5511377f9455d646cd8aa0d530d9bb6f1d288f98
---

# 日报提示词后台配置收敛执行计划

## 目标

将 AI 日报后台配置收敛为三层：

1. 流程合同、数据关系、输出协议由代码和阶段内部提示词固化；
2. 后台只配置日报模板、选题策略和写作风格；
3. 模型、温度、Token 等作为高级运行参数保留。

本次不改变日报的 Topic-first 运行链路、候选过滤、Topic-Candidate 映射、Block 数量校验和正文输出结构。

## 实施 DAG

| Unit | Depends On | Scope | Verification |
|---|---|---|---|
| U1 | - | 收敛模板默认规则，将流程协议从用户可编辑 globalRules 移到内部阶段合同，保留模板和历史主题策略 | 模板单测、提示词单测 |
| U2 | U1 | 调整日报后台配置文案和保存边界，明确模板/策略配置，不展示无效的通用 prompt 编辑入口 | Admin 组件测试、类型检查 |
| U3 | U1 | 补充阶段输入投影说明，明确 recentTopicRules、globalRules、Block 字段分别在哪些阶段生效 | AI provider 日报阶段测试 |
| U4 | U2/U3 | 更新兼容测试并完成日报相关回归验证 | 日报测试、tsc、lint、build、diff check |

关键路径：U1 → U2/U3 → U4。共享模板、provider 和后台组件由当前主执行者串行修改，不启动并行写入。

## 变更边界

允许修改：

- `src/lib/daily-report/template.ts`
- `src/lib/ai/provider.ts`
- `src/components/admin/daily-report-template-editor.tsx`
- `src/components/admin/ai-settings-panel.tsx`
- 日报模板、AI provider、Admin 配置相关测试
- 本执行计划文件

禁止顺带修改：

- Prisma schema、数据库迁移和生产数据库
- ASSESS/PLAN/WRITE 的业务决策逻辑
- 候选去重、Topic-Candidate 映射和 Block 数量校验算法
- 非日报提示词配置
- 部署和发布配置

## 固化规则

- ASSESS/PLAN/WRITE/REPAIR 阶段职责和 JSON 合同
- candidate/topic/block 映射与来源关系
- candidateId、topicId、blockKey 的合法性
- 候选不得重复归属、Topic 不得跨 Block、Topic 只能生成一个条目
- Block/Topic 排序、数量最终校验、标题长度和 JSON 结构校验
- 不编造事实、不得输出内部来源映射、REPAIR 不得重新选题

## 用户可配置规则

- Block 顺序、标题、描述和条数范围
- 标题文案风格
- 正文写作要求和 notes 要点
- 历史主题重复/后续进展的编辑偏好，但不改变代码硬过滤和 ASSESS 枚举
- 模型、temperature、maxTokens、topP 等高级参数

## 验收标准

1. 默认 globalRules 不再包含 Topic/候选/栏目映射等流程协议。
2. 固定流程约束仍在 ASSESS/PLAN/WRITE/REPAIR 内部提示词和本地校验中生效。
3. recentTopicRules 继续只作为历史主题判断策略输入 ASSESS/PLAN；globalRules 只作为正文写作规则输入 WRITE/REPAIR。
4. 日报后台明确展示“模板/历史主题策略/正文写作规则”，不把日报配置误导为可任意编辑的通用 system prompt。
5. 日报保存后模板 JSON、编译 system prompt 和运行时阶段输入保持一致。
6. 旧日报模板和旧配置可正常解析；不修改历史日报数据。

## 验证计划

- `npx vitest run tests/unit/daily-report-template.test.ts tests/unit/ai-provider.daily-report-stages.test.ts tests/components/admin-settings-panel.test.tsx tests/integration/admin-settings-service.test.ts`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- `git diff --check`

## 风险与处理

- 当前工作树已有日报候选审计改动；provider、types 和日报测试存在重叠写入，实施时只叠加本计划范围并保留已有改动。
- 用户已有自定义 globalRules 可能包含流程文本；本次不批量修改生产数据库，只保证新默认模板和后台文案边界清晰，运行时仍由固定阶段合同兜底。
- 若完全移除日报 prompt 字段导致已有 API/DTO 兼容风险，则保留存储字段但将其标记为系统生成/只读，不让用户编辑。

## Remote Handoff Inputs

本任务使用单一主执行者串行完成；不创建远程执行任务。共享文件、模板契约和 provider 提示词需要同一上下文内联调。
