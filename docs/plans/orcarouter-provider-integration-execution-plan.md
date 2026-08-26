---
id: infinitum-orcarouter-provider-integration-v1
type: execution_plan
status: approved
created_at: 2026-08-26
updated_at: 2026-08-26
sources:
  - /Users/shawn/Developer/GitHub/infinitum/AGENTS.md
  - /Users/shawn/Developer/GitHub/infinitum/src/components/admin/ai-settings-panel.tsx
  - /Users/shawn/Developer/GitHub/infinitum/src/lib/settings/model-api-service.ts
  - /Users/shawn/Developer/GitHub/infinitum/tests/components/admin-settings-panel.test.tsx
related: []
base_commit: 54814f9c030ba8bb056ceb05e13adb0f5e257bc5
---

# OrcaRouter Provider integration

## Implementation Goal

在 Infinitum 的模型 API 配置界面增加源码级 OrcaRouter Provider 预设，选择后填充 OrcaRouter Base URL 和默认模型；保持现有自定义 Base URL、模型和 API Key 流程兼容，不改变默认 Provider，不写入真实密钥。同时在 README 增加用户确认的 OrcaRouter referral badge，提交后的公开源码应包含明确的 `OrcaRouter` 和 `https://api.orcarouter.ai/v1` 配置线索，供 Partner Dashboard 扫描。

## Scope

- In scope: Provider preset contract, admin model API form selector, preset application and inference, focused component tests, and README referral badge.
- Out of scope: Prisma schema/migration, default Provider change, automatic referral account binding, external Partner Dashboard submission, real API key or live production smoke test.

## Acceptance IDs

- AC-ORCA-001: 新建模型 API 配置时可选择 OrcaRouter，并自动填充名称、Base URL 和默认模型。
- AC-ORCA-002: OrcaRouter 预设保存后仍使用现有通用 API 配置和请求路径，创建 payload 包含预设值。
- AC-ORCA-003: 编辑现有配置不会被 Provider 预设意外覆盖；非 OrcaRouter 配置仍保持原行为。
- AC-ORCA-004: 代码仓库包含无密钥的 OrcaRouter Provider 标识、Base URL 和环境变量说明，且相关组件测试通过。
- AC-ORCA-005: README 包含用户确认的 OrcaRouter referral badge 链接。

## Implementation DAG

| Unit | Depends On | Write ownership | Risk |
|---|---|---|---|
| U1 Provider preset contract | None | `src/lib/settings/model-providers.ts` | Low |
| U2 Admin form integration | U1 | `src/components/admin/ai-settings-panel.tsx` | Medium |
| U3 Regression coverage | U1, U2 | `tests/components/admin-settings-panel.test.tsx` | Low |
| U4 Public partner attribution | U1, U2 | `README.md` | Low |

Critical path: U1 → U2 → U3 → U4

## Execution Sequence

1. 新增只含公开元数据的 Provider preset，包含 `custom` 和 `orcarouter`，默认不改变现有空表单行为。
2. 在模型 API 新建表单增加 Provider 选择；新建时选择 OrcaRouter 应用 preset，编辑时根据 Base URL 识别但不自动覆盖用户已有值。
3. 添加新建 OrcaRouter 配置和保留现有自定义配置的组件回归测试。
4. 在 README 增加用户确认的 OrcaRouter referral badge。
5. 运行相关测试、lint 和 TypeScript/build 级别检查；不调用真实 API、不提交 Partner Dashboard 复查动作。

## Verification Plan

- `npx vitest run tests/components/admin-settings-panel.test.tsx`
- `npm run lint`
- `npx tsc --noEmit`
- 手动检查：源码中无真实密钥；预设包含 OrcaRouter、Base URL 和 `ORCAROUTER_API_KEY`；默认配置和现有配置行为不变。
- 手动检查：README 的 OrcaRouter badge 链接指向用户确认的 referral URL。

## Actor Parallelization Plan

Recommendation: serial same worktree / single writer.

Reasoning: U1 的 Provider contract 被 UI 和测试共同依赖，改动面小但共享类型和表单状态耦合，不并行写入。

## Remote Handoff Inputs

不委派远程执行。所有改动由当前本地 writer 串行完成；外部 Partner Dashboard 的复查需要用户在登录态下手动确认，不纳入代码执行。

## Open Questions and Risks

- Partner Dashboard 的精确源码匹配规则未公开；本计划通过显式 Provider preset、Base URL 和无密钥环境变量标识接入，但不承诺自动审核通过。
- Referral badge 仅用于公开合作展示，不参与运行时配置、API 请求或 API Key 处理。
