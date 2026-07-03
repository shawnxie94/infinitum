---
id: trd-event-briefing
type: trd
status: implemented
created_at: 2026-06-30
updated_at: 2026-07-03
sources:
  - AGENTS.md
  - prisma/schema.prisma
  - src/app/page.tsx
  - src/app/daily/page.tsx
  - src/components/ui/global-header.tsx
  - src/components/ui/page-shell.tsx
  - src/lib/feed/repository.ts
  - src/lib/feed/quality-score.ts
  - src/lib/daily-report/repository.ts
related:
  - docs/trd/content-signals-export-api.md
---

# TRD: 事件速览

## 背景和目标

Infinitum 生产环境每天约有 300 条资讯进入信息流。当前系统已经具备 RSS 采集、全文抽取、AI 摘要、质量评分、标签、事件签名、聚合和日报能力，但用户仍需要在完整 Feed 或日报长总结之间切换：完整 Feed 信息量过大，日报适合归档阅读但不够适合作为快速判断入口。

本功能目标是新增一个公开的 **事件速览** 页面，按某一天展示系统识别出的重点事件，让用户用更少时间获得更高信息密度。

核心目标：

- 从每天约 300 条资讯中压缩出可快速浏览的重点事件列表。
- 页面按 **日期** 工作，而不是 24 小时、3 天、7 天或自定义时间范围。
- 每页展示数量由公开页分页参数控制，参考主页分页体验，不进入后台配置。
- 第一期加入站点级主理人偏好加权，让公开速览更符合站点关注方向。
- 事件卡片保持高信息密度，避免变成长摘要列表。
- Header 增加公开导航入口，建议 label 为 `速览`，页面标题为 `事件速览`。
- 页面风格尽量复用当前主页和日报的 `PageShell`、header、卡片、筛选、分页和视觉 token。

非目标：

- 不在第一期建设完整实体体系、知识图谱或 claim-level 证据链。
- 不新增个人已读、忽略、收藏、置顶等用户状态；该页面面向公众展示。
- 不做多用户个性化推荐，不采集访客点击、停留、已读等行为信号参与第一期排序。
- 不恢复已删除的实时热榜或 trending board。
- 不把多源确认、最新进展拆成独立主内容区；它们是重点事件的排序信号和解释标签。
- 不要求页面打开时实时调用 AI。
- 二期 AI brief 只在 ingestion 结束后异步生成；不设计定时兜底，也不为历史日期补数据。
- 不替代 `/daily`；日报仍作为叙事型归档总结。
- 日报深度化不进入一期和二期范围；三期再调整日报生成逻辑。

## 当前系统上下文

现有数据和能力可以支撑第一期：

- `Item` 已存储标题、摘要、全文、质量分、状态、来源、标签、事件签名、聚合关系和入库时间。
- `ContentCluster` 已存储聚合标题、摘要、分数、条目数、来源数、事件身份字段、Feed 展示统计字段。
- `src/lib/feed/quality-score.ts` 已收敛为内容质量分归一化逻辑，主页 Feed 分数只表达内容本身质量。
- `src/lib/daily-report/repository.ts` 已有日报候选池、按日候选、聚合去重、候选评分等逻辑。
- `src/components/ui/global-header.tsx` 当前公开导航为 `主页 / 日报`，可扩展 `速览`。
- `src/app/daily/page.tsx` 已使用 `PageShell`、左侧时间筛选和列表式归档布局。

关键约束：

- 日期窗口必须继续使用 `items.createdAt` 表示系统入库日期，保持和 Feed 的时间语义一致。
- 公开页面只能展示 `status="processed"` 且 `moderationStatus` 可展示的内容。
- 聚合事件优先展示 cluster；未聚合但高分的单条 item 可以作为 single event 展示。
- 第一版应尽量复用现有摘要和聚合结果，不新增同步 AI 调用。
- 站点主要服务主理人自己使用，同时公开给公众浏览；因此第一期采用站点级偏好加权，而不是每个访客一套个性化结果。

## 产品定义

### 命名和入口

- Header nav label：`速览`
- 页面标题：`事件速览`
- 推荐 URL：
  - `/events`：默认展示今天。
  - `/events?date=2026-06-30`：第一期可用 query 参数实现。
  - `/events/2026-06-30`：后续可作为详情友好的归档 URL 方案评估。

公开导航顺序：

```text
主页 / 速览 / 日报
```

阅读层级：

- `主页`：完整资讯流。
- `速览`：某一天重要内容的快速入口。一期只包含事件速览；四期扩展为 `事件 / 观点` 二级视图。
- `日报`：某一天重要事件的叙事型总结和归档。

公开速览排序语义：

```text
全局重要性 + 站点主理人偏好 = 公开精选视角
```

这不是每个访问者的个性化推荐，而是站点公开表达的关注方向。公众看到的是同一套速览结果。

### Phase Roadmap

本功能按“先压缩信息，再增强表达，再深化分析，再覆盖观点”的顺序推进：

| Phase | 目标 | 交付边界 |
|---|---|---|
| Phase 1 | 建立可用的公开事件速览 | `/events` 单日重点事件列表、Header `速览` 入口、主页式分页、规则排序、站点级主理人偏好加权。 |
| Phase 2 | 提升事件表达和可追溯性 | ingestion 成功后异步生成 `EventBrief`，补轻量实体、证据锚点和时间线摘要；页面只读取缓存 brief，不同步调用 AI，不定时兜底，不补历史日期。 |
| Phase 3 | 深化日报 | 日报候选来自事件速览 Top N，结合 `EventBrief` 和可缓存外部证据，生成主题化深度简报。 |
| Phase 4 | 覆盖高质量博客和新观点 | 在同一 `速览` 入口下增加 `事件 / 观点` 二级视图，独立建设内容类型识别、`ArticleInsightBrief` 和 `insightScore`。 |

暂不单独规划“Phase 5 个性化”。当前产品主要是站点主理人自用、公开浏览，因此第一期直接做 **站点级公开偏好**。只有未来出现多用户登录、私有收藏、行为反馈或“我的速览”诉求时，才需要另起行为个性化阶段。

优化后的路线判断：

