# @infinitum/ai — AI Runtime

`@infinitum/ai` 提供 Infinitum 的模型调用、嵌入和 workflow runtime。正式后台任务由 Mastra workflow 承载；业务 Prompt、operation 语义、配置解析、schema/parser 和业务副作用仍由主仓拥有。

## 当前边界

- `src/provider/gateway.ts`：模型传输、结构化 JSON、重试、修复、fallback、熔断和 usage 回调。
- `src/provider/operations.ts`：operation contract、schema 和 JSON retry policy。
- `src/provider/usage-ledger.ts`：框架无关的 AI call、token、attempt ledger。
- `src/provider/embeddings.ts`：嵌入管线；默认通过 `@ai-sdk/openai-compatible` 的 `embedMany` 传输，向量存储由业务侧注入。
- `src/orchestration/`：Mastra workflow、step lifecycle、checkpoint、取消和终态投影适配。
- 主仓 `src/lib/ai/`：业务 Prompt、parser、schema 和 operation 注册。
- 主仓 `src/lib/ai-orchestration/runtime.ts`：将 Mastra lifecycle 和遥测投影到 `BackgroundTaskRun`。

运行时要求 Node.js `>=22.13.0`。Mastra 依赖版本由 workspace manifest 和 lockfile 管理。

## 验证

- 包类型检查：`npm run build -w @infinitum/ai`
- Mastra 接入测试：`npx vitest run tests/unit/mastra-framework-capability.test.ts tests/integration/mastra-staged-workflow.test.ts`
- 真实 Runtime + LibSQL 冒烟（先创建隔离库）：
  ```bash
  node scripts/setup-sqlite.mjs /tmp/infinitum-mastra-smoke.db --reset
  DATABASE_URL=file:/tmp/infinitum-mastra-smoke.db npm run smoke:ai-orchestration
  ```

冒烟检查会通过 Mastra/LibSQL 初始化或写入 runtime 存储表。请使用测试库或专用临时数据库，不要指向生产库；默认 smoke 使用不存在的 task id，不触发业务任务写入。

## 历史 P0 验证记录（2026-09-23）

迁移早期曾完成 12 项 P0 探索/验证，覆盖 workflow 启动、LibSQL 存储与恢复、取消、事件和 DB 信号量。该阶段的临时 harness 与 API 路由已删除，历史结果**不可由仓库内的 P0 命令复跑，也不代表当前版本刚刚通过了这些门**。当前版本请以本节列出的包构建、接入测试和真实 Runtime 冒烟结果为准。

后续 Mastra 版本行为以当前依赖版本为准；历史实验结论不作为未来版本兼容保证。
