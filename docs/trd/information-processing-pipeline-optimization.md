---
id: trd-information-processing-pipeline-optimization
type: trd
status: draft
created_at: 2026-07-11
updated_at: 2026-07-11
sources:
  - AGENTS.md
  - prisma/schema.prisma
  - src/lib/ingestion/item-processor.ts
  - src/lib/items/service.ts
  - src/lib/ai/provider.ts
  - src/lib/clusters/service.ts
  - src/lib/events/repository.ts
  - src/lib/events/service.ts
  - src/lib/daily-report/quality.ts
related: []
---

# TRD: 信息处理链质量优化

## 背景和目标

Infinitum 已具备 RSS 采集、正文补抓、规则过滤、AI 摘要与分析、聚合内容拆分、事件归组、事件速览和 AI 日报能力。当前处理链能够显著压缩原始文章数量，但在“从文章得到可靠认知结果”这一层仍有三类高收益问题：

1. 条目摘要、内容分析和聚合拆分最多会串行调用模型并重复理解同一内容；内容分析还优先使用已经压缩过的摘要，摘要遗漏会继续影响质量评分、标签、事件签名和聚类。
2. cluster 更新时只重算事件整体摘要，没有单独表达“本次新增了什么”。
3. 事件排序把来源数和条目数近似当成证据强度，未区分独立来源与转载，也未控制 Top N 结果集合的主题重复。

本方案目标是在不改变公开 Feed 时间语义、不引入知识图谱或 claim-level 证据链的前提下，提高信息加工结果的完整性、新颖性、可信度和覆盖面，使相同阅读数量承载更多有效信息。

### 目标

- 将条目摘要、内容分析和聚合拆分合并为一次基于原文的结构化内容理解调用，同时返回展示摘要、质量、标签、事件签名、聚合判断和子事件。
- 在事件新增成员后生成可缓存的事件增量，明确新增事实、变化类型、重要程度和支持来源。
- 用独立证据数量替代简单来源数量参与排序，并在分页前进行集合级多样性重排。
- 保持同步摄入、Worker、条目摘要重生成和条目重分析等现有执行路径行为一致。
- 所有新增能力均可降级；失败不得阻塞内容入库、聚类、Feed 或日报生成。

### 非目标

- 不保留 ingestion 内旧的 `item_summary`、`item_analysis`、`item_aggregation` 调用，也不保留旧 Provider、Prompt、配置或运行时兼容分支。
- 不把归组判定合并进单篇内容理解；`cluster_match` 仍只在本地规则无法确定时调用。
- 不建设实体知识图谱、完整引用网络或事实级证据审计系统。
- 不引入来源可信度评级、政治立场判断或自动事实核查。
- 不改变 Feed 使用 `items.createdAt` 的时间窗口语义。
- 不改变公开页面的个人状态边界，不增加已读、收藏或多用户个性化。
- 不在本方案中建设观点、博客和教程的独立内容管道。

## 当前系统上下文

### 当前处理流

```text
RSS
  -> 规则预过滤
  -> 正文补抓
  -> 完整内容规则过滤
  -> item_understanding（摘要 + 翻译 + 质量 + 标签 + 事件签名 + 聚合拆分）
  -> 聚合内容拆分
  -> assignItemToCluster
  -> recomputeCluster（整体标题和摘要）
  -> EventBriefing 排序
  -> DailyReport 候选
```

### 现有约束

- 现有 `summarizeItem`、`enrichContent` 和 `parseAggregation` 拥有独立 Prompt、模型配置和解析器；切换时用新的 `understandItem/item_understanding` 直接替换三者，但“仅重生成摘要”和“重新 AI 判定”的用户操作语义仍需兼容。
- 摄入既可以由管理操作同步触发，也可以由 Worker 执行；共享逻辑应继续位于 `src/lib/*`。
- 聚类包含精确指纹、本地候选排序、AI 匹配、人工约束和批次结束重算，不应绕过现有可靠性机制。
- 内容变化必须继续失效 Feed、事件速览和日报相关缓存。
- SQLite 是当前唯一数据库；新增查询和索引需控制写放大和大范围扫描。

## 方案概览

```text
最佳原始内容
  |---> 条目摘要（展示表达）
  `---> 内容分析（质量、标签、事件签名）
                 |
                 v
          事件归组与聚合重算
                 |
                 v
          事件增量生成（新增事实）
                 |
                 v
       独立证据统计 + 单条相关性评分
                 |
                 v
           集合级多样性重排
                 |
                 v
          事件速览 / AI 日报