- **一期先做可用性，不做智能化大工程**：先解决“每天 300 条里先看什么”，把入口、单日语义、排序、卡片密度、分页和站点级偏好跑通。
- **二期补表达可信度，而不是先建设完整知识图谱**：事件卡片需要更好的 `发生了什么 / 为什么重要 / 最新变化`，但不需要先做完整实体体系和 claim-level 证据链；二期只补轻量实体识别、来源证据锚点和 brief 输入快照。
- **三期再把日报做深**：日报不再重新从全部内容里判断重点，而是复用速览 Top 事件和二期 brief，再通过外部证据检索补背景、影响和不确定性。
- **四期再处理博客和观点**：技术博客、新观点、教程和研究笔记不要混进事件排序；它们需要独立内容类型、`insightScore` 和观点卡片。
- **个性化不单独提前排期**：当前需求本质是“主理人公开精选视角”，站点级偏好已经覆盖主要口味差异；多用户行为个性化会增加登录、隐私、缓存和解释复杂度，暂不进入近期主线。

### 页面信息架构

页面只回答一个问题：

> 这一天最值得优先了解的事件有哪些？

首屏不做复杂 dashboard，不做多区块看板，不做并列的“多源确认 / 最新进展”内容区。`多源确认`、`最新进展` 保留为排序信号和轻量快速筛选入口，避免用户只能从完整列表里肉眼找。

一期顶部只保留：

- 日期选择 + `查看`。
- 紧凑筛选：`重点事件 / 最新进展 / 多源确认`，并在筛选入口显示计数。默认是 `重点事件`，表示按重要性排序后的完整事件速览；`最新进展` 只展示跨日期事件在当天有新增内容的条目；`多源确认` 只展示来源数达到多源阈值的条目。

页面结构：

```text
Header

事件速览
快速筛选：重点事件 N / 最新进展 U / 多源确认 M
日期选择 / 查看

重点事件
- 事件卡片
- 事件卡片
- 事件卡片
...

分页 / 加载更多
```

### 重点事件定义

重点事件是：

> 当前日期内有新增内容、可公开展示，并按 `rankScore` 排序后优先展示的事件。

它不是所有事件，也不是所有多源事件。`多源确认`、`有新进展`、`高质量分` 等主要作为排序信号和筛选计数来源；当前列表卡片只展示必要状态和指标，降低阅读负担。

筛选语义：

- `重点事件`：默认视图。展示当天所有达到 `minRankScore` 的候选，并按 `rankScore` 排序。
- `最新进展`：候选为跨日期 cluster，且选定日期内有新增 item。
- `多源确认`：候选来源数达到多源阈值；一期阈值为 `sourceCount >= 2`。

筛选只影响列表和分页总数；快速筛选上的计数保留全量视角。

第一期重点事件来源：

- active `ContentCluster`，且 cluster 内至少有一条 item 的 `createdAt` 落在当天。
- 未聚合的 single item，且 item `createdAt` 落在当天。
- 排除过滤、隐藏、聚合父项和不可公开内容。
- 当某个聚合事件已经展示时，不再把其下子条目或聚合拆分 child 作为 single 重复展示。

### 卡片信息密度

分页数量由页面分页参数控制，因此卡片必须比当前普通 Feed 卡更紧凑。每张卡片保持统一规格，不通过大卡、小卡做重要程度层级；重要性只通过排序体现。

当前事件卡片字段：

- 标题：优先 cluster title / display title。
- 状态标签：标题右侧显示 `新事件` 或 `新进展`，帮助读者快速判断这是当天首次出现还是跨日期事件更新。
- 指标行：来源数、条目数、最近更新时间。
- 点击标题打开事件详情弹窗。

卡片不默认展示完整来源列表、完整时间线、长摘要、入选原因或原文片段。一期 DTO 只保留当前 UI 和排序需要的字段；`whatHappened`、`whyItMatters`、证据解释等表达增强字段留到二期 `EventBrief`。

### Phase 4 Preview: Opinion and Blog Briefing

四期在同一个 `速览` 入口下增加 **观点速览**，用于处理技术博客、工程实践、观点文章、教程、研究笔记等非事件型内容。

核心区别：

- `事件速览` 回答：今天发生了哪些重要事件？
- `观点速览` 回答：今天有哪些值得读的高质量文章、新观点和技术洞察？

不要把技术博客硬塞进事件模型。很多技术博客不是事件，而是解释、经验、观点、教程或研究笔记；它们需要独立的内容类型识别、评分和卡片表达。

四期页面形态：

```text
速览
[事件] [观点]

观点速览
2026-06-30    上一天 / 日期选择 / 下一天 / 今天

当日采集 300 条内容，识别出 42 篇长文/观点，优先展示 20 篇。

高质量观点
[观点卡片]
[观点卡片]
...
```

建议观点卡片字段：

- 标题。
- 内容类型 badge：`技术博客`、`新观点`、`教程`、`研究笔记`、`工程实践` 等。
- 核心观点：作者主要观点或结论。
- 值得读的原因：技术细节充分、反常识判断、一手实践、实验数据、架构经验等。
- 适合关注：从 tags/source group 派生的技术方向。
- 来源和作者。
- 预计阅读时间。
- 入选原因：长文质量高、原创观点、技术深度、来自高质量来源等。

建议新增内容类型：

```text
contentKind:
- event_news
- technical_blog
- opinion
- tutorial
- research_note
- release_note
- roundup
- other
```

`event_news` 进入事件速览候选；`technical_blog`、`opinion`、`tutorial`、`research_note` 优先进入观点速览候选；`release_note` 可按内容判断进入事件或观点；`roundup` 通常不直接进入观点速览，除非 AI 识别出高价值观点。

观点排序不要复用 `rankScore`，应新增 `insightScore`：

```text
insightScore =
  qualityBase
  + technicalDepthBoost
  + noveltyBoost
  + originalityBoost
  + sourceQualityBoost
  + structureBoost
  + recencyBoost
```

信号定义：

- `technicalDepthBoost`：是否包含代码、架构、实验、数据、详细工程过程。
- `noveltyBoost`：是否提出新观点、反常识判断或新的实践经验。
- `originalityBoost`：是否原创，非转载、非浅层新闻、非营销稿。
- `sourceQualityBoost`：来源和作者历史质量。
- `structureBoost`：内容是否结构完整，有清晰结论、步骤或案例。
- `recencyBoost`：当天新增内容轻微加分。

