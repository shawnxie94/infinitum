# @infinitum/ai — P0 Mastra 概念验证

spec-mastra-migration P0 阶段产物（2026-09-21）。工作流代码为验证原型，P1a 起重构为正式结构。

## 钉版

- `@mastra/core` **1.67.0**（精确版本，lockfile 锁定）
- `@mastra/libsql` **1.23.0**
- `@libsql/client` ^0.18.0（与 @mastra/libsql 同源）

## 验证门结论（12/12 PASS，`npm run verify:mastra-p0` 可复跑）

| 门 | 结论 |
|---|---|
| G1 workspace build | `npm run build -w @infinitum/ai`（tsc --noEmit）通过；npm workspaces 生效 |
| G2 钉版 | package.json 无 `^` 前缀，lockfile 锁定 |
| G3 hello（tsx） | `createRun()` → `run.start({ inputData })` 双步链成功 |
| G3b hello（Next route） | `/api/mastra-p0` 经 transpilePackages 引 TS 源码包跑通 |
| G4 存储与重启 | LibSQL 本地文件自动建 44 张 `mastra_*` 表；journal_mode=**wal**（LibSQLStore 自动设置）；跨进程 `createRun({ runId })` + `run.resume({ step, resumeData })` 成功 |
| G4 双进程同库 | 两个进程并发跑 workflow + 直写同一 SQLite 文件无锁冲突 |
| G5 崩溃恢复 | SIGKILL 孤儿 run 被 `listActiveWorkflowRuns()` 拾起，`restartAllActiveWorkflowRuns()` 重跑中断步（attempt 计数 ≥2 证实），终态 success |
| G6 取消钉版 | 见下 |
| G7 事件 | `WorkflowOptions.onStart/onFinish/onError` 实测触发（onFinish 覆盖 success/failed） |
| G8 DB 信号量 | `INSERT ... ON CONFLICT DO NOTHING` 语义：4 进程竞争恰 1 个胜出；持有期二次触发 skip；释放后可再取 |

## 行为钉版（对 spec 决策的修正输入）

1. **1.67 的 `start/cancel/resume/watch` 都在 `Run` 上**，Workflow 只有 `createRun/commit`——旧文档的 `workflow.start()` 不存在。跨进程恢复 = `workflow.createRun({ runId })` 绑定已有 run。
2. **`run.cancel()` 干净终止**：步内 `abortSignal` 即时生效，终态 `canceled`，无残留——**社区报告的卡 suspended bug 在 1.67.0 未复现**（仍在 P1b 决策点复验）。D7 的跨进程主路径仍必须是 DB flag（abortSignal 跨进程无效）。
3. **协作取消（DB flag）终态是 `failed` + 业务错误**：D6 wrapper 必须把 `P0CooperativeCancelError` 类错误映射为 cancelled 语义（BackgroundTaskRun 终态/monitor 展示），不能直接透传为失败。
4. **崩溃恢复无自动开关**：1.67 `Config.recovery` 仅 `durableAgents`；`autoRestartActiveRuns` 配置不存在（记忆中的调研口径过时）。worker 启动时显式调一次 `restartAllActiveWorkflowRuns()` 即可（与 spec D4/C8 兼容）。
5. **run 状态表是 `mastra_workflow_snapshot`**（无 `mastra_workflow_runs`），status 在 snapshot JSON 内（`json_extract(snapshot,'$.status')`）。
6. **`mastra.on(topic)` 无公开类型面**：events 子路径提供 PubSub/EventEmitterPubSub，但无公开事件名注册表——D4 主机制定为 workflow 级回调 + D6 wrapper 采集（与 spec Revision 2 预案一致，无需修订）。
7. busy_timeout 默认 0；双进程同库在低并发下无锁冲突，P1a 接入真实 dev.db 时建议显式设置。

## 复跑方式

```bash
npm run db:setup            # 前置：worktree 内生成 prisma/dev.db
npm run verify:mastra-p0    # 全套验证门（写 packages/ai/src/verify/results.json）
```

P0 临时产物清单（P1a 清理）：`src/verify/*`、`src/app/api/mastra-p0/route.ts`、`workflows/{hello,recoverable,cancellable}.ts`（正式域工作流在 P1b-P4 另建）。