```

三个改动按依赖顺序设计：统一内容理解改善摘要和事件签名，事件签名和内容指纹改善事件增量与独立证据，最后由排序层消费这些信号。

## 详细设计

### 一、统一条目理解：摘要、分析与聚合拆分

#### 模块边界

新增 `src/lib/ingestion/content-input.ts`，统一负责生成内容理解输入：

```ts
type ItemUnderstandingInput = {
  text: string;
  source: "full_text" | "rss_content" | "rss_excerpt" | "title";
  inputHash: string;
  truncated: boolean;
};

buildItemUnderstandingInput(item): ItemUnderstandingInput
```

- 输入从 `fullText -> rssContent -> rssExcerpt -> originalTitle` 选择最佳来源。
- 裁剪时优先保留标题、导语、主体、动作、数字、日期、引用、结论和文末关键更新，避免只截取正文前部。
- 同一份输入同时用于摘要、质量评分、标签、事件签名、聚合判断和子事件拆分，避免模型重复阅读。
- 输入哈希包含规范化文本和理解契约版本，用于幂等、回溯和后续选择性重处理。

#### 调用契约

新增语义明确的 `understandItem`，直接替换 `summarizeItem`、`enrichContent` 和 `parseAggregation`：

```ts
type ItemUnderstandingResult = {
  summary: string;
  translatedTitle: string | null;
  moderationStatus: "allowed" | "filtered";
  moderationReason: string | null;
  moderationDetail: string | null;
  qualityScore: number;
  qualityRationale: string;
  tags: string[];
  eventSignature: AiEventSignature | null;
  aggregation: {
    isAggregation: boolean;
    mainEvent: AiEventSignature | null;
    events: ParsedEvent[];
  };
  diagnostics: {
    summaryValid: boolean;
    analysisValid: boolean;
    aggregationValid: boolean;
    recoveredFields: string[];
  };
};

