---
id: daily-report-selection-writing-separation-v1
type: execution_plan
status: completed
created_at: 2026-08-14
updated_at: 2026-09-05
sources:
  - docs/trd/daily-report-selection-writing-separation.md
  - AGENTS.md
  - src/lib/daily-report/service.ts
  - src/lib/daily-report/template.ts
  - src/lib/daily-report/validator.ts
  - prisma/schema.prisma
related:
  - docs/trd/daily-report-selection-writing-separation.md
base_commit: c726c3d4036b8a0b6ddae4464fcfacbb9b5f974d
---

# 日报选题与写作分离执行计划

## 实施目标

将当前“候选集 → 单次日报生成 → JSON 修复 → 持久化”的链路改造成可观测、可恢复的固定阶段链路：完整候选集先经过覆盖式选题评估，再由本地规则合并为主题账本，由全局规划器决定栏目分配，最后由写作器严格按规划产出。任务配置中的 `dailyReportCandidateLimit` 仍是完整候选集上限；`dailyReportPlanningBatchSize` 是唯一分片依据，未配置时整批处理，不引入隐藏默认值或最大值配置。

完成定义：新模板 v2、固定分片、全量候选覆盖、确定性合并、全局计划、计划/草稿校验、单节点 checkpoint 恢复、固定 attempt matrix、日报 revision/history、任务时间线和 Admin 入口均具备实现与验证证据；旧日报生成链路不再作为运行时兜底。

## 约束与当前切片

- 只保留现有 `docs/trd/` 中用户已确认的决策，不在实施阶段重新设计产品边界。
- 不做历史日报数据回填；新增 nullable 字段由 SQLite setup upgrade 直接补齐。
- 不引入 shadow 模式、动态拆分、AI 裁决或任务级自动全量重试。
- 当前执行批次为 `U3-U7-integrated-implementation`：在已完成的 U1 契约与 U2 Provider DTO 前置条件上，完成单批编排、固定分片与确定性合并、checkpoint/时间线/attempt matrix、revision/history 和 Admin/监控接入；U8 只负责集成验证与发布前证据，不属于本次实现 Task Pack 的写入范围。
- 共享 schema、运行时配置类型、模板公共接口由本地 lead 单写；不并行修改这些文件。

## 实施 DAG

```text
U1 contracts ──┬──> U2 provider DTOs ──> U3 single-batch pipeline
               │                         ├──> U4 fixed batching + deterministic merge
               │                         ├──> U5 checkpoint + timeline + attempt matrix
               │                         └──> U6 revision/history persistence
               └──> U7 Admin config/template migration UI

U3 + U4 + U5 + U6 + U7 ──> U8 integration, worker/admin parity, acceptance verification
```

关键路径为 `U1 → U2 → U3 → U4/U5 → U8`。`U1` 是共享写边界和高风险节点，先完成并验证；`U4` 的合并规则必须在进入全局规划前固定；`U5` 和 `U6` 需要在最终发布前共同验证失败恢复和并发锁。

## 实施单元

### U1-contracts（前置契约，已完成）

范围：

- `TaskSchedule.dailyReportPlanningBatchSize` nullable 字段及配置读写/快照；`null` 表示完整候选集单批。
- `BackgroundTaskRun.pipelineCheckpointJson` nullable 字段及序列化 DTO 基础。
- `PromptConfig.templateMigrationAuditJson` nullable 字段。
- `DailyReport.currentRevisionId` 及 revision/lock/source 快照模型的 schema 契约；不做回填。
- 模板 v2 类型：`schemaVersion`、稳定 `key`、`required`、`minItems`、`maxItems`；前端不暴露 key，后端按标题生成并保留已有 key。
- 静态模板规范化、legacy 默认模板静默迁移、非默认 legacy 模板迁移判定、section 数量约束校验和模板签名。

写入边界：`prisma/schema.prisma`、`scripts/setup-sqlite.mjs`、`src/lib/daily-report/template.ts`、`src/lib/tasks/{service,repository,types}.ts` 及相关单测/集成测试。

验收：`AC-U1-01` 至 `AC-U1-06`。

### U2-provider-contracts

范围：为 assess/plan/write/repair 定义明确输入输出 DTO 和 provider 方法；保留 aggregate AI usage key，阶段细节进入 timeline。不得在 provider 中做候选重选或主题合并。