四期更依赖 AI。建议新增异步 `ArticleInsightBrief`：

```prisma
model ArticleInsightBrief {
  id                 String   @id @default(cuid())
  itemId             String
  inputHash          String
  modelName          String?
  status             String   @default("pending")
  contentKind        String
  coreClaim          String?
  whyWorthReading    String?
  technicalDepth     Int      @default(0)
  novelty            Int      @default(0)
  targetAudience     String?
  readingTimeMinutes Int?
  insightReasonsJson String   @default("[]")
  errorMessage       String?
  generatedAt        DateTime?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@unique([itemId, inputHash])
  @@index([status, updatedAt])
  @@index([contentKind])
  @@map("article_insight_briefs")
}
```

触发策略：

- ingestion 成功后，先用规则筛出当天疑似长文/博客/观点候选。
- 只对 Top configurable M 候选 enqueue `article_insight_brief_generate`。
- 不在页面访问时同步生成。
- 不补历史日期，除非后续增加管理员手动重跑。

四期配置建议：

- `defaultInsightLimit`：观点速览默认展示数量，建议初始 20。
- `maxInsightLimit`：单页最大展示数量。
- `minContentLengthForInsight`：观点候选最小正文长度。
- `contentKindWeightsJson`：观点速览内容类型权重，可复用站点级偏好配置或在四期扩展偏好模型。

四期不改变：

- Header 不新增新的主导航，仍使用 `速览`。
- 事件速览和观点速览不合并排序。
- 日报三期仍以事件主题为主；是否把观点速览纳入日报是后续独立决策。

### Phase 1 Delivery Boundary

第一期只交付能真正减少阅读时间的最小闭环：

- 必做：`/events` 公开列表页、单日日期选择、快速筛选、紧凑事件卡片、分页、Header `速览` nav、站点级偏好配置、规则排序、缓存失效和基础测试。
- 可选：公开 JSON API。若第一版完全 RSC 渲染且分页用链接完成，可以不新增 `/api/events`。
- 延后：`/events/[entryId]` 独立详情页、时间线、AI brief、外部证据、日报改造、观点速览、行为个性化。第一期使用弹窗详情承载完整摘要和聚合子条目展开。

这个边界的好处是：第一期不会变成“新日报 + 新详情页 + 新 AI pipeline”的大工程，但已经能解决“300 条里先看什么”的核心问题。

### Phase 1 Runtime Acceptance

截至 2026-07-03，本地 Docker 运行态按当前实现验收：

- `app` 和 `worker` 容器正常运行，`http://localhost:3001/events` 返回 200。
- 默认日期为当天；页面展示单日事件速览、快速筛选、日期选择和主页式分页。
- 列表卡片只展示编号、标题、`新事件 / 新进展`、来源数、条目数和更新时间，不展示长摘要、入选原因或来源预览。
- 点击标题打开弹窗详情；single 事件只展示事件摘要和外链，cluster 事件的子条目默认折叠，展开按钮文案为 `N 条`。
- `2026-07-02` 样例数据下分页文案为 `每页显示 30 条，共 59 条`，跳转页码和 `30 / 50 / 100` 分页数量切换可用，并保留 `date`、`view`、`size` query。
- HTTP 响应仍由 Next 动态渲染输出 `no-store`，一期接受服务层 `EventBriefingCache` 作为主要缓存机制。

## Proposed Design

### Components and Responsibilities

`src/app/events/page.tsx`

- 新增公开事件速览页面。
- 解析 `date`、`view`、`page`、`size` query。
- 获取公开 header links。
- 调用事件速览服务读取数据。
- 使用 `PageShell` 保持和 `/daily` 风格一致。
- 输出 CollectionPage JSON-LD。

`src/components/events/event-briefing-list.tsx`

- 客户端或服务端友好的列表组件。
- 渲染日期选择、快速筛选、重点事件列表、分页。
- 保持卡片统一规格和紧凑密度。

`src/components/events/event-briefing-card.tsx`

- 渲染单个事件卡片。
- 只展示高密度标题、状态标签和指标；不在列表中展示长摘要、入选原因或来源预览。
- 支持 cluster 和 single item 两类 DTO。

`src/lib/events/service.ts`

- 事件速览主服务。
- 解析日期窗口。
- 调用 repository 获取候选。
- 计算 `baseRankScore`、站点级 `curatorBoost/curatorPenalty` 和最终 `rankScore`。
- 应用 `minRankScore`、快速筛选、最大分页大小和排序。
- 按日期和视图缓存完整排序结果，翻页时只做内存切片，避免每次翻页重复查库和重算。

`src/lib/events/preferences.ts`

- 读取和规范化站点级速览偏好。
- 根据 tags、source group、关键词/实体、source、event type 计算 `curatorBoost` 和 `curatorPenalty`。
- 生成 `加权命中`、`降权命中` 等可解释原因。

`src/lib/events/repository.ts`

- 负责 Prisma 查询。
- 查询当天新增 item 和对应 cluster。
- 聚合 cluster 的当天新增数、来源数、代表 item、最新更新时间。
- 排除聚合父项；当聚合事件已展示时，抑制其下 child single 重复展示。
- 返回 service 所需的原始候选数据，不直接输出 UI DTO。

`src/lib/events/types.ts`

- 定义 `EventBriefingOptions`、`EventBriefingDTO`、`EventBriefingEntryDTO` 等稳定类型。

`src/lib/settings/service.ts` / `src/components/admin/admin-settings-panel.tsx`

- 增加事件速览配置和偏好配置读取/保存。
- 配置项进入后台配置页，建议放在“任务配置”或“内容配置”下的新小节 `速览配置`。

`src/components/ui/global-header.tsx`

- `activeNav` 增加 `events`。
- `navItems` 增加 `{ href: "/events", key: "events", label: "速览" }`。

### Configuration Contract

新增数据库配置模型，避免把卡片密度和排序阈值写死。分页数量属于公开页查询参数，不进入后台配置页。

建议 Prisma model：

```prisma
model EventBriefingConfig {
  id           String   @id @default(cuid())
  minRankScore Int      @default(0)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@map("event_briefing_configs")
}
```

站点级主理人偏好单独建模，避免把卡片展示配置和偏好规则混在一起：

