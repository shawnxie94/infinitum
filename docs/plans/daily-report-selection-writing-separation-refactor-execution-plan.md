---
id: daily-report-selection-writing-separation-refactor-v1
type: execution_plan
status: approved
created_at: 2026-08-17
updated_at: 2026-08-17
base_commit: c726c3d4036b8a0b6ddae4464fcfacbb9b5f974d
source_plan: chat-approved-refactor-plan
---

# 日报选题与写作分离结构重构执行计划

## Scope

在不改变日报产品行为的前提下，整理当前未提交实现：收敛 SQLite schema setup 交付边界，移除已被新阶段链路替代的旧 AI provider 接口，拆分日报编排、checkpoint、revision persistence 和任务序列化职责，并将模板迁移从运行时读取热路径移出。

## Behavior Contract

- `dailyReportCandidateLimit` 仍限制完整候选集。
- `dailyReportPlanningBatchSize` 是唯一分片依据，`null` 表示整批。
- 保留 PREPARE、ASSESS、MERGE、PLAN、PLAN_VALIDATE、WRITE、VALIDATE、REPAIR、PERSIST/PUBLISH 阶段顺序。
- 保留 attempt matrix、checkpoint 恢复、revision/history、草稿恢复限制和同日期操作锁。
- 保留 Admin 与 Worker 共用日报执行器。
- 保留模板 v2 与 legacy 模板迁移边界。

## Phases

1. Schema setup consolidation: remove Prisma migration history from the delivery path, keep the current schema snapshot plus idempotent SQLite setup as the single upgrade mechanism, and retain coverage for legacy schema upgrades. [completed]
2. Runtime schema setup: keep Docker startup lightweight by using the generated SQLite schema snapshot plus idempotent SQLite setup; do not add a Prisma migration container, baseline protocol, or runtime Prisma CLI. [completed]
3. Pipeline structure: extract checkpoint serialization, attempt helpers, timeline, and revision persistence from `src/lib/daily-report/service.ts` while keeping the current public facade. Candidate discovery/deduplication remains colocated with the orchestration boundary because it still shares source-registry and recent-topic helpers. [completed]
4. Task boundary: isolate task JSON serializers and use the same strict parser for task resume and daily-report execution without changing checkpoint behavior. Daily-report payload fields remain behind the versioned generic checkpoint envelope for compatibility. [completed]
5. Provider/template cleanup: remove old provider-level one-shot generation/JSON repair APIs after call-site verification, move template migration to explicit startup/seed mode, and make ordinary settings/runtime reads migration-free. Template normalization remains one module because normalization, validation, signature, and prompt compilation share the same schema boundary. [completed]
6. Verification: run focused tests after each phase, then full tests, typecheck, lint, build, schema snapshot generation, SQLite setup rehearsal, and Docker app/worker smoke checks. [completed]

## Scope Boundaries

- Do not add product behavior, dynamic batching, automatic full-task retry, shadow mode, or AI arbitration.
- Do not reset or destructively rewrite the user's existing dirty worktree.
- Do not change public routes or serialized checkpoint version unless a compatibility adapter and tests are added.
- Delete code only after repository-wide caller search proves it is unused.

## Verification

- `git diff --check`
- `npm run schema:generate`
- focused daily-report, task, template, history, and SQLite setup tests
- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- `npm test`
- Docker app/worker startup and controlled daily-report smoke

## Runtime schema setup decision

- Docker 不新增一次性 migration service，也不在 app/worker 镜像中携带 Prisma migration CLI。
- builder 阶段生成 `prisma/schema.sql`，app/worker 启动时由 `setup-sqlite.mjs` 幂等应用当前 schema snapshot，再执行少量已验证的旧库兼容升级和 FTS/runtime 初始化。
- Prisma migration history 不再作为仓库或发布交付概念；schema 变更必须同步更新 `schema.prisma`、`setup-sqlite.mjs` 和升级测试。
- 旧库兼容保持轻量、显式、可重复执行；不引入额外 migration baseline、resolve 或复杂 legacy bridge 状态机。

## Verification evidence (2026-08-17)

- `npx vitest run tests/integration/sqlite-setup.test.ts --reporter=dot`：通过。
- `npm test`：86 个 test files、698 个 tests passed。
- `npx tsc --noEmit`、`npm run schema:generate`、`npm run lint`、`git diff --check`：通过；lint 仅保留 3 个既有 warning。
- `DATABASE_URL=file:./prisma/dev.db npx prisma validate`、`npm run build:worker`：通过。
- `docker compose build app worker`：通过；`docker compose up -d` 后 app/worker running，`/` 和 `/daily/2026-08-14` 返回 200。
- 本地 Docker 数据卷通过现有幂等 schema setup 和旧库兼容升级启动，日报 `currentRevisionId` 与 revision `restoredFromRevisionId` 外键均存在。