验收：`AC-U2-01` 至 `AC-U2-04`。

### U3-single-batch-pipeline

范围：实现 PREPARE、ASSESS、MERGE、PLAN、PLAN_VALIDATE、WRITE、VALIDATE、REPAIR、PERSIST/PUBLISH 的单批端到端编排；先复用一批完整候选验证边界。

验收：`AC-U3-01` 至 `AC-U3-07`。

### U4-fixed-batching-and-merge

范围：严格按配置 batch size 切分；每个候选只评估一次；所有批次完成后本地确定性合并；任何批次失败直接失败并保留已完成 checkpoint，不动态缩小批次。

验收：`AC-U4-01` 至 `AC-U4-06`。

### U5-resume-observability

范围：阶段节点/批次指标、checkpoint 恢复、固定 attempt matrix、单节点手动重试；移除任务级自动全量重试。Admin 同步路径与 worker 路径共用同一执行器。

验收：`AC-U5-01` 至 `AC-U5-07`。

### U6-revisions-history

范围：单日期当前记录保持唯一；首次新链路覆盖旧记录时创建 baseline revision；草稿可恢复历史版本并生成新的 draft revision；已发布日报不可恢复；生成/恢复按 date+timezone 加锁。

验收：`AC-U6-01` 至 `AC-U6-06`。

### U7-admin-surfaces

范围：任务配置 batch size；模板 legacy 迁移预览/确认；内容工具栏 history icon 与弹窗；任务详情按新阶段显示时间线。

验收：`AC-U7-01` 至 `AC-U7-05`。

### U3-U7-integrated-implementation（当前 Task Pack，单写）

范围：串联并交付 U3、U4、U5、U6、U7 的实现切片，包括日报阶段编排、固定批次和确定性合并、checkpoint/attempt matrix/任务时间线、revision/history，以及 Admin 配置、模板、历史和任务监控界面。该切片依赖已完成的 U1-contracts 与 U2-provider-contracts，不重新打开产品边界。

写入边界：Task Pack `2026-08-14-daily-report-selection-writing-separation-u3-u7` 中声明的代码、schema setup upgrade、测试和 Admin/UI 路径；计划/ readiness 文档由交付负责人单写并在修改后重新计算 hash。

验收：`AC-U3-U7`；U8 验收作为后续 verification gate，不作为本 Task Pack 的实现完成证明。

### U8-release-verification

范围：端到端集成测试、worker/Admin parity、数据库 setup upgrade、lint/build、日报生成和历史恢复 smoke；生成 release handoff evidence。

验收：`AC-U8-01` 至 `AC-U8-06`。

## 验收矩阵

### U2-provider-contracts

- `AC-U2-01`：assess、plan、write、repair 的 provider 方法均使用明确的阶段 DTO，返回值可被本地规则校验；provider 不负责候选重选、主题合并或栏目决策。
- `AC-U2-02`：planning prompt 只投影模板的 section block，不把模板内部 `text` block 当作栏目；未知栏目、重复栏目和非法结构由本地校验返回可定位错误。
- `AC-U2-03`：阶段 AI usage 仍聚合到日报任务总 usage key，同时时间线记录阶段/批次/候选指标，不改变现有计费聚合语义。
- `AC-U2-04`：阶段 provider 失败保留原始错误分类；context overflow 可被识别为不可恢复的 `context_overflow`，不得被当作普通 JSON 修复或动态拆分。

### U3-single-batch-pipeline

- `AC-U3-01`：单批链路按 `PREPARE → ASSESS → MERGE → PLAN → PLAN_VALIDATE → WRITE → VALIDATE → REPAIR → PERSIST/PUBLISH` 顺序执行，Admin 同步和 worker 复用同一执行器。
- `AC-U3-02`：ASSESS 输出先经过本地确定性合并，再交给全局 PLAN；WRITE 只能引用 PLAN 中的 candidate ID，不得自行扩展候选范围。
- `AC-U3-03`：PLAN_VALIDATE 只校验栏目引用、候选引用和计划结构；最终 VALIDATE 只校验草稿结构、条目数和内容，不与计划校验混用。
- `AC-U3-04`：WRITE/REPAIR 的输出均经过本地结构校验，repair 只接收当前草稿与 violation 列表，不重新执行选题。
- `AC-U3-05`：PERSIST/PUBLISH 只接收已通过最终校验的草稿，并在 date+timezone 锁内完成日报唯一记录与 revision 写入。
- `AC-U3-06`：任一阶段失败都能形成包含 failedStage、failureCode、stageAttempts 和已完成阶段数据的 checkpoint；成功终态清除 checkpoint 恢复语义。
- `AC-U3-07`：旧日报生成链路不作为运行时兜底；模板版本或输入签名不匹配时不得静默从头续跑旧 checkpoint。