```prisma
model BriefingPreferenceConfig {
  id                String   @id @default(cuid())
  weightedRulesJson String   @default("[]")
  maxCuratorBoost   Int      @default(15)
  maxCuratorPenalty Int      @default(20)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@map("briefing_preference_configs")
}
```

配置规则：

- `minRankScore`：可选过滤阈值，默认 0 表示只按排序和分页展示。
- `weightedRulesJson`：事件偏好规则列表，元素为 `{ type, value, weight }`；`type` 支持 `tag`、`keyword`、`source_group`、`event_type`；`weight` 支持正负，正数加权、负数降权。
- `maxCuratorBoost` / `maxCuratorPenalty`：控制偏好影响上限，避免把全局重要性完全覆盖。

事件类型固定集合来自 AI 分析 prompt：`release`、`launch`、`update`、`funding`、`acquisition`、`partnership`、`policy`、`research`、`security`、`other`。

后台校验：

- `maxCuratorBoost` 范围建议 `0-30`，默认 15。
- `maxCuratorPenalty` 范围建议 `0-50`，默认 20。

### API and Query Contract

第一期可以仅使用 RSC 直读服务，不一定新增公开 JSON API。若组件需要客户端分页，则新增：

```http
GET /api/events?date=2026-06-30&page=1&size=30&view=updates
```

Query：

| Parameter | Type | Default | Notes |
|---|---:|---:|---|
| `date` | `YYYY-MM-DD` | 今天 | 按站点时区计算当天入库窗口。 |
| `view` | `important \| updates \| multi-source` | `important` | 快速筛选视图。`important` 为默认重点排序；`updates` 为最新进展；`multi-source` 为多源确认。 |
| `page` | integer | 1 | 从 1 开始。 |
| `size` | integer | 30 | 每页事件数量，参考主页分页设计，当前可选 30 / 50 / 100。 |

Response DTO：

```json
{
  "date": "2026-06-30",
  "view": "important",
  "generatedAt": "2026-06-30T14:32:00.000Z",
  "summary": {
    "eventCount": 96,
    "multiSourceCount": 18,
    "updatedEventCount": 11
  },
  "pagination": {
    "page": 1,
    "pageSize": 30,
    "total": 96,
    "totalPages": 4
  },
  "entries": [
    {
      "id": "cluster_123",
      "type": "cluster",
      "title": "OpenAI 发布新的 Agent 工具链能力",
      "summary": "OpenAI 更新了面向开发者的 Agent 工具链...",
      "rankScore": 91,
      "baseRankScore": 82,
      "curatorBoost": 9,
      "curatorPenalty": 0,
      "isFollowUp": true,
      "sourceCount": 5,
      "itemCount": 12,
      "latestCreatedAt": "2026-06-30T13:50:00.000Z",
      "latestPublishedAt": "2026-06-30T13:10:00.000Z",
      "detailHref": "/?entryKeys=cluster%3Acluster_123"
    }
  ]
}
```

### Attention Score and Curator Preference

第一期使用规则分，不新增同步 AI。

主页 Feed 的评分回归内容质量本身，事件速览单独使用事件级 `rankScore`（当前 DTO 字段仍可沿用 `rankScore`）。第一期规则排序如下：

```text
baseRankScore =
  round(qualityScore * 0.7)
  + evidenceScore
  + momentumScore

rankScore =
  clamp(
    baseRankScore
    + min(curatorBoost, maxCuratorBoost)
    - min(curatorPenalty, maxCuratorPenalty),
    0,
    100
  )
```

信号定义：

- `qualityScore`：cluster 优先使用现有 display/aggregate quality score；single item 使用 item `qualityScore`。
- `evidenceScore`：来源数和条目数带来的证据强度，上限 15。
- `momentumScore`：跨日期事件有新进展加 8；当日新事件加 3。
- 不使用“当天越新越靠前”的加分，时间只作为最终同分排序兜底。
- 事件类型没有内置预设加分；如需强调 `security`、`policy` 等，必须通过后台 `weightedRulesJson` 配置。
- `curatorBoost` / `curatorPenalty`：命中站点规则列表时按规则权重加减，最终仍受 `maxCuratorBoost` / `maxCuratorPenalty` 限制。

主理人偏好原则：

- 偏好只做加权，不做硬过滤。
- 加权有上限，不能让偏好完全覆盖全局重要性。
- 公开页面显示同一套排序结果，不按访客变化。
- 第一版不使用点击、停留、保存、不感兴趣等行为信号。

未来如果要做行为个性化，可另建 `我的速览` 或登录后个人模式，不进入第一期公开速览。

### Status and Display Policy

第一期公开列表不展示完整排序解释或 badge 列表，避免卡片信息过载。服务层只保留当前 UI 和筛选需要的状态字段：

- `isFollowUp`：cluster 早于当天存在，且当天新增 item，用于展示 `新进展` 和 `最新进展` 快速筛选。
- `sourceCount >= 2`：用于 `多源确认` 快速筛选。

当前列表只展示 `新事件 / 新进展` 状态标签，以及来源数、条目数、更新时间。排序解释和证据表达放到二期 `EventBrief`，不在一期 DTO 中保留未使用字段。

### Date Semantics

事件速览日期采用 `items.createdAt` 的站点日边界：

- 默认日期为站点当前日期。
- 查询窗口为 `[dateStart, dateEnd)`。
- `dateStart/dateEnd` 使用和 Feed 当天语义一致的时区边界。
- 页面文案使用“当日采集 / 当日入库”，避免与原文 `publishedAt` 混淆。
- 日期窗口只决定事件是否进入当天速览，不截断事件上下文。
- 跨日期 cluster 只要当天有新增 item 就可以入选；卡片可使用完整 cluster 摘要、总来源数、总条目数，同时突出当天新增条目数和最新变化。
- 对跨日期 cluster，`有新进展` 表示 cluster 早于当天已经存在，且当天有新增 item。

### Detail Modal

第一期不新增独立 `/events/[entryId]` 详情页，列表标题点击打开弹窗详情。

```text
事件详情弹窗
```

弹窗展示：

- 事件总览。
- 完整摘要，支持 Markdown inline 渲染。
- 单篇事件不再重复展示原条目。
- 聚合事件默认折叠原始内容，只显示 `N 条` 展开入口；展开后展示相关子条目、来源、发表时间和原文链接。

独立详情页、时间线和证据链仍延后到二期或更后。