understandItem(
  inputText: string,
  metadata: {
    title: string;
    sourceName?: string;
    translateTitle: boolean;
    aggregationSplitMaxEvents: number;
  },
): Promise<ItemUnderstandingResult>
```

统一 Prompt 必须要求单个 JSON 对象返回全部字段。Provider 负责字段级解析与校验，而不是把整个响应视为只有成功或失败两种状态：

- 摘要字段无效但分析字段有效：使用现有 fallback 摘要，`summaryStatus=failed`，保留有效质量、标签和事件签名，`analysisStatus=succeeded`。
- 分析字段无效但摘要有效：保存摘要，分析字段使用现有中性 fallback，`summaryStatus=succeeded`，`analysisStatus=failed`。
- 聚合字段无效但摘要、分析有效：保存普通条目理解结果，将 `aggregationParseStatus=failed`，本轮把父条目作为普通内容展示，后续重分析可重试拆分。
- `aggregation.isAggregation=true` 时，`events` 必须至少包含一条通过校验的子事件；每条子事件独立校验标题、摘要、质量分、标签、来源 URL 和事件签名。
- 请求、超时或整体 JSON 均失败：摘要、分析和聚合分别走现有降级，并保留可重试状态。

#### 数据变更

在 `Item` 增加：

```prisma
understandingInputHash String?
understandingVersion   String?
```

- `understandingInputHash` 用于判断统一内容理解输入是否真正变化。
- `understandingVersion` 标识裁剪规则和 `item_understanding` 输出契约版本，不记录模型密钥或敏感配置。
- 现有 `summaryStatus`、`analysisStatus` 和 `aiProcessedAt` 语义保持不变。

#### 现有执行入口与操作语义

下列路径必须共同调用 `buildItemUnderstandingInput` 和 `understandItem`：

- 常规 ingestion 的 `processFeedItem`。
- `reanalyzeItem` / `executeItemReanalyzeTask`。
- 翻译标题和摘要重生成路径。

操作语义保持如下：

- 常规 ingestion：一次调用返回并写入全部理解字段；聚合内容在同一响应中得到子事件，不再发起第二次拆分调用。
- “重新 AI 判定”：一次调用重新写入摘要、翻译、质量、标签、事件签名和聚合结果；按新结果事务更新子条目并重新归组。
- “仅重生成摘要”：同样执行一次统一调用，但只提交 `summaryText/summaryStatus`，不得覆盖质量、标签、事件签名、聚类或 `understandingInputHash`；这是用较大的统一输出换取单一 Prompt 与 Provider 契约。
- “仅重生成翻译”：执行一次统一调用，但只提交 `translatedTitle`。

#### Prompt 配置迁移

新增 `item_understanding` Prompt 类型，并用它直接替换三套旧类型：

- 从 `PromptConfigType` 删除 `item_summary`、`item_analysis` 和 `item_aggregation`，增加 `item_understanding`。
- 删除 `AiProvider.summarizeItem`、`AiProvider.enrichContent`、`AiProvider.parseAggregation` 及其解析器、默认配置、设置 UI、API DTO、种子数据和对应测试。
- 新增统一 JSON 解析器，支持摘要、分析、聚合三个字段组的独立校验与部分成功。
- 数据升级删除三类旧 Prompt 配置，并写入新的内置 `item_understanding` 模板；已有自定义 Prompt 不自动迁移，升级说明必须明确这是一次契约切换。
- AI usage breakdown 删除 `item_summary`、`item_analysis`、`item_aggregation`，增加 `item_understanding`；每个条目理解只累计一次。
- `item_regenerate_summary` 和 `item_reanalyze` 等任务类型及用户操作保留，但底层统一调用 `understandItem`，不代表保留旧 AI 逻辑。

#### 聚合结果持久化

- 普通内容：直接保存父条目的摘要、分析和事件签名，然后进入归组。
- 聚合内容：先保存聚合父条目，再使用现有事务能力一次性替换全部有效子条目；父条目保持不进入公开 Feed 和 cluster。
- 子条目直接使用统一响应中的摘要、质量分、标签、来源 URL 和事件签名，不再执行单独的摘要或分析调用。
- 子事件全部校验失败时不得写入部分子条目；父条目按普通内容降级并记录 `aggregationParseStatus=failed`。
- 重分析从聚合变为普通内容、普通内容变为聚合内容或子事件集合变化时，沿用现有退休旧子条目、重算受影响 cluster 和缓存失效机制。

#### 归组判定边界

归组判定不并入 `item_understanding`。统一调用只负责产生条目自身的结构化事件签名；持久化后再使用数据库当前状态完成跨条目关系判断：

1. 事件指纹或标题精确匹配，直接加入已有 cluster。
2. 本地候选排序达到强匹配和分差阈值，直接加入。
3. 存在多个歧义候选时，调用现有 `cluster_match`。
4. 没有匹配结果时创建新 cluster。

普通条目执行一次归组；聚合父条目不归组，每个有效子条目分别执行同一流程。`cluster_match` 和 `cluster_merge` 保持独立 Prompt，因为它们依赖实时数据库候选，不属于单篇内容自身理解。

### 二、事件增量提取

#### 数据模型

新增事件更新类型与模型：

```prisma
enum ClusterUpdateType {
  new_event
  progress
  confirmation
  correction
  reversal
  repetition
  other
}

enum ClusterUpdateStatus {
  pending
  succeeded
  failed
}