### U4-fixed-batching-and-merge

- `AC-U4-01`：`dailyReportCandidateLimit` 只限制完整候选集，`dailyReportPlanningBatchSize` 是唯一分片依据；`null` 表示完整候选集单批。
- `AC-U4-02`：固定切批覆盖完整候选集，候选顺序和 candidate ID 在批次间稳定，最后一批允许少于配置值。
- `AC-U4-03`：每个候选在每个任务中最多进入一次 ASSESS；批次失败不重复调用已成功批次，也不动态缩小失败批次。
- `AC-U4-04`：所有批次完成后才执行 MERGE/PLAN；合并按 candidate ID 去重、按确定性规则排序，并保留来源批次信息。
- `AC-U4-05`：批次 checkpoint 可恢复已成功批次，仅重试仍有 attempt 预算的失败批次；context overflow 直接失败且不可恢复。
- `AC-U4-06`：任务快照和时间线记录配置 batch size、实际 batch count、评估候选数和最终选中数。

### U5-resume-observability

- `AC-U5-01`：时间线包含兼容父节点和 `PREPARE/ASSESS/MERGE/PLAN/PLAN_VALIDATE/WRITE/VALIDATE/REPAIR/PERSIST/PUBLISH` 节点，失败时保留阶段、批次和校验指标。
- `AC-U5-02`：attempt matrix 是阶段重试上限的唯一运行时来源；阶段 attempt 按阶段/批次持久化，重启后不重置。
- `AC-U5-03`：context overflow、attempt 耗尽和 checkpoint 签名不匹配分别返回明确 failureCode，并禁止继续执行入口。
- `AC-U5-04`：符合 `resumeEligible` 的失败日报由原 task run 重新入队，task ID 不变、resumeAttempt 递增，不创建任务级全量重试记录。
- `AC-U5-05`：断点恢复只从 checkpoint 对应阶段继续；输入、模板、模型、配置或 pipeline 签名变化时必须新建任务并从 PREPARE 开始。
- `AC-U5-06`：PERSIST/PUBLISH 支持 DB-only 幂等重试，同一任务/输入幂等键不会重复创建 revision 或改变当前日报唯一性。
- `AC-U5-07`：任务详情对可恢复失败展示“继续执行”，对不可恢复失败展示“重新生成”，并在确认提示中说明两者语义差异。

### U6-revisions-history

- `AC-U6-01`：同一日期当前日报保持唯一，生成和恢复通过 date+timezone 锁串行化。
- `AC-U6-02`：首次新链路覆盖旧记录时创建 baseline revision；之后每次生成或恢复都保留可查看的 revision 元数据和来源快照。
- `AC-U6-03`：历史弹窗显示当日 revision 列表和正文预览，正文标题不重复渲染；当前版本有明确标识。
- `AC-U6-04`：仅草稿日报允许恢复历史版本；恢复动作生成新的 draft revision，不直接覆写历史 revision。
- `AC-U6-05`：已发布日报不显示恢复入口，API 也拒绝恢复请求；不存在目标 revision 或日期不匹配时返回明确错误。
- `AC-U6-06`：history/detail/restore API 和前端弹窗在无历史、加载失败、恢复中、恢复成功等状态下有可验证行为。

### U7-admin-surfaces

- `AC-U7-01`：日报任务配置可读写 nullable `dailyReportPlanningBatchSize`，不暴露默认 batch、最大 batch 或 `dailyReportMaxRetries`。
- `AC-U7-02`：旧官方默认模板在读取时静默迁移；自定义 legacy 模板显示迁移状态和确认入口，前端只配置 `required/minItems/maxItems`，key 由后端生成。
- `AC-U7-03`：模板编辑器使用“条目数非空校验”文案，并校验 section 数量约束、key 唯一性和模板签名变化。
- `AC-U7-04`：日报正文工具栏提供 history icon，点击打开历史弹窗，支持查看详情和草稿恢复；弹窗不重复展示摘要/正文标题。
- `AC-U7-05`：任务监控详情展示新阶段时间线、批次/候选/校验指标、失败原因和继续执行/重新生成动作。