### Phase 2 AI Brief

二期可以接入 AI 作为异步表达增强层，用于提高卡片和详情的信息密度，但不能成为页面可用性的前置条件。

AI 负责生成结构化 brief：

- `whatHappened`：发生了什么，一句话。
- `whyItMatters`：为什么重要，一句话。
- `latestChange`：当天新增内容带来的最新变化，可为空。
- `entities`：轻量实体列表，例如公司、产品、人物、组织、项目、漏洞编号；只用于解释和检索，不在二期做完整实体库。
- `evidenceItems`：证据锚点列表，记录 brief 中关键判断来自哪些站内 item/source。
- `evidenceSummary`：来源依据摘要，可用于详情页。
- `timeline`：事件详情页使用的 3-5 个关键节点，二期后段再启用。

AI 不负责第一期核心排序。`rankScore` 仍以规则为主；AI 输出只用于更好的表达、解释和详情展示。

二期的证据边界：

- 做 **轻量证据锚点**，不做完整 claim graph。
- 证据锚点只引用站内已采集 item、source、publishedAt/createdAt 和摘要片段。
- 每条关键判断最多挂 1-3 个证据来源，避免卡片和详情页信息过载。
- 实体识别先作为 `EventBrief` 的派生字段保存，不先独立建 `Entity` 表；只有后续需要跨事件追踪、实体页或实体订阅时再升级为实体体系。
- AI brief 的每个结论都应能回退到输入 source；无法定位依据的判断要么降级为“不确定”，要么不输出。

建议新增缓存表：

```prisma
model EventBrief {
  id                String   @id @default(cuid())
  entryType         String
  entryId           String
  inputHash         String
  modelName         String?
  status            String   @default("pending")
  whatHappened      String?
  whyItMatters      String?
  latestChange      String?
  entitiesJson      String   @default("[]")
  evidenceItemsJson String   @default("[]")
  evidenceSummary   String?
  timelineJson      String?
  errorMessage      String?
  generatedAt       DateTime?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([entryType, entryId, inputHash])
  @@index([entryType, entryId])
  @@index([status, updatedAt])
  @@map("event_briefs")
}
```

`entryType` 第一版取值为 `cluster` 或 `single`。`inputHash` 由 entry 的标题、摘要、来源列表、item ids、latest item timestamp 和用于 brief 的正文/摘要片段生成；内容变化后允许重新生成。

任务类型：

```text
event_brief_generate
```

触发时机只设计一种：

```text
ingestion succeeded
  -> invalidate event briefing cache
  -> compute today's top configurable N events
  -> enqueue missing or stale event_brief_generate jobs
```

二期明确不做：

- 不做每 30 分钟或其他定时兜底。
- 不在用户访问 `/events` 时同步生成 brief。
- 不为历史日期主动补 brief。
- 不全量为当天所有 item 生成 brief，只对当天 Top N 重点事件生成。

页面读取策略：

- 如果 `EventBrief.status="succeeded"` 且 `inputHash` 匹配，优先展示 AI brief。
- 如果 brief 缺失、失败或过期，展示规则 fallback。
- AI 失败不能影响事件速览页面渲染。

输出质量校验：

- JSON 必须可解析。
- `whatHappened`、`whyItMatters` 不得为空。
- 单字段长度需要限制，避免卡片膨胀。
- 拒绝近似原文的大段复制。
- `evidenceItems` 只能引用 brief 输入中的 item/source，不能生成不存在的来源。
- `entities` 数量需要限制，第一版建议最多 8 个，避免把 brief 变成实体抽取任务。
- 对无法从站内输入确认的外部背景，不在二期 brief 中展开；三期日报外部证据检索再处理。
- 失败原因写入 `errorMessage`，任务状态进入现有 task monitor。

## Data and State

### Candidate Selection

候选集合：

1. 当天新增且可展示的 items。
2. 对有 `clusterId` 的 item 按 active cluster 分组。
3. 对无 `clusterId` 的 item 作为 single event。
4. 排除：
   - `status != "processed"`
   - `moderationStatus` 不在公开可展示状态内
   - `isAggregation = true`
   - cluster `status != "active"`

推荐 repository 使用两段式查询：

1. 先按当天 `items.createdAt` 找到候选 item 和 candidate cluster ids，控制扫描范围。
2. 再批量读取这些 candidate cluster 的公开可展示成员，用于计算完整 `sourceCount`、`itemCount`、代表 item、来源预览和 cluster 上下文。

这样既保持“按当天进入速览”的语义，又不会把跨日期 cluster 的上下文截断成当天片段。

cluster 统计：

- `sourceCount`：不同 source 数。
- `itemCount`：cluster 下可展示 item 总数或 display item count。
- `newItemCountOnDate`：当天新增 item 数。
- `newSourceCountOnDate`：当天新增来源数。
- `latestCreatedAt`：cluster 下最新入库时间。
- `latestPublishedAt`：cluster 下最新发布时间。
- `representativeItem`：质量分高、时间新的代表 item，用于来源和摘要 fallback。
- `isFollowUp`：cluster 首次创建早于当天且当天有新增 item，用于 `有新进展` badge。

### Caching

事件速览是公开页面，应该缓存：

- RSC page `revalidate` 可初始设为 60-300 秒。
- 如新增 API，返回可使用短 TTL cache。
- 后端写入影响公开 feed 时已有 `invalidateFeedCache()` 要求；事件速览应新增独立 `invalidateEventBriefingCache()` 或共用内容变更后的统一 public cache invalidation hook。

### Admin Configuration State

`EventBriefingConfig` 单例配置：

- 初始化由 `db:setup` 或 settings service ensure 方法创建。
- 后台保存配置后应使事件速览缓存失效。
- 配置读取失败时使用安全默认值。

`BriefingPreferenceConfig` 单例配置：

- 初始化由 `db:setup` 或 settings service ensure 方法创建。
- 后台保存后应使事件速览缓存失效。
- JSON 字段解析失败时使用空偏好，并记录配置错误。
- 配置 UI 应明确这是“事件偏好”，不是个人隐私画像。

### Phase 3 Daily Report Deepening

三期调整日报生成逻辑，让日报从“候选事件摘要”升级为“基于事件速览的深度简报”。核心边界：