model ClusterUpdate {
  id                     String              @id @default(cuid())
  clusterId              String
  inputHash              String
  status                 ClusterUpdateStatus @default(pending)
  updateType             ClusterUpdateType?
  whatChanged            String?
  significance           String?
  noveltyScore           Int?
  confidenceScore        Int?
  newItemCount           Int                 @default(0)
  independentSourceCount Int                 @default(0)
  supportingItemIdsJson  String              @default("[]")
  baselineItemIdsJson    String              @default("[]")
  errorMessage           String?
  generatedAt            DateTime?
  createdAt              DateTime            @default(now())
  updatedAt              DateTime            @updatedAt
  cluster                ContentCluster      @relation(fields: [clusterId], references: [id], onDelete: Cascade)

  @@unique([clusterId, inputHash])
  @@index([clusterId, status, createdAt])
  @@map("cluster_updates")
}
```

`ContentCluster` 增加 `updates ClusterUpdate[]` 关系。SQLite 初始化和升级仍只通过 `prisma/schema.prisma` 与 `scripts/setup-sqlite.mjs` 生成，不手写 SQL。

#### 生成时机

事件增量不在每个 item 完成时同步生成，也不阻塞 ingestion 主任务。`cluster_finalize` 只对受影响 cluster 去重、计算 delta/input hash、幂等写入 `pending` 记录；主任务完成后再提交一个批量 `cluster_update_generate` 后台任务：

1. 完成成员归组和 `recomputeCluster`。
2. 读取该 cluster 最近一次成功 `ClusterUpdate`。
3. 以其 `supportingItemIdsJson + baselineItemIdsJson` 对应成员作为 baseline。
4. 将新加入或内容哈希变化的成员作为 delta。
5. delta 为空时跳过；输入哈希相同则幂等复用，否则写入 `pending`。
6. ingestion 在存在新 `pending` 记录且没有同类 queued/running 任务时，提交一个 `cluster_update_generate` 任务后结束。
7. Worker 分页领取 `pending` 记录并批量生成结果；管理员触发的单 cluster 重算也复用同一 service，可用现有 `entityId` 限定 cluster，并默认入队而非内联等待。

```ts
generateClusterUpdate(
  input: {
    baselineSummary: string;
    baselineItems: ClusterUpdateInputItem[];
    newItems: ClusterUpdateInputItem[];
  },
  metadata: { clusterId: string; title: string },
): Promise<ClusterUpdateResult>
```

`BackgroundTaskKind`、task handler、任务标签和 AI usage breakdown 增加 `cluster_update_generate` / `cluster_update`。生成 service 支持“领取全部 pending”与“限定 clusterId”两种调用方式，确保 Worker 与测试、维护脚本共用同一实现，不要求扩展通用任务 payload。

为控制总 AI 开销，V1 只对满足以下条件之一的 cluster 创建待生成记录：

- 新增成员至少 1 条且 cluster 已存在于更早日期。
- 新增独立来源至少 1 个。
- 新事件达到事件速览最低候选分。

其余 cluster 可写入规则生成的 `repetition` 或延迟到预计算任务处理。

#### 状态与降级

- 首次生成使用 `new_event`，baseline 为空。
- AI 返回无效结构时记录 `failed`，不得回滚 cluster 更新。
- 读取层始终选择最近一次 `succeeded`；没有成功记录时回退现有 cluster 摘要和 `isFollowUp`。
- 新一次生成失败时保留上一条成功结果。
- cluster 合并、拆分或成员移出后重新计算输入哈希；旧记录保留为历史，但不参与最新展示。

#### 缓存影响

成功写入事件增量后必须失效：

- `EventBriefingCache`。
- `DailyReportCache`。
- 公开 Feed 缓存仅在 Feed DTO 开始消费事件增量后失效。

### 三、独立证据与多样性重排

#### 独立证据计算

V1 使用轻量、可解释的证据分组，不建设完整来源图谱。为 `Item` 增加：

```prisma
contentFingerprint String?
evidenceOriginKey  String?
```

- `contentFingerprint`：对规范化正文计算的近似指纹，用于发现转载和高度改写内容。
- `evidenceOriginKey`：优先取正文明确引用的主来源 URL/domain；无法提取时回退当前 `sourceId`。

同一 cluster 内成员按以下顺序合并为 evidence group：

1. `evidenceOriginKey` 相同。
2. 正文近似指纹达到高相似阈值。
3. 规范化 canonical URL 相同。
4. 否则视为独立组。

`ContentCluster` 增加：

```prisma
displayIndependentSourceCount Int @default(0)
```

该字段由现有 cluster feed stats 刷新逻辑批量更新。无法计算时回退 `displaySourceCount`，确保旧数据和部分失败可用。

#### 单条相关性评分

保留 `rankScore` 为单个事件的相关性分，但调整证据与进展信号：

```text
baseRankScore =
  qualityComponent
  + independentEvidenceComponent
  + eventNoveltyComponent
  + freshnessComponent

rankScore =
  baseRankScore
  + curatorBoost
  - curatorPenalty
```

- `independentEvidenceComponent` 使用 `independentSourceCount`，不再使用原始 `itemCount` 放大转载数量。
- `eventNoveltyComponent` 使用最新成功 `ClusterUpdate.noveltyScore`；无更新记录时使用现有 `isFollowUp` 的兼容低权重。
- `sourceCount` 和 `itemCount` 继续保留在 DTO 中用于解释，不作为主要证据分。

#### 集合级重排

候选完成单条评分后、分页前执行确定性的贪心重排：

```text
selectionScore(candidate) =
  rankScore
  - similarityPenalty(candidate, selected)
  - topicSaturationPenalty(candidate, selected)
  - sourceGroupSaturationPenalty(candidate, selected)