### U8-release-verification

- `AC-U8-01`：日报 planning/provider/service/history/task monitor 相关单测和集成测试通过，包含 context overflow、checkpoint resume、draft-only restore 和 idempotent persist 场景。
- `AC-U8-02`：Prisma generate、SQLite schema generate/setup、TypeScript、lint 和 diff check 通过；lint 仅允许已记录的既有 warning。
- `AC-U8-03`：生产构建通过，Admin 同步触发和 worker 消费使用相同日报执行器且无类型/路由差异。
- `AC-U8-04`：本地 Compose 冒烟验证日报页面、任务详情、历史弹窗和新增 Admin 配置入口可访问。
- `AC-U8-05`：在受控环境完成一次真实 provider 草稿生成、一次可恢复失败批次继续执行、一次历史恢复和一次发布前后状态校验。
- `AC-U8-06`：release handoff 记录 schema setup upgrade、部署观察、失败回滚边界；未完成真实 provider/生产验证时不得标记为 release ready。

## 当前批次验收标准

- `AC-U1-01`：新增 nullable schema 字段和 revision/lock 关系可由 SQLite setup upgrade 创建，既有行不被删除或回填。
- `AC-U1-02`：任务快照/API 能读写 `dailyReportPlanningBatchSize`；`null` 代表整批，不能由服务层注入隐藏默认值、上限或动态拆分行为。
- `AC-U1-03`：模板 v2 规范化为稳定 key，并为缺失的 `required/minItems/maxItems` 应用明确的兼容默认；key 不要求前端配置。
- `AC-U1-04`：默认官方旧模板可静默迁移；自定义旧 `opening/sections/closing` 模板不能被误判为可运行 v2，必须返回迁移所需状态。
- `AC-U1-05`：section 的 `minItems/maxItems`、required 和 key 唯一性校验有单测，错误包含可定位字段路径。
- `AC-U1-06`：模板规范化结果可稳定序列化并生成签名，运行期可据此识别配置版本变化。

验证命令：

```bash
npm run prisma:generate
npm run schema:generate
vitest run tests/unit/daily-report-template.test.ts tests/integration/sqlite-setup.test.ts tests/integration/admin-settings-service.test.ts
npm run lint
git diff --check
```

## 失败、恢复与回滚边界

- provider context overflow、计划校验失败、写作校验失败均只影响当前 attempt；达到该节点上限后任务失败，已完成 checkpoint 保留。
- manual resume 只从 checkpoint 恢复，要求输入 snapshot/template signature/model/config 未变化；不允许跨输入恢复。
- PERSIST/PUBLISH 仅允许幂等 DB-only 重试。
- schema setup upgrade 增加 nullable 字段和新表，并在未部署生产的前提下由 `setup-sqlite.mjs` 删除已废弃的 `dailyReportMaxRetries` 列；不做历史值回填。既有 SQLite 卷由 setup upgrade 补齐新 revision 关系约束。
- 新链路在实现完成前不切换生产；切换前必须通过 `verify_to_release`，失败时回滚应用版本和运行时链路，不做破坏性数据回填。

## 交付证据与 Task Pack 规则

- 本计划是唯一执行排序真相，Task Pack 只引用一个当前实施单元。
- 每个 Task Pack 必须记录 `plan_id`、`source_plan_sha256`、`base_commit`、`plan_unit_id`、允许路径、验收 ID、验证命令和 readiness report SHA。
- 任何计划、TRD 或 schema 变化都必须重新计算 hash 并重跑对应 readiness gate。
- 当前不委派并行写入；U1 完成并验收后，再按文件边界决定是否拆分 U2/U7 的只读分析或隔离实现。

## Remote Handoff Inputs

当前没有远程委派。若后续委派 U7，必须提供本计划、TRD、U1 的稳定 DTO/schema hash、禁止修改 provider/service 核心编排、以及组件测试和 lint 命令；U1/U3/U5 仍由本地 lead 单写。