- 事件速览负责选择层：哪些事件重要、为什么进入当天重点。
- AI brief 负责表达层：事件级 `发生了什么 / 为什么重要 / 最新变化 / 来源依据`。
- 日报负责分析层：主题归纳、事件关系、影响分析、后续观察和不确定性。

三期目标：

- 日报候选来源迁移到 `EventBriefingService`，复用当天 Top N 重点事件、`rankScore` 和入选原因。
- 日报生成输入优先使用二期 `EventBrief`，减少从大量 item 摘要中重新判断重点。
- 日报正文不再只是复述事件列表，而是提炼 3-5 个主题。
- 每个主题下组织相关事件，说明事件之间的关系、影响和后续观察点。
- 保留重点事件附录，方便从深度分析回溯到结构化事件列表。

建议三期日报结构：

```text
今日判断
- 今天最重要的 2-3 个变化是什么。

核心主题
- 主题 A
  - 相关事件
  - 发生了什么
  - 为什么重要
  - 影响分析
  - 后续观察

- 主题 B
  ...

风险与不确定性
- 单一来源、尚未官方确认、影响范围不明确的事项。

重点事件附录
- 来自当天事件速览的 Top events。
```

三期不改变：

- `/daily` 的发布、归档、RSS、导出和 admin 审核流程。
- 日报仍按日期归档。
- 日报仍可独立访问；事件速览只是候选和上下文来源。

三期需要新增或调整：

- Daily report candidate 读取改为从 `src/lib/events/service.ts` 获取事件候选。
- Daily report prompt 新增主题归纳、影响分析、后续观察和不确定性要求。
- Daily report validation 增加主题结构、引用事件覆盖率、附录完整性检查。
- Daily report source records 需要能关联 event entry，包括 cluster 和 single item。

#### Daily Report Research Evidence

三期可以增加 **外部证据补充**，用于让日报的主题分析不止停留在站内事件表面。该能力只服务日报深度化，不进入事件速览排序，也不在页面访问时触发。

外部证据补充的目标：

- 为日报核心主题补充官方公告、产品文档、论文、CVE、GitHub release、监管公告、公司博客和高质量媒体等外部材料。
- 帮助日报回答背景、影响、趋势、风险和不确定性。
- 为关键判断提供可追溯来源链接。

范围控制：

- 只对日报归纳出的 3-5 个核心主题执行，不对事件速览 Top N 的每个事件执行。
- 每个主题最多保留 3-5 条外部证据。
- 每份日报最多使用 15-20 条外部证据。
- 搜索失败或抓取失败时，日报退回站内事件和 `EventBrief`，不能阻断生成。
- 外部证据必须缓存，不允许日报生成过程中反复无缓存搜索相同主题。

建议流程：

```text
event briefing Top N
  -> generate daily report topics
  -> generate 2-4 research queries per topic
  -> external search provider
  -> fetch and clean candidate pages
  -> dedupe and score evidence sources
  -> build evidence pack
  -> generate deep daily report
```

Search provider adapter：

```ts
type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  sourceName?: string;
  publishedAt?: string | null;
};

type ExternalSearchProvider = {
  search(query: string, options: {
    limit: number;
    language?: string;
    freshnessDays?: number;
    domains?: string[];
  }): Promise<SearchResult[]>;
};
```

第一版只需要实现一个 provider，但接口必须隔离具体供应商，便于后续从 Brave Search、Bing、SerpAPI、Tavily 或其他 provider 切换。

Evidence fetcher：

- 只允许 `http` / `https` URL。
- 抓取正文并清洗为可引用文本。
- 每篇正文截断到配置上限，例如 4k-8k 字符。
- 排除登录页、404、明显转载聚合页、低质量 SEO 页面和重复内容。
- 可复用现有全文抽取思路，但代码应放在 research/evidence 边界，不混入 RSS ingestion。

建议数据模型：

```prisma
model ExternalEvidenceRun {
  id           String   @id @default(cuid())
  dailyDate    String
  topicKey     String
  queryJson    String
  status       String   @default("pending")
  errorMessage String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  sources      ExternalEvidenceSource[]

  @@index([dailyDate, topicKey])
  @@index([status, updatedAt])
  @@map("external_evidence_runs")
}

model ExternalEvidenceSource {
  id            String              @id @default(cuid())
  runId         String
  topicKey      String
  title         String
  url           String
  sourceName    String?
  snippet       String?
  extractedText String?
  contentHash   String
  qualityScore  Int                 @default(50)
  usedInReport  Boolean             @default(false)
  createdAt     DateTime            @default(now())
  run           ExternalEvidenceRun @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@unique([topicKey, url])
  @@index([runId])
  @@index([topicKey])
  @@map("external_evidence_sources")
}
```

质量排序优先级：

1. 官方公告、产品文档、监管公告、论文、CVE、GitHub release。
2. 高质量专业媒体。
3. 公司博客、工程博客。
4. 社区讨论只能作为补充，不作为主证据。
5. SEO 聚合页、转载站、低质量营销页降权或丢弃。

日报 prompt 约束：

- 只能基于站内事件、`EventBrief` 和 evidence pack 做判断。
- 重要结论应能对应到站内事件或外部证据来源。
- 对证据不足的地方明确标注不确定性。
- 不把外部搜索结果当作事实核查的万能结论。
- 输出中保留来源链接或 source key，便于详情页和 Markdown 导出追溯。

任务边界：

- 外部证据检索作为 `daily_report_generate` 三期流程的一段，或拆出 `daily_report_research_evidence` 子任务。
- 不在 `/events` 或 `/daily` 页面访问时触发。
- 不对历史日报主动补研究证据，除非管理员手动重新生成日报。

## UI Design

### Layout

复用现有 `PageShell` 和 `GlobalHeader`：

```text
Header

事件速览
重点事件 N / 最新进展 U / 多源确认 M      日期选择 / 查看

重点事件
#01  OpenAI 发布新的 Agent 工具链能力        5 来源 12 条 13:50 更新
#02  Anthropic 发布 Claude 新模型            2 来源  2 条 17:23 更新
#03  ...

每页显示 50 条，共 96 条          上一页 / 第 1 / 2 页 / 下一页 / 跳转
```

设计原则：