```

相似度只使用已有可解释字段：

- `eventSubject` 和 `eventType`。
- 规范化标签重合。
- 标题关键词重合。
- dominant source group。

约束：

- 对同分候选使用 `rankScore -> latestCreatedAt -> id` 稳定排序。
- 在完整候选集合上重排后再分页，保证翻页稳定。
- 频道筛选先于重排，不能把其他频道候选引入当前结果。
- `rankScore` 保留原始相关性语义；新增内部 `selectionOrder`，避免把上下文相关的多样性分持久化为绝对分数。

#### DTO 兼容

在 `EventBriefingEntryDTO` 增加可选字段：

```ts
independentSourceCount?: number;
update?: {
  type: ClusterUpdateType;
  whatChanged: string;
  significance: string | null;
  noveltyScore: number;
  confidenceScore: number;
};
```

现有字段不删除，旧组件可以忽略新增字段。日报候选继续通过 `listEventBriefingEntriesForDailyReport` 复用同一排序结果。

## 配置与发布控制

新增内部运行配置，首版不要求暴露后台 UI：

```ts
informationProcessingV2: {
  clusterUpdatesEnabled: boolean;
  independentEvidenceEnabled: boolean;
  diversityRerankEnabled: boolean;
  diversityPenalty: number;
}
```

默认发布策略：

- `item_understanding` 不设置运行时双轨开关；应用和数据库升级完成后只有新版单调用路径。
- 其余三项默认关闭，完成数据回填和影子评估后逐项开启。
- 配置存储遵循现有数据库运行配置模式，不将长期运行开关放在初始化 JSON 之外作为双重真相来源。

## 一致性、并发与幂等

- `understandingInputHash + understandingVersion` 相同且摘要、分析、聚合状态均成功时可复用。
- `ClusterUpdate` 使用 `(clusterId, inputHash)` 唯一键，重复 Worker 或同步路径不会重复生成记录。
- 同一 update 被重复投递时，Worker 通过状态和唯一键复用成功结果；长期停留在 `pending` 的记录按现有 stale-task 清理思路重新入队。
- 同一 cluster 的更新生成沿用 cluster assignment 的串行协调思路，或使用数据库唯一键处理竞争。
- cluster 更新失败不改变 `ContentCluster` 状态。
- evidence stats 采用可重复计算的派生字段，成员变化后批量刷新，不依赖增量计数加减。
- 集合级重排必须为纯函数，相同候选和配置产生相同顺序。

## 可靠性与降级

| 失败点 | 降级行为 |
|---|---|
| 统一响应仅摘要字段无效 | 使用现有 fallback 摘要，保存其余有效分析字段 |
| 统一响应仅分析字段无效 | 保存有效摘要，质量分和事件签名使用现有中性降级 |
| `item_understanding` 请求或整体 JSON 失败 | 摘要、分析和聚合分别写入降级状态，不影响入库，后续重分析可重试 |
| 事件增量失败 | 使用最近成功增量；没有时使用 cluster 整体摘要 |
| 证据来源提取失败 | `evidenceOriginKey` 回退 `sourceId` |
| 内容指纹缺失 | 不做相似合并，不阻塞独立来源统计 |
| 多样性重排异常 | 回退稳定的 `rankScore` 排序 |
| 新旧应用版本并存 | 新字段可空，新 DTO 字段可选，旧读取路径继续工作 |

## 性能

- 普通条目由两次 AI 调用降为一次，聚合内容由摘要加拆分两次调用降为一次；统一 JSON 输出会增加单次输出 token，需要分别监控输入、输出和总成本。
- 内容理解输入设置硬上限，避免把完整超长正文直接发送给模型。
- 聚合内容的子事件直接来自统一响应，不再执行额外 AI 调用；子事件持久化和逐项归组仍在模型调用后执行。
- `cluster_finalize` 只计算事件增量输入并入队，不等待新增 AI 调用；Worker 对受影响 cluster 批量生成一次，并通过输入哈希跳过重复调用。
- 内容指纹在正文规范化后一次计算并持久化，不在每次查询时重算。
- 独立证据统计限定在单个 cluster 成员集合内。
- 多样性重排只处理达到 `minRankScore` 的候选，复杂度目标为 `O(N * K)`，其中 K 为当前页面需要稳定排序的候选上限。

## 安全与隐私

- 不新增用户数据或个人行为采集。
- AI 输入继续只包含已抓取公开内容和来源元数据。
- `evidenceOriginKey` 只保存规范化 URL/domain 标识，不保存请求头、Cookie 或凭证。
- 日志不得输出全文、模型密钥或完整 AI 响应；只记录 ID、哈希、计数、耗时和失败分类。

## 可观测性

新增任务时间线和指标：

- `item_understanding_source_full_text/rss_content/rss_excerpt/title` 分布。
- 统一内容理解的输入字符数、输入/输出 token、耗时和相对旧多调用链的总成本变化。
- 字段级降级分布：摘要失败但分析成功、分析失败但摘要成功、整体失败。
- 事件增量尝试、成功、失败、跳过和平均耗时。
- `new_event/progress/confirmation/correction/reversal/repetition` 分布。
- 原始来源数与独立来源数的平均压缩比。
- Top N 主题重复率和重排前后覆盖主题数。
- 多样性重排回退次数。

现有 AI 调用统计删除 `item_summary`、`item_analysis`、`item_aggregation`，增加 `item_understanding` 和 `cluster_update`；任务总调用估算和实际调用均需覆盖。

## 兼容、迁移与回滚

### 数据迁移

1. 发布前备份数据库和当前 Prompt 配置，作为整版回退点。
2. 通过 Prisma schema 增加可空 Item 字段、cluster 独立来源计数和 `ClusterUpdate`；从 `PromptConfigType` 删除三类旧 Prompt 并增加 `item_understanding`。
3. 数据升级删除 `item_summary`、`item_analysis`、`item_aggregation` 配置，写入内置 `item_understanding` 模板，同步更新相关 API、设置 UI 和种子数据。
4. 应用代码一次性切换到 `understandItem`，不部署同时支持新旧 Prompt 的中间运行态。
5. 后台分批回填 `understandingInputHash`、`contentFingerprint` 和 `evidenceOriginKey`，不得触发全量 AI 重分析。
6. 重算 active cluster 的 `displayIndependentSourceCount`。
7. 影子生成事件增量和新排序，不改变公开结果；对比指标后再开启独立证据、事件增量和多样性重排。

不要求历史内容在上线前完成全部回填；读取层必须支持新旧记录混合。

### 回滚

- `item_understanding` 不提供回到三套旧调用的代码开关；如需回退，必须停止新版本、恢复发布前数据库备份并部署上一版本应用。
- 关闭事件增量后，公开读取回退 cluster 摘要。
- 关闭独立证据后，排序回退现有 `sourceCount/itemCount` 证据分。
- 关闭多样性重排后，恢复 `rankScore` 稳定排序。

## 测试与验证

### 单元测试

- 内容理解输入选择、裁剪、哈希和版本变化。
- 统一响应字段级校验、部分成功和 fallback。
- 聚合字段的 `maxEvents`、子事件逐项校验和“全部无效则整体不拆分”规则。
- 归组决策顺序：精确匹配、本地强匹配、歧义 AI 匹配和新建 cluster。
- evidence group 的 URL、来源键和近似指纹合并规则。
- 独立证据分、增量分和旧数据 fallback。
- 多样性重排确定性、主题惩罚和频道边界。
- ClusterUpdate 输出校验和失败分类。

### 集成测试

- ingestion 中每个条目只调用一次 `understandItem`；代码库不存在 `summarizeItem`、`enrichContent` 或 `parseAggregation` 调用。
- 统一响应中摘要失败但分析成功，仍可写入质量、标签和事件签名；反向情况也能只保存有效摘要。
- 聚合内容由同一次调用返回子事件，事务写入后每个子条目独立归组，不产生第二次拆分 AI 调用。
- 聚合字段失败时父条目按普通内容降级，摘要和分析字段仍可成功保存。
- 精确指纹与本地强匹配不调用 `cluster_match`，只有歧义候选产生额外 AI 调用。
- 相同理解输入和版本不会重复调用 `understandItem`。
- `item_reanalyze` 覆盖全部理解字段并重新归组；`item_regenerate_summary` 和翻译重生成只提交各自目标字段。
- 同一批次多个 item 加入同一 cluster，只生成一个 input hash 对应的更新。
- ingestion 完成不等待事件增量 AI 调用，后续 Worker 成功后正确失效速览和日报缓存。
- cluster 合并、拆分、隐藏和删除后的增量读取与级联行为。
- 多篇转载归并为一个 evidence group，独立来源文章保持分离。
- 事件速览在功能关闭、部分回填和全部开启三种状态下均能返回稳定分页。
- 日报继续消费事件速览排序结果，并保留近期重复排除能力。
- SQLite 初始化和旧库升级验证。

### 质量回归集

建立固定样本，至少覆盖：

- 同一原文的摘要、质量和事件签名应来自一次统一理解，关键数字或日期不得只存在于摘要外而导致事件签名缺失。
- 同一公告的多家转载不应被计算为多个独立证据。
- 同一事件的真实进展、纯重复报道、修正和反转。
- Top 10 被同一主题占满的候选集合。
- 不完整事件签名、无全文、中文和英文混合来源。

上线门槛建议：

- 摘要失败不得再导致分析被跳过。
- 普通条目的模型调用数从两次降为一次，聚合内容的摘要加拆分调用也降为一次；输入 token 与 P95 单条处理耗时应下降。
- 统一 JSON 的摘要、分析、聚合字段组有效率不得低于三套旧调用各自的有效率基线。
- 事件增量结构化成功率不低于现有 cluster summary 成功率。
- 独立证据回填不得增加 cluster 错误合并率。
- Top 10 主题覆盖数提升，同时人工高价值漏选率不恶化。
- ingestion P95 总耗时增幅需在可接受范围内，并能通过关闭事件增量恢复。

## 权衡与备选方案

### 保留摘要、分析与聚合拆分的独立调用

不采用。独立调用可以保持失败域和 Prompt 独立，但会重复发送和理解相同正文，保留串行等待，并可能让摘要、分析和拆分结果不一致。当前选择一次统一内容理解，通过字段组校验、子事件逐项校验和部分成功写入控制耦合风险。

### 保留多模型配置但并行调用

不采用。并行可降低时延，但不能减少调用次数和输入 token，也无法保证摘要、评分、事件签名和聚合拆分来自同一理解结果。

### 建设完整来源引用图

暂不采用。完整 provenance graph 能提供更准确的证据独立性，但需要正文引用抽取、实体解析和跨文章图查询。V1 使用可解释的 URL、来源键和内容指纹分组，先验证独立证据是否显著改善排序。

### 将多样性直接写入 rankScore

不采用。多样性取决于已选择集合，不是候选的绝对属性。持久化为绝对分会导致分页和不同频道间语义混乱，因此保留 `rankScore`，只在读取时产生确定性的选择顺序。

## 开放问题

- `buildItemUnderstandingInput` 的最大字符数和正文分段策略，需要结合当前模型上下文与生产 token 数据确定。
- 新 `item_understanding` 默认绑定哪个模型，需要以长 JSON、聚合多事件样本的结构化输出成功率和总成本做一次样本评估。
- 事件增量是继续使用 `cluster_summary` 模型配置，还是增加独立 `cluster_update` Prompt 类型。
- V1 是否只对跨日 cluster 生成更新，还是同时为当天新事件生成 `new_event` brief。
- 内容近似指纹采用 SimHash、MinHash 还是现有依赖可支持的其他确定性算法。
- 多样性惩罚的默认强度和候选处理上限，需要通过影子排序样本校准。
- 历史 ClusterUpdate 保留周期是否无限；V1 可先保留全部，观察增长后再制定清理策略。

## 执行计划输入

后续执行计划应按以下依赖切片，但不在本文展开具体任务：

1. 统一内容理解输入、Provider/Prompt 契约、字段级降级和现有重生成操作兼容。
2. Prisma 可空字段、ClusterUpdate 模型与 SQLite 升级验证。
3. 内容指纹、证据来源键和 cluster 独立来源统计。
4. 事件增量 provider 契约、批量任务、生成服务、触发和失败降级。
5. 事件候选 DTO、独立证据评分和增量评分。
6. 集合级多样性重排与稳定分页。
7. 影子指标、数据回填，以及事件增量、独立证据和多样性功能的分阶段启用。

关键依赖顺序为：统一内容理解先于增量质量评估，独立证据统计先于新排序，多样性重排必须最后接入。数据模型和读取兼容应先于任何历史回填或公开启用。
