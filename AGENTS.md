# AGENTS.md

Infinitum：Next.js App Router 新闻聚合系统。  
默认解释语言：中文。

## UI presentation preference

- 保持页面和配置界面简洁，优先使用字段标题、控件和必要的操作反馈。
- 不额外添加解释性辅助段落、提示卡片或冗长说明；只有确实影响操作理解的信息才展示。
- 能通过界面结构表达的规则，不重复写成帮助文案。

## Overview

流水线：RSS 拉取 → 全文抽取（必要时）→ AI 分析/翻译/摘要 → 聚类去重 → 公开展示 + Admin 管理。

## Commands

```bash
# Dev
npm run dev              # Next.js dev (localhost:3000)
npm run worker           # 后台任务 worker

# Database
npm run db:setup         # 初始化/升级 dev SQLite
npm run db:test:setup    # 重置并初始化 test DB
npm run prisma:generate
# Docker/production SQLite uses the generated schema snapshot and idempotent
# runtime schema upgrades; no Prisma migration history is shipped or executed.

# Test / lint / build
npm test                 # 全量测试 + coverage（会重置 test DB）
npm run test:watch
vitest run tests/integration/feed-api.test.ts   # 单文件示例
npm run lint
npm run build
```

### 按改动面建议的验证命令

按改动面选择，至少跑相关子集；大改动再跑全量：

| 改动面 | 建议命令 |
|---|---|
| Feed 查询/时间窗/缓存 | `vitest run tests/integration/feed-api.test.ts tests/unit/feed-range.test.ts` |
| Ingestion / 任务 | `vitest run tests/integration/ingestion-service.test.ts tests/integration/background-task-service.test.ts` |
| DB schema / setup | `npm run schema:generate && vitest run tests/integration/sqlite-setup.test.ts` |
| 宽改动 / 收工 | `npm test` 与/或 `npm run lint` |

## Layout

```text
src/app/           App Router 页面与 Route Handlers
  page.tsx         公开展示首页
  login/           管理登录
  admin/           管理台（content / settings / monitor）
  api/feed/        公共 feed API
  api/admin/       管理 API（需 session）
  api/ingest/      拉取触发
src/lib/
  feed/            公共 feed 查询层（service 为主入口）
  ingestion/       RSS → DB 管线
  clusters/        聚类
  tasks/           后台任务（service / worker / scheduler / handlers）
  items/           单条再生/重分析
  settings/        配置 CRUD + AI 配置
  ai/              OpenAI 兼容客户端
  tags/ events/ aggregation/  标签、事件、聚合等
prisma/schema.prisma
scripts/generate-sqlite-schema.mjs # compile current Prisma schema to SQLite DDL snapshot
scripts/setup-sqlite.mjs     # SQLite schema snapshot/runtime setup and small legacy upgrades
config/infinitum.config.json   # 首次导入模板；运行时配置在 DB
tests/{unit,integration}/
```

## Layer order

`src/lib/*` → `src/app/api/*` → UI 组件。  
共享参数解析 / DTO 组装抽到 helpers；Feed 读路径用 `src/lib/feed/service.ts`，不要绕过直接玩缓存。

## Hard constraints（禁忌）

1. **Feed 时间过滤用 `items.createdAt`，不要改成 `publishedAt`**  
   语义是「系统入库时间窗」，不是源站发布时间。
2. **影响公共 feed 的写操作必须 `invalidateFeedCache()`**（`src/lib/feed/cache.ts`）。
3. **Schema 只改 `prisma/schema.prisma`，并同步维护 `scripts/setup-sqlite.mjs` 的升级逻辑和测试**；Docker 和本地初始化基于生成的 schema snapshot 幂等执行，不使用 Prisma migration history。
4. **后台任务有双路径**：Admin 同步执行 + worker 队列；改 handler 两边都要考虑。
5. **Ingestion 优化优先总耗时**，不是盲目加并发；减少串行步骤与无效 DB 写。
6. **改 feed 查询时核对**：cluster/单条混排、分组计数、标题搜索、时区日界。
7. **高频写**：批处理 / 节流 / 阶段末 flush，避免逐条狂写。

## Env

`.env` 至少需要：

- `DATABASE_URL`（如 `file:./prisma/dev.db`）
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`

运行时配置在 DB（源、黑名单、AI、prompt、调度等）；`config/infinitum.config.json` 仅首次导入。

## Admin

- Login: `http://localhost:3000/login`
- Admin: `http://localhost:3000/admin`
- Settings: `http://localhost:3000/admin/settings`
- Monitor: `http://localhost:3000/admin/monitor`

Session：HTTP-only cookie，由 `ADMIN_SESSION_SECRET` 签名。