- 不做 dashboard 指标墙。
- 不做左侧筛选 + 右侧列表，避免它更像普通 Feed。
- 不做 Top 5 / 更多重点事件分区。
- 不做视觉层级突出前几条；重要性只由排序体现。
- 所有卡片同一规格，便于快速扫读。
- 移动端单列；桌面也以单列或紧凑双列评估，但第一期优先单列以保持日报和主页阅读连续性。
- 第一期不展示 `事件 / 观点` 二级视图；四期观点速览上线时再增加二级视图，并复用相同页面壳和日期切换。

### Card Density

卡片应比 Feed 卡更短，优先让用户快速扫标题和基础指标：

- 标题最多 2 行。
- 编号和标题间距收窄，减少视觉空隙。
- 状态标签跟随标题，显示 `新事件` 或 `新进展`。
- 右侧指标行保持一行内尽量展示，换行后仍不超过 2 行。
- 列表不展示摘要、入选原因、来源预览或说明性前缀。

卡片示例：

```text
#01  OpenAI 发布新的 Agent 工具链能力  [新进展]     5 来源 12 条 13:50 更新
```

## Quality Attributes

### Performance

- 每页数量来自页面分页参数，当前选项为 30 / 50 / 100；公开查询必须分页。
- repository 查询应避免 N+1。
- 对 cluster 统计优先使用已有 `displaySourceCount`、`displayItemCount`、`displayQualityScore`，必要时只对当天候选做批量统计。
- 页面不实时调用 AI。
- 大日期窗口不存在；只支持单日，避免任意范围导致查询膨胀。
- `rankScore` 需要站点偏好和规则计算，不能直接用数据库 `LIMIT/OFFSET` 做最终排序。当前按日期和 view 缓存完整排序结果，翻页只做内存切片；以每天约 300 条信息流规模，性能风险可控。
- 若后续单日候选达到上千到数千，或 `/events` 首屏明显变慢，应改为 ingestion 结束后预计算 `rankScore` 并落库，再对预计算结果做数据库分页。

### Reliability

- 配置缺失时使用默认值。
- 偏好配置缺失、JSON 损坏或引用不存在的 source/tag/group 时，忽略对应规则并继续使用全局排序。
- 某个 cluster 摘要为空时 fallback 到代表 item summary。
- 当天无内容时显示空状态，并给出返回最近有内容日期或查看主页的入口。

### Security and Privacy

- 页面公开展示，只能输出公开可展示内容。
- 后台配置保存需要 admin session。
- 站点级偏好是公开排序规则的一部分，不包含访客个人数据。
- 不输出 filtered item、隐藏 cluster、后台复核状态或内部错误。
- 不暴露 prompt、模型响应原文、task error details。

### Accessibility

- 日期切换和分页使用可访问按钮/链接。
- 卡片 badge 不依赖颜色表达全部含义。
- 标题层级保持 `h1 -> h2 -> h3`。
- 点击整卡时仍保留可聚焦的显式链接。

### SEO

- `/events` 可索引。
- 如果后续支持 `/events/YYYY-MM-DD`，每日归档页可索引。
- query 版本 `/events?date=...` 需要 canonical 策略，避免重复索引。
- JSON-LD 使用 `CollectionPage` + `ItemList`。

### Observability

- 记录页面生成时的候选数、展示数、查询耗时。
- 后台配置保存记录 admin 操作结果。
- 如新增 API，返回错误需区分参数错误、配置错误和内部错误。

## Compatibility, Migration, and Rollback

### Migration

- 新增 `EventBriefingConfig` 表。
- 新增 `BriefingPreferenceConfig` 表。
- `scripts/setup-sqlite.mjs` 需要初始化默认配置。
- Prisma migration 只从 `schema.prisma` 生成，不手写业务 SQL。

### Compatibility

- `/` feed 的展示评分回归 `qualityScore`，不要复用事件排序分。
- 不改变 `/daily` 报告生成逻辑。
- 不改变 feed time filtering 的 `items.createdAt` 语义。
- 不改变 cluster assignment 和 merge pipeline。
- 三期前不改变 `/daily` 的候选、生成、发布和归档流程。

### Rollback

- 如果页面出现性能或质量问题，可从 header 移除 `速览` nav，保留后端表不影响现有功能。
- 配置表可保留，后续再启用。
- 不应引入会破坏现有 feed/daily 的 shared DTO 变更。

## Testing and Verification

Unit tests:

- `baseRankScore` / `rankScore` 计算：质量分、证据强度、新进展、站点规则加减权。
- `curatorBoost/curatorPenalty` 计算：标签、来源组、关键词、事件类型规则、上限 clamp。
- 日期窗口：使用 `createdAt` 和站点日边界。
- 配置 normalization：默认值、范围限制、非法输入。

Integration tests:

- 事件速览 repository 正确聚合 cluster 和 single item。
- 过滤不可公开内容。
- 分页和配置数量生效。
- 站点偏好配置影响排序但不硬过滤内容。
- 后台配置 API 保存后可读取。
- Header nav active state 正确。

Component tests:

- `EventBriefingList` 渲染顶部概览、日期查询、分页数量切换、事件列表和空状态。
- `EventBriefingCard` 在长标题、长来源名、缺少摘要、多个 badge 时不溢出。
- 移动端布局不重叠。

Validation commands:

```bash
npx tsc --noEmit
npm run lint
vitest run tests/unit/event-briefing*.test.ts
vitest run tests/integration/event-briefing*.test.ts
vitest run tests/components/event-briefing*.test.tsx
npm run build
```

如果实现改动包含视觉布局，需补浏览器检查桌面和移动端截图。

## Tradeoffs and Alternatives

### Alternative A: 事件看板 + 多区块 dashboard

优点：更像传统“看板”，可以展示多源确认、最新进展、高优先级等多个区块。

缺点：页面信息过多，事件重复出现，用户需要理解多个分区，违背“少花时间获得重点”的目标。

结论：不采用。

### Alternative B: 时间范围筛选

优点：灵活，可以看 24 小时、3 天、7 天。

缺点：公开页面语义不如按日清晰；不利于归档、分享、SEO；不同范围下展示数量和重要性理解不稳定。

结论：第一期不采用。事件速览按单日工作。

### Alternative C: 固定 Top 20 / Top 30 或后台配置展示数量

优点：实现简单。

缺点：生产数据量会变化，且“每页展示多少”本质是分页参数，不应放进后台配置；否则和主页分页心智不一致。

结论：不采用。当前使用页面分页参数 `size`，选项为 30 / 50 / 100。

### Alternative D: 第一期开启 AI 事件 brief

优点：`发生了什么` 和 `为什么重要` 质量可能更高。

缺点：新增任务、缓存、失败处理和成本；会拖慢第一期交付。

结论：第一期使用已有摘要和规则 fallback。二期可添加异步 AI brief，但必须缓存，且只在 ingestion 成功后对当天 Top N 事件生成；不做定时兜底、不在页面访问时同步生成、不主动补历史日期。

### Alternative E: 一期同步改造日报

优点：事件速览和日报可以从一开始共享重点判断逻辑。

缺点：会把一期从公开速览页面扩展为日报生成链路改造，影响现有日报稳定性，也会扩大 AI prompt、validator、发布流程和归档兼容风险。

结论：不采用。一期不动日报，二期补事件级 AI brief，三期再基于事件速览和 brief 深化日报。

### Alternative F: 将偏好加权推迟到五期

优点：一期评分更纯粹，只有全局重要性，模型和配置更简单。

缺点：当前产品主要由站点主理人自己使用，完全客观的重点排序不一定符合真实阅读口味；后续再改会影响已形成的速览体验。

结论：不采用。第一期加入轻量站点级偏好加权，但不做多用户行为个性化。

### Alternative G: 独立建设多用户个性化

优点：可以根据不同访问者的兴趣输出不同速览。

缺点：当前页面面向公众浏览，且主要服务主理人自己使用；多用户画像会引入登录态、隐私、行为采集、解释一致性和缓存复杂度。

结论：不作为近期阶段。第一期的站点级偏好已经覆盖“更符合个人口味”的主要需求，且公开结果保持一致。

## Open Questions

- `官方来源` 是否已有可靠 source metadata 支撑？当前一期不展示，未来如补 source metadata 再考虑。
- 二期 AI brief 的 prompt 是否复用现有 cluster summary 模型配置，还是新增独立 `eventBrief` prompt config？
- 三期日报深度化是否保留当前日报模板兼容模式，还是直接切换到新结构？
- 四期观点速览的主 label 是否使用 `观点`、`深读` 还是 `博客`？本 TRD 推荐 `观点`，因为它覆盖博客、教程、研究笔记和新观点。
- `contentKind` 是直接落在 `Item` 上，还是放在 `ArticleInsightBrief` 中作为 AI 派生结果？四期实施前需要结合迁移成本决定。

## Execution Plan Inputs

建议实现切片：

1. 数据层：新增 `EventBriefingConfig`、`BriefingPreferenceConfig` schema、setup 初始化、settings service 读写。
2. Scoring 层：新增 `src/lib/events/*`，完成候选查询、日期窗口、base attention score、curator preference、DTO。
3. 页面层：新增 `/events` 页面、header nav、SEO metadata、JSON-LD。
4. UI 层：新增事件速览列表和紧凑卡片，复用现有 UI token。
5. 后台配置：在 admin settings 增加速览配置和站点偏好配置表单/API。
6. 验证：补单元、集成、组件测试，跑 typecheck、lint、build。

一期实施时建议显式排除：

- 不做事件详情页，除非列表卡片无法承载最低可用信息。
- 不做客户端复杂筛选和任意时间范围。
- 不做同步 AI、外部搜索、日报生成逻辑变更和历史数据回填。
- 不采集公众访问者行为。

二期 AI 切片：

1. 新增 `EventBrief` schema、repository、inputHash、轻量实体字段、证据锚点字段和质量校验。
2. 新增 `event_brief_generate` task kind、handler、AI provider 方法和 prompt config。
3. ingestion 成功后计算当天 Top N 并 enqueue 缺失/过期 brief 任务。
4. 事件速览 DTO 读取可用 brief，失败时保留规则 fallback。
5. 在 prompt 和 validator 中约束 `evidenceItems` 只能引用输入 item/source，避免无来源判断。
6. 补任务、AI 输出校验、缓存失效和页面 fallback 测试。

三期日报切片：

1. 将日报候选读取迁移到事件速览候选服务，保留旧逻辑作为兼容 fallback。
2. 调整日报 prompt 和 validator，输出 `今日判断 / 核心主题 / 风险与不确定性 / 重点事件附录`。
3. 复用 `EventBrief` 作为日报输入上下文，缺失时 fallback 到规则 DTO 和现有摘要。
4. 扩展 `DailyReportSource` 或 source snapshot，记录日报主题和事件 entry 的对应关系。
5. 增加外部证据补充：search provider adapter、evidence fetcher、evidence store、evidence pack DTO。
6. 将 evidence pack 接入日报生成 prompt，并在 validator 中检查来源追溯和不确定性表达。
7. 验证日报发布、归档、RSS、Markdown 导出和 admin 重新生成流程。

四期观点速览切片：

1. 新增内容类型识别：规则初筛 + AI `ArticleInsightBrief`，区分事件新闻、技术博客、观点、教程、研究笔记等。
2. 新增 `insightScore` 和观点入选原因生成逻辑，不复用事件 `rankScore`。
3. 新增 `ArticleInsightBrief` schema、task kind、AI provider 方法、prompt 和质量校验。
4. ingestion 成功后对当天疑似长文/观点候选 enqueue insight brief 任务。
5. `/events` 或 `/briefing` 页面增加 `事件 / 观点` 二级视图，Header 仍只保留 `速览`。
6. 新增观点卡片组件，展示核心观点、值得读原因、目标读者、阅读时间和入选原因。
7. 补充观点速览 repository、service、component 和任务测试。

主要风险：

- cluster 统计查询如果写得过重，会影响公开页性能。
- 卡片信息密度过高可能导致移动端溢出，需要组件测试和截图验证。
- 如果 DTO 复用 feed DTO 过多，可能把 Feed 语义和事件速览语义耦合；建议单独建 `src/lib/events/types.ts`。
- 站点级偏好如果权重过高会变成窄化信息来源，必须保留全局重要性基线和 boost/penalty 上限。
- 三期外部证据检索可能引入成本、延迟和来源质量风险，必须限制主题数、来源数并缓存结果。
- 四期观点速览如果内容类型识别不准，会把普通新闻或营销稿误判为观点，需要 AI 质量校验和来源/长度/结构规则兜底。
