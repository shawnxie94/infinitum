# 日报生成稳定性改造技术需求文档

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档状态 | Implemented |
| 适用系统 | Infinitum 日报生成流水线 |
| 目标版本 | plan-write/full-coverage v1 |
| 编写日期 | 2026-08-14 |
| 关联模块 | `src/lib/daily-report`、`src/lib/tasks`、AI Provider、Admin 任务监控 |

## 2. 背景与问题定义

Infinitum 当前日报生成链路大致为：读取候选内容 → 通过一次 AI 调用同时完成选题、分组、摘要和 Markdown 组织 → 解析 JSON → 去重并持久化 → 公开展示。

生产环境 2026-08-13 的日报已经暴露出典型问题：任务成功、候选数量和 AI 调用均正常，但最终只生成了 `摘要` 和 `其他值得看` 两个区块，配置中的热点、变更、安全、开源、数据等区块没有稳定落地。当前 JSON 解析器主要保证“能解析成 JSON 且至少有一条内容”，没有把模板结构、区块覆盖、候选引用关系作为强约束，因此结构缺失会被当作成功结果发布。

本改造不把问题简单归因于“再加一层 JSON 校验”。核心问题是单次 AI 调用同时承担了两个耦合职责：

1. 从候选集合中判断什么值得看、哪些内容属于同一事件、应该放在哪个栏目。
2. 把已选内容写成符合模板的日报。

当候选较多、内容相似、区块约束复杂或模型输出接近上下文边界时，选题和写作会互相干扰，最终表现为漏选、分组漂移、区块缺失、重复引用和结构不稳定。

本 TRD 将流程拆为“候选评估/全局选题”和“受控写作”两个主要阶段，并在候选数量超过单次安全上下文容量时采用全量覆盖的 Map → Merge → Plan → Write 流程。

## 3. 目标与非目标

### 3.1 目标

1. 保留现有 `dailyReportCandidateLimit` 的产品语义：它定义本次日报需要交给 AI 判断的完整候选集合，而不是在 AI 之前被再次截断的预选上限。
2. 让候选集合中的每条内容都有明确的处理结果：被选中、被排除并说明原因，或因任务失败而整体失败；禁止静默丢弃。
3. 将选题、事件归并、区块分配与写作解耦，使写作阶段只能基于全局选题结果生成文章。
4. 对模板区块、条数、候选引用和跨区块重复建立机器可验证约束。
5. 结构不满足要求时先进行一次受控语义修复；修复失败则任务失败且不自动发布。
6. 在不改变历史日报、不改变公开 API 契约的前提下支持灰度、观测和快速回滚。

### 3.2 非目标

1. 本期不建设通用自主 Agent 框架，不引入工具调用、长期记忆或开放式循环。
2. 本期不重写 RSS 抓取、全文抽取、聚类和事件模型，只复用其已有的 `clusterId`、`itemId`、`sourceKey` 等身份信息。
3. 本期不要求一次性迁移历史日报；历史结果保持不变。
4. 本期不把所有内容都交给写作模型全文阅读；写作模型只接收全局计划选中的内容及其必要证据。
5. 本期不通过增加一个硬编码的“规划候选上限”替代用户配置。任何技术分批参数都不能改变候选集合的产品边界。

## 4. 现状基线

### 4.1 当前数据流

```text
daily_report_generate
  └─ generateDailyReport()
      ├─ 读取调度配置 dailyReportCandidateLimit
      ├─ 读取候选及近期日报去重结果
      ├─ createAiProvider().assessDailyReportCandidates(batch)
      ├─ 本地 mergeDailyReportTopics(完整评估账本)
      ├─ createAiProvider().planDailyReport(ledger, topics)
      ├─ 本地 plan_validate
      ├─ createAiProvider().writeDailyReport(plan, selectedCandidates)
      ├─ 本地 validate；必要时调用 repairDailyReportDraft()
      ├─ 去重、拼装 renderedMarkdown
      └─ 持久化并按配置发布
```

### 4.2 当前限制

- `dailyReportCandidateLimit` 同时影响候选读取和最终截断，目前生产配置为 300；它应该继续作为完整候选集合上限。
- 现有 `generateDailyReport` 是单阶段 AI 接口，模型输出既是计划又是最终文章。
- 旧版 `repairDailyReportJson` 已从 provider 公共接口移除；新阶段的 JSON 解析重试仍由 provider 内部处理，计划/模板/引用违规统一交给编排器校验和受控的 `repairDailyReportDraft`。
- 模板中的“输出 3-5 条”“可为空”等内容目前主要存在于自然语言描述，缺乏 `required/minItems/maxItems` 等机器字段。
- 任务监控当前有 `daily_report_generate` 粗粒度节点，不能定位候选评估、归并、选题、写作和修复分别耗时多久。
- 现有 AI 用量统计保留 `daily_report` 聚合键，细分阶段尚未形成稳定契约。
- `DailyReport` 以 `(date, timezone)` 唯一；生成时按该键 `upsert` 当前结果，并删除后重建 `DailyReportSource`。同一天重新生成会覆盖正文、候选快照和来源关系，不保留可恢复的内容版本。
- `BackgroundTaskRun.taskRunId` 只能关联本次任务诊断，不能作为日报内容历史；当前公开和 Admin 读取也都按日期读取唯一当前日报。

### 4.3 已确认的生产故障边界

2026-08-13 生产日报的任务本身显示成功，最终 `summaryJson` 与 `renderedMarkdown` 均只有少数区块。这说明问题发生在“模型输出内容满足宽松解析器”之后，而不是页面渲染层单独丢失内容。新方案必须把生成结果的结构完整性前移到任务发布门禁。

## 5. 设计原则

### 5.1 产品候选边界只有一个

`dailyReportCandidateLimit` 是用户设置的候选条数。它表达的是：本次日报从这 N 条内容中做全局判断，不能在 AI 前面再增加一个小于 N 的 `DAILY_REPORT_PLANNING_CANDIDATE_LIMIT`，否则 AI 看到的不是用户配置的候选集合。

允许增加的是任务级技术参数 `dailyReportPlanningBatchSize`。它只控制如何分批处理，不控制哪些候选进入处理流程。

### 5.2 分批是分析分批，不是结果分批

如果 `effectiveBatchSize >= N`，自然形成一个覆盖全部候选的批次；否则按固定条数切成多个评估批次。无论是一批还是多批，评估阶段只负责结构化评估；每批不能直接决定最终 Top N、最终区块或最终文章。最终选择必须在所有候选评估结果合并后，由全局规划阶段完成。

### 5.3 明确的有限状态机优先于开放式 Agent

日报生成是可预测的流水线，适合显式阶段、固定输入输出、有限重试和明确失败门禁。可以使用“Agent-like”的局部判断，但不引入不可控的自主循环。每个 AI 阶段都必须有输入快照、输出 schema、超时、重试上限和失败处理。

### 5.4 结构约束和语义质量分离

结构校验负责回答“能否安全发布”；AI 语义判断负责回答“内容是否值得看、属于哪个事件和区块”。程序不应试图用正则判断文章质量，也不应让模型自由决定是否遵守硬约束。

## 6. 总体方案

### 6.1 目标流程

```text
准备候选快照
    ↓
全量候选评估（单批或固定条数分批）
    ↓
跨批次身份归并与证据合并
    ↓
全局选题与栏目规划
    ↓
计划校验
    ↓
受控写作
    ↓
文章结构、引用、重复和模板校验
    ↓
一次语义修复（必要时）
    ↓
最终校验
    ↓
持久化 / 自动发布
```

### 6.2 阶段定义

| 阶段 | 职责 | 是否允许最终选题 | 失败处理 |
| --- | --- | --- | --- |
| `PREPARE` | 固化候选集合、模板、近期日报去重输入和版本 | 否 | 任务失败 |
| `ASSESS` | 对全部候选输出相关性、事件提示、推荐区块和排除原因 | 否 | 当前批次重试；仍失败则整体失败 |
| `MERGE` | 跨批次合并同事件、补充来源证据、生成歧义对 | 否 | 可由确定性规则完成；数据异常则失败 |
| `PLAN` | 在完整评估账本上进行全局选题、区块分配和排序 | 是 | 重试一次；仍失败则失败 |
| `PLAN_VALIDATE` | 校验候选引用、区块、数量、唯一性和覆盖关系 | 是 | 复用同一 ledger 重试 Plan 或失败 |
| `WRITE` | 只按照全局计划写摘要、标题、正文和引用 | 否 | 重试一次；仍失败则失败 |
| `VALIDATE` | 校验文章与计划、模板和候选证据的一致性 | 否 | 进入语义修复或失败 |
| `REPAIR` | 仅修复已知结构/语义违规，不重新选题 | 否 | 最多一次；仍失败不发布 |
| `PERSIST/PUBLISH` | 保存日报、渲染 Markdown、发布缓存 | 否 | 不发布，保留失败任务信息 |

## 7. 候选集合语义与固定条数分批

### 7.1 候选集合定义

候选集合由现有服务按以下顺序生成：

1. 根据调度配置读取 `dailyReportCandidateLimit`。
2. 应用现有时间范围、来源、事件简报、近期日报去重和黑名单规则。
3. 对最终进入日报生成的集合建立运行内 `candidateId`，按稳定排序编号为 `1..N`；`itemId`、`clusterId`、`sourceKey` 和事件身份作为跨任务的稳定身份字段。事件级候选需要带上事件身份和组成条目。
4. 将集合完整写入候选快照，记为 `rawCandidateCount`。

候选快照之后不允许隐式 `slice`、按模型分数截断或因区块不足而静默丢弃。若候选因业务规则被过滤，必须在 `candidateSnapshot` 中记录过滤原因；本 TRD 约束的是进入日报生成阶段之后的完整集合。

### 7.2 单次全局模式

当 `effectiveBatchSize` 大于等于候选总数时，直接执行一个覆盖全部候选的 `ASSESS` 批次。候选仍然全部可见，不能因为使用单批模式就减少候选。

### 7.3 全量覆盖分批模式

当候选总数超过 `effectiveBatchSize` 时，使用以下流程：

1. 按稳定排序切分候选批次。排序应使用候选稳定 ID、事件时间和入库时间，不能使用随机顺序。
2. 每个候选只进入一个主评估批次，避免同一候选被重复计费和产生不一致判断。
3. 每批输出一份候选评估结果，必须包含批次内每个候选的 `candidateId`；不允许只输出“看起来值得看”的候选。
4. 服务端合并所有批次，验证 `assessedCount === rawCandidateCount` 且 `unassessedCandidateIds` 为空。
5. 依据现有事件/聚类身份进行跨批次确定性归并；对无法确定的相似候选记录歧义对，但保留为独立主题，不调用 AI 裁决模型。
6. 全局规划器读取所有评估记录和合并后的事件摘要，做最终选择、区块分配和排序。
7. 写作器只读取规划选中的候选完整内容，不能重新扩大或改变选题集合。

### 7.4 分批可能造成的信息损失及控制

朴素分批确实会造成以下问题：同一事件落在不同批次、跨批次候选无法比较、来源互证被拆散、不同批次对栏目建议冲突、每批都选 Top N 导致结果偏科。解决办法不是把每批结果直接拼起来，而是把批次定位为“全量评估 Map”，增加全局 Merge 和 Plan：

| 风险 | 控制措施 |
| --- | --- |
| 同一事件被拆到不同批次 | 优先使用已有 `clusterId`、事件指纹、规范化标题和 `sourceKey` 归并 |
| 新事件没有稳定身份 | 评估阶段输出 `eventHint`；它只是合并提示，不能覆盖已有确定身份 |
| 跨批次无法比较重要性 | 全局规划器读取所有评估分数、主题、时间、来源数和证据摘要 |
| 每批都选 Top N | 批次不产生最终选择，只产生覆盖全部候选的 ledger |
| 来源互证丢失 | Merge 阶段保留同事件的所有来源 ID、来源质量和证据摘要 |
| 归并误合并 | 先确定性规则，低置信度只建立歧义对；不确定时宁可保留为两个候选并由全局规划处理 |
| 批次输出不完整 | 服务端按 candidate ID 做覆盖校验；漏项直接失败并重试该批次 |
| 批次结果与最终文章不一致 | Writer 输入必须引用 Plan 的 candidate ID，校验阶段反向比对 |

### 7.5 技术参数

日报分片只使用任务级配置 `dailyReportPlanningBatchSize`，不再增加系统默认 batch size、环境变量硬上限或其他候选数分片配置。这样每次任务的分片依据都能直接从 Admin 调度配置和任务快照中解释。

```ts
type DailyReportTaskConfig = {
  dailyReportCandidateLimit: number;
  dailyReportPlanningBatchSize: number | null;
};
```

运行规则：

- 正整数：按该值对完整候选集合固定切批；
- `null`：不做常规分批，把完整候选集合作为一个批次；
- 任意情况下都不能因为批次大小而截断候选集合；
- Provider 返回 context length exceeded 时，当前批次直接标记为失败并保留诊断信息；不对失败批次动态拆分、不递归重试，也不静默丢弃候选。

因此，`dailyReportPlanningBatchSize` 是唯一的分片依据；其配置值、实际生效值和批次数必须写入任务快照和时间线，便于排查。运行期间不根据上下文长度再次调整批次。

### 7.6 任务级批次配置

`dailyReportPlanningBatchSize` 存入现有日报调度/任务配置。不同任务可以根据模型、模板、候选内容长度和成本预算使用不同的显式值，不再依赖环境变量继承隐含行为。

字段语义如下：

- `null`：完整候选集合作为一个批次；不代表跳过分片，也不代表候选数量无限制。
- 正整数：作为每批候选数上限，不代表最终只处理这么多候选。
- 旧任务配置没有该字段时按 `null` 处理，保证兼容；任务快照必须记录 `null` 及其实际单批执行结果。

最后一批可以少于配置值，但不能因为内容价值或分数不足而提前丢弃候选。

Admin 中可以把该字段放在“日报高级生成设置”中，并明确展示：

> 这是技术分批上限，不会减少本次 AI 评估的候选总数。留空表示完整候选集合按一个批次处理。

该字段需要同步出现在 `TaskSchedule`、`ScheduleUpdateInput` 和 `TaskScheduleSnapshot`；Admin 表单只对日报调度展示，其他任务类型不显示。

不建议把模型上下文和最大重试次数开放给任务配置。第一版只开放最有业务调节价值、且容易理解的候选数上限；系统不再维护另一套隐藏的 batch size 或候选数硬上限。

任务快照和 `inputHash` 需要记录配置值与实际生效值，便于解释同一批候选为什么产生不同的分批路径和结果：

```ts
type DailyReportPlanningRuntime = {
  configuredBatchSize: number | null;
  initialBatchSize: number;
  effectiveBatchSize: number;
  batchCount: number;
};
```

其中 `effectiveBatchSize` 的计算规则固定为：有配置时等于 `configuredBatchSize`，配置为 `null` 时等于 `rawCandidateCount`；候选数为 0 时批次数为 0。`initialBatchSize` 与 `effectiveBatchSize` 在第一版保持相同，保留两个字段是为了让任务快照明确区分“配置值”和“本次运行实际采用的值”。

### 7.7 上下文处理规则

第一版不引入 tokenizer、模型上下文注册表或动态 token 装箱，先使用 `dailyReportPlanningBatchSize` 的固定候选条数分批。配置为 `null` 时直接使用完整候选集合作为一个批次；配置为正整数时按该值切分。当前系统没有可靠的模型上下文能力元数据，且 OpenAI-compatible Provider 可能对应不同模型，因此不通过隐藏 token 默认值替代任务配置。

候选按照稳定顺序每 `effectiveBatchSize` 条切一批。无论每批内容得分如何，每个候选都必须进入某一批；批次不能提前选 Top N。

如果 Provider 明确返回 `context length exceeded`，当前批次直接标记为失败，任务失败且不发布；不对失败批次动态拆分、不递归重试，也不静默丢弃候选。已完成的其他批次保留在 checkpoint 中，便于任务详情页定位问题；管理员调整任务配置后重新执行时，按新的配置从 `PREPARE` 重新建立批次。

`PLAN` 阶段只接收紧凑的全量 assessment ledger 和 merged topics，`WRITE` 阶段只接收计划选中的候选；第一版不对这两个阶段做主动 token 估算。如果它们发生上下文超限，同样直接标记任务失败，并记录阶段、模型和错误码；后续通过调整任务级 batch size、压缩 DTO 或升级模型处理。

因此第一版不需要任何系统级 batch size、候选数硬上限、`contextWindowTokens`、`CONTEXT_BUDGET_TOKENS` 或 `SAFETY_MARGIN_TOKENS` 配置。tokenizer 和动态估算列为后续优化，不进入本期完成定义。

## 8. 数据契约

以下为 TypeScript 逻辑契约，具体类型可放在 `src/lib/daily-report/types.ts`，也可以先在 service/provider 模块中定义后再抽取。

### 8.1 候选快照

```ts
type DailyReportCandidateSnapshot = {
  generationVersion: "plan-write-v2/full-coverage";
  inputHash: string;
  capturedAt: string;
  rawCandidateCount: number;
  candidates: DailyReportPlanningCandidate[];
  candidateSourceMap: Array<{
    candidateId: number;
    sourceNumber: number;
  }>;
  filteredCandidates: Array<{
    candidateId: number;
    reason: string;
  }>;
  templateSignature: string;
};
```

第一版沿用现有数字型 `DailyReportCandidate.id` 作为运行内 `candidateId`，不额外引入字符串 ID。该 ID 只在同一 `taskRun + inputHash` 内稳定，不承诺跨任务或跨日期稳定；跨任务归并必须使用 `itemId`、`clusterId`、`sourceKey` 和事件身份。当前日报渲染中的 `sourceNumber/sourceIds` 是候选引用分组编号，快照中显式保存 candidate/source 映射，避免以后来源编号策略变化时把两个语义混为一谈。

```ts
type DailyReportPlanningCandidate = {
  candidateId: number;
  sourceNumber: number;
  itemId: string;
  clusterId: string | null;
  sourceKey: string;
  title: string;
  summary: string;
  url: string;
  sourceName: string;
  publishedAt: string;
  createdAt: string;
  qualityScore: number;
  candidateScore: number;
  sourceCount: number;
  itemCount: number;
  eventIdentity: {
    eventType: string | null;
    eventSubject: string | null;
    eventAction: string | null;
    eventObject: string | null;
    eventDate: string | null;
  } | null;
  evidenceItems: Array<{
    title: string;
    sourceName: string;
    summary: string;
    url: string;
    publishedAt: string;
  }>;
};
```

第一版的引用映射约定为：`candidateId -> sourceNumber` 是候选级引用分组映射；一个 `sourceNumber` 可以展开为多个 `DailyReportSource` 来源快照，但这些来源仍属于同一个 candidate。正文中的 `sourceIds` 只能引用计划选中 candidate 对应的 `sourceNumber`，不能直接引用未知来源行 ID。

映射规则：

1. Planner、ledger、Merge 和 Plan 只使用 `candidateId`。
2. Writer 输入同时携带 `candidateId` 和 `sourceNumber`。
3. Writer 输出沿用现有 `DailyReportContent` 的 `sourceIds`，但服务端必须通过 `candidateSourceMap` 反向校验每个 `sourceId` 属于计划选中的 candidate。
4. 未知 `sourceId`、计划外 `candidateId` 或 candidate/source 映射不一致时，草稿校验失败。

`DailyReportPlanningCandidate` 是候选生成服务到新 Pipeline 的适配 DTO，不替换现有 `DailyReportCandidate` 类型；适配时保留现有 `itemId`、`clusterId` 和证据字段。

### 8.2 候选评估账本

```ts
type DailyReportCandidateAssessment = {
  candidateId: number;
  relevanceScore: number;
  isWorthReading: boolean;
  suggestedBlockKey: string | null;
  exclusionReason: string | null;
  eventHint: {
    eventType: string | null;
    eventSubject: string | null;
    eventAction: string | null;
    eventObject: string | null;
    eventDate: string | null;
  };
  evidenceSummary: string;
  confidence: number;
};

type DailyReportAssessmentLedger = {
  schemaVersion: 1;
  candidateCount: number;
  assessedCount: number;
  unassessedCandidateIds: number[];
  assessments: DailyReportCandidateAssessment[];
  batchCount: number;
};
```

账本是可靠性核心：每个候选必须且只能出现一次。`isWorthReading=false` 也必须有 `exclusionReason`，这样才能区分“模型判断不选”和“系统漏处理”。

### 8.3 合并后的事件视图

```ts
type DailyReportMergedTopic = {
  topicId: string;
  candidateIds: number[];
  identitySource: "cluster" | "event-identity" | "source-key" | "standalone";
  titleHint: string;
  evidenceCount: number;
  sourceKeys: string[];
  relevanceScore: number;
  ambiguity: {
    candidateIds: number[];
    reason: string;
  } | null;
};
```

### 8.4 全局日报计划

```ts
type DailyReportPlan = {
  schemaVersion: 1;
  headlineHint: string | null;
  sections: Array<{
    blockKey: string;
    blockTitle: string;
    topicIds: string[];
    candidateIds: number[];
  }>;
  excludedCandidateIds: number[];
  selectionRationale: string;
};
```

计划使用候选 ID 和 topic ID，不允许模型直接返回未经服务端解析的正文作为最终结果。服务端必须验证：所有 ID 存在、同一候选不被重复放入不同区块、区块名称属于模板、计划没有引用账本之外的候选。

### 8.5 最终日报草稿

最终草稿沿用现有 `DailyReportContent` 结构，以降低渲染和历史数据兼容成本，但增加内部校验元数据：

```ts
type DailyReportDraft = DailyReportContent & {
  metadata?: {
    planSchemaVersion: 1;
    selectedCandidateIds: number[];
    selectedSourceNumbers: number[];
    writerModel: string | null;
  };
};
```

对外持久化可以继续只保留现有公开字段；内部 metadata 可放在任务快照或生成上下文中，避免扩大公开 JSON 契约。

### 8.6 日报版本历史快照

`DailyReport` 继续表示指定日期的当前结果，保持现有 `(date, timezone)` 唯一约束和公开 `/daily/:date` 读取契约；新增不可变的 `DailyReportRevision` 作为生成历史。

每个成功生成结果都创建一个 revision，至少保存：

- `dailyReportId`、日期、时区和单日报内单调递增的 `revisionNo`；
- 生成动作：`generated`、`restored` 或首次接入时的 `baseline`；
- 完整 `DailyReportContent`、`renderedMarkdown`、标题、摘要、结语；
- `inputHash`、模型名、模板签名/pipeline version 和 `taskRunId`；
- 候选快照、生成时间、当时的 draft/published 状态；
- `restoredFromRevisionId`，用于记录恢复来源。

Revision 的实现契约如下，具体 Prisma 字段名可以按现有命名风格调整，但语义和约束不变：

```text
DailyReportRevision
- id                  String primary key
- dailyReportId       String
- revisionNo          Int                 // 在同一日报内单调递增
- action              baseline | generated | restored
- status              draft | published    // 生成时状态，不随当前投影变化
- title/opening/closing/summaryJson/renderedMarkdown
- inputHash           String
- modelName           String?
- templateSignature   String?
- pipelineVersion     String
- taskRunId           String?
- candidateSnapshot   String?
- restoredFromRevisionId String?
- idempotencyKey      String unique
- actorType           system | admin
- actorId             String?
- actorLabel          String?
- createdAt           DateTime

DailyReportRevisionSource
- id                  String primary key
- revisionId          String
- sourceNumber        Int?
- sourceKey/itemId/clusterId
- sourceName/title/url/sourceSummary/sourcePublishedAt
- sourceQualityScore/event fields/sectionName/topic

Constraints:
- unique(dailyReportId, revisionNo)
- revision source cascades with its revision
- restoredFromRevisionId uses SetNull when an expired historical revision is removed
- currentRevisionId cannot point to a deleted revision
```

revision 需要一个服务端生成的唯一 `idempotencyKey`：正常生成使用 `taskRunId + inputHash`，首次懒快照和恢复使用各自的动作 ID，避免断点恢复或重复提交产生重复历史版本。

`DailyReportRevisionSource` 保存该 revision 对应的来源快照，不复用当前 `DailyReportSource` 行，避免当前日报更新后历史来源被级联删除。revision 与来源必须在同一事务中写入。

`DailyReport` 增加 nullable 的 `currentRevisionId`，作为当前投影指针。该字段不做历史数据回填：已有日报继续正常读取；某日期第一次在新链路下重新生成时，先在同一事务中将已有当前日报及其来源懒快照为 `baseline`，再创建新 revision 并更新当前投影。这样不需要全量数据回填，也能保留首次覆盖前的结果。

本期不增加 `publishedRevisionId`：恢复操作只允许当前日报为 draft，因此不会通过历史恢复直接覆盖一个 published 当前投影。`baseline` 只针对已有可展示内容的日报创建；已有记录不存在正文或处于不可恢复的 failed 状态时，不创建空 baseline。

历史 revision 只对已登录 Admin 可见。公开日报、RSS、sitemap 和现有按日期详情接口始终只返回 `DailyReport` 当前投影，不把同一天的历史版本暴露为多篇日报。

历史恢复只允许当前 `DailyReport.status = draft` 的日报执行。已发布日报不显示可执行的“恢复为草稿”按钮；如需恢复，先通过现有生成流程生成草稿，再在草稿状态下恢复历史版本。恢复动作始终创建新的 `restored`、`draft` revision，不修改被恢复的历史 revision，也不直接发布。

第一版建议保留最近 365 天的 revision；清理任务只删除超过保留期且不是 `currentRevisionId` 的历史版本，并级联删除其来源快照。第一版不新增单独的保留期配置，后续确有存储或合规需要时再扩展为任务级配置。

## 9. 模板与栏目约束

### 9.1 模板字段扩展

需要扩展，但只扩展机器可执行的结构约束。当前模板已经有 item note 的 `required`，但 section 本身只有 `title` 和自然语言 `description`；这不足以让服务端判断“区块是否必须出现、至少/最多几条”。

在现有模板 section block 上增加以下字段。`key` 是内部字段，前端不需要让管理员配置：

```ts
type DailyReportTemplateSectionBlockConfig = {
  type: "section";
  key?: string;
  title: string;
  description?: string;
  required?: boolean;
  minItems?: number;
  maxItems?: number | null;
  item: DailyReportTemplateItem;
};

type NormalizedDailyReportTemplateSectionBlock =
  Omit<DailyReportTemplateSectionBlockConfig, "key"> & { key: string };
```

`key` 是稳定的机器标识，`title` 是可编辑的展示名称。计划、时间线、统计和校验应使用 `key`，不要把用户可能修改的标题作为唯一主键。模型输出和公开日报仍可沿用现有 `title` 字段，不需要改变公开内容结构。

后端在模板规范化时自动生成 `key`：

1. 已存在的 `key` 原样保留。
2. 新 section 没有 `key` 时，根据标题生成 slug，并在同名时追加序号。
3. 规范化后的模板在管理员保存时持久化该 key；管理员修改标题时，后端继续保留原 key。
4. 运行时如果遇到尚未保存的旧模板，也使用同样的确定性生成规则，不能使用随机值。

因此前端配置只需要增加三个用户可理解的字段：`required`、`minItems`、`maxItems`。`key` 可以作为隐藏字段随配置往返，也可以完全由后端 API 维护，但不应作为可编辑表单项。

兼容策略：

- 默认模板由后端生成并持久化稳定 `key` 和约束字段。
- 旧模板缺少 `key` 时由后端按标题生成兼容 key；管理员保存后持久化，不要求用户手动补录。
- 旧模板缺少约束字段时使用宽松默认值：`required=false`、`minItems=0`、`maxItems=null`，不因为升级而使历史自定义模板全部失败。
- `description` 继续用于给模型的写作说明，但不再承担唯一的机器约束职责。

这意味着前端实际必须增加的是 `required/minItems/maxItems`；`key` 仍然需要存在于规范化模板中，但由后端自动维护，不改变对外日报 JSON。

### 9.2 约束语义

- `required=true`：输出中必须存在该区块骨架。
- `minItems`：该区块最终必须至少有多少条内容；如果区块只是希望固定出现但允许为空，则 `required=true, minItems=0`。
- `maxItems`：该区块最多允许多少条内容。
- 空的可选区块不渲染到 Markdown，但可以保留在内部结构中以便审计。
- 模板中所有区块都必须进入计划和校验范围；模型不能自行新增栏目。

### 9.3 模板规范化生命周期

模板规范化不是每次日报生成都完整处理一遍，而是按模板配置版本执行。新版 Pipeline 不在日报任务运行期间兼容旧模板，而是在启用前完成迁移。Admin 打开设置页时只做版本检测和状态展示；自动静默迁移由配置迁移门执行，不对自定义模板自动改写。模板处理拆为“原始结构检查”和“v2 规范化”两个边界：

```text
inspectDailyReportTemplate(raw)
  → schemaVersion / migrationState / legacyFingerprint / warnings / errors

normalizeV2DailyReportTemplate(rawV2)
  → 只接受 schemaVersion = 2
  → 生成或保留 key
  → 补齐 required/minItems/maxItems
  → 输出 NormalizedDailyReportTemplate
```

新 Pipeline 只能调用 `normalizeV2DailyReportTemplate` 的结果，不能直接调用会回退默认模板或兼容 legacy 结构的旧 normalize 函数。

1. Admin 或运行时配置迁移门检测模板 schema；如果是合法的 version 2，直接使用；如果是精确匹配官方未修改旧默认模板，执行一次自动静默迁移；其他旧 `blocks` 或 `opening/sections/closing` 模板标记为“待迁移”。
2. 自定义旧模板进入轻量迁移交互，由管理员确认映射、约束和预览；后端完成 JSON 解析、字段校验、默认值补齐、`key` 生成和规范化序列化。
3. 自动或人工迁移成功后，规范化模板写回现有 `templateJson`，并计算 `templateSignature`。
4. 日报任务启动时只读取规范化模板，做轻量 schema/version 校验并计算输入哈希；不在每次日报运行期间重复迁移。
5. 可以按 prompt config ID + `updatedAt` 或 `templateSignature` 做进程内缓存；模板保存后使缓存失效。
6. 如果发现历史配置未迁移、签名不匹配或版本不兼容，任务直接阻止生成并提示管理员完成迁移；迁移失败不进入 AI 阶段。

因此，模板属于相对静态的配置资产，正常日报任务只消费其规范化结果。模板版本、签名和 pipeline version 必须进入 checkpoint 判断和 `inputHash`，模板发生变化时不能继续复用旧计划或旧草稿。

### 9.4 历史模板兼容策略

模板升级必须区分“可自动规范化的当前结构化模板”和“需要人工重建的更早旧模板”，但所有日报模板在新 Pipeline 启用前都必须达到 schema version 2：

迁移门统一输出以下状态：

```text
v2
legacy_default_exact_match
legacy_blocks_missing_constraints
legacy_custom
invalid
```

| 配置形态 | 处理方式 |
| --- | --- |
| 新版模板，含 `required/minItems/maxItems` | 按新 schema 校验并直接使用 |
| 当前 `blocks` 模板，但缺少新字段 | 保留用户内容；迁移时补 `key`，使用宽松默认值 `required=false`、`minItems=0`、`maxItems=null`，并持久化为 version 2 |
| 未修改的默认旧模板 | 通过官方旧模板指纹精确匹配后自动静默升级为新版默认模板 |
| 自定义旧版 `opening/sections/closing` 模板 | 不再走旧执行链路；管理员必须在设置页重建/保存为 version 2 |
| 非法 JSON 或无法识别结构 | 阻止新 Pipeline，提示配置迁移/修复 |

当前代码的 `upgradeLegacyDailyReportPrompt()` 主要覆盖默认日报 prompt；自定义历史配置不能假设已经完成迁移。本改造需要增加显式的模板 schema 检测和迁移状态，至少做到：

1. 启动迁移或管理员保存时识别模板版本，不把自定义内容误判成默认模板；默认模板自动迁移只能使用官方旧模板指纹精确匹配。指纹基于 canonical JSON 的 `{ systemPrompt, templateJson }` 计算，并以版本化常量维护，例如 `LEGACY_DAILY_REPORT_DEFAULT_FINGERPRINT_V1`；不能使用 `name`、`isDefault` 或结构相似度替代。
2. 官方未修改旧默认模板可以自动静默升级；当前 `blocks` 模板缺少约束字段时可以按宽松默认值自动规范化；自定义 `opening/sections/closing` 模板进入轻量人工迁移流程。
3. 新 Pipeline 只接受 `schemaVersion = 2` 模板；只要仍有启用中的非 version 2 模板，就阻止对应日报任务运行。
4. 不修改历史日报的 `summaryJson` 和 `renderedMarkdown`；模板迁移只影响后续生成。

规范化模板顶层必须包含 `schemaVersion: 2`：没有该字段但包含 `blocks` 的视为当前旧结构，包含 `opening/sections/closing` 的视为 legacy；规范化成功后统一写成 version 2。`schemaVersion` 缺失或不是 2 的模板不得直接进入新 Pipeline。

### 9.4.1 旧模板的 Admin 迁移交互

旧 `opening/sections/closing` 模板采用“确定性预映射 + 管理员确认”的迁移流程，不调用 AI，也不允许保存后再由运行时猜测结构。

#### 入口与状态

- 在 AI 设置的日报提示词配置列表中，对旧模板显示“待迁移”状态和原因：`blocks` 缺字段、`opening/sections/closing` 旧结构、非法 JSON 或无法识别结构。
- 精确匹配官方未修改旧默认模板的配置不显示待迁移弹窗；系统自动完成迁移后，在配置详情中展示“已自动迁移”标记和迁移时间。
- 启用中的旧模板显示高优先级提示：“新日报链路暂不可用，请先完成模板迁移”，并提供“开始迁移”按钮。
- 未迁移模板仍可查看原始配置，但不能直接使用普通“保存”绕过迁移；普通编辑保存按钮改为“迁移并保存”。
- 一个模板迁移成功后立即变为 version 2；其他未迁移的启用模板仍分别阻止对应任务，不要求一次性修改无关配置。

#### 轻量迁移交互

不单独建设复杂的四步迁移向导，直接复用现有 v2 模板编辑器。只有未能精确匹配官方默认模板的旧配置才需要管理员参与：

1. Admin 检测到旧模板后显示“待迁移”，点击“迁移模板”。
2. 服务端按固定规则生成 v2 草稿，不调用 AI、不直接覆盖原配置。
3. 弹出一张简短的迁移摘要卡片，只展示：
   - `openingSummary/opening` → 一个 `text` block，标题取 `openingLabel`，缺失时为“摘要”；
   - `sections` 的每个键 → 一个 `section` block，保留原栏目标题和说明；
   - `closingThought/closing` → 一个 `text` block，标题取 `closingLabel`，缺失时为“趋势观察”；
   - 自动生成 `key`；
   - `required/minItems/maxItems` 使用的宽松初始值；
   - 未识别字段或需要人工检查的警告。
4. 管理员点击“迁移并编辑”后，直接进入现有 v2 模板编辑器，在同一处检查 block 顺序、标题、说明和 `required/minItems/maxItems`，最后使用原有“保存”流程写入 version 2。

旧模板中的自然语言数量描述只作为提示，不自动升级为硬约束；无法可靠推断时使用 `required=false`、`minItems=0`、`maxItems=null`。确定性映射之外的字段必须在摘要中告警；如果字段无法安全保留，迁移保存按钮保持禁用并要求管理员处理。

迁移成功后保留一次只读的迁移审计摘要：原 schema、迁移时间、操作管理员、字段映射和告警。它用于排查配置变化，不作为日报运行时输入，也不需要回填历史日报。

自动静默迁移的审计动作标记为 `auto_default_migration`，操作主体标记为 `system`；人工迁移标记为 `manual_migration` 并记录 Admin 操作人。两种迁移都必须幂等：同一配置已经是 version 2 或已有相同旧模板指纹的迁移记录时，不重复改写 `templateJson`。

迁移接口仍分为预览和确认两个后端边界：`POST /api/admin/settings/prompt-configs/:id/daily-report-template/migration-preview` 只返回确定性 v2 草稿和告警；管理员确认后调用现有 prompt config 更新接口或等价的迁移保存接口，由服务端重新校验并原子写入 v2 `templateJson` 与 `templateMigrationAuditJson`。前端摘要不能成为最终信任边界。

#### 迁移失败与回退

- 非法 JSON、无法识别结构或存在未处理字段时，预览可以展示错误，但“迁移并保存”按钮保持禁用。
- 保存采用整份 `templateJson` 原子替换；写入失败时保留旧配置，不能出现半份 v2 模板。
- 迁移后的模板如需重新调整，直接回到现有 v2 编辑器修改；不提供恢复旧执行链路的按钮。
- 迁移预览和保存均为本地规则计算，不调用 AI；迁移失败不会消耗模型额度。

### 9.5 推荐默认模板约束

| 区块 | required | minItems | maxItems |
| --- | ---: | ---: | ---: |
| 热点事件 | true | 3 | 5 |
| 变更与实践 | true | 2 | 5 |
| 安全与风险 | false | 0 | 5 |
| 开源与工具 | false | 0 | 5 |
| 数据与洞察 | false | 0 | 5 |
| 其他值得看 | true | 0 | 10 |

实际数值应以当前产品模板为准；若当天确实没有满足某个强制区块的内容，计划校验必须将任务标记为“不可发布”，而不是让模型伪造内容填满区块。

### 9.6 模板版本与输入哈希

日报 `inputHash` 应纳入：

1. 完整候选集合及其稳定字段。
2. 近期日报去重输入。
3. 模板规范化 JSON 和 `templateSignature`。
4. 生成管线版本，例如 `plan-write-v2/full-coverage`。
5. 影响输出的渠道和调度参数。

这样修改模板或切换生成策略后不会错误复用旧任务输入。

## 10. AI Provider 设计

### 10.1 接口建议

在现有 `AiProvider` 基础上增加显式阶段接口：

```ts
type NormalizedDailyReportTemplate = DailyReportTemplateConfig & {
  schemaVersion: 2;
};

type DailyReportViolation = {
  code: string;
  stage: "plan" | "draft";
  message: string;
  blockKey?: string;
  candidateIds?: number[];
};

interface AiProvider {
  assessDailyReportCandidates(input: {
    candidates: DailyReportPlanningCandidate[];
    template: NormalizedDailyReportTemplate;
  }): Promise<DailyReportCandidateAssessment[]>;

  planDailyReport(input: {
    ledger: DailyReportAssessmentLedger;
    topics: DailyReportMergedTopic[];
    template: NormalizedDailyReportTemplate;
  }): Promise<DailyReportPlan>;

  writeDailyReport(input: {
    selectedCandidates: DailyReportPlanningCandidate[];
    plan: DailyReportPlan;
    template: NormalizedDailyReportTemplate;
  }): Promise<DailyReportDraft>;

  repairDailyReportDraft(input: {
    draft: DailyReportDraft;
    violations: DailyReportViolation[];
    plan: DailyReportPlan;
    template: NormalizedDailyReportTemplate;
  }): Promise<DailyReportDraft>;

}
```

新 Pipeline 不再保留 `legacy` 执行分支。现有 `generateDailyReport` 只作为迁移期间的旧实现参考，最终由新的阶段编排器替代；新模式不应通过同一个宽泛接口隐藏阶段边界。

### 10.2 评估器提示要求

评估器必须：

- 对输入中的每一个 `candidateId` 返回一条结果。
- 只输出结构化评估，不输出完整日报。
- 明确区分“值得看但建议合并”和“排除”。
- 提供事件提示、区块建议、简短证据摘要和排除理由。
- 不创建输入不存在的事实、来源或候选 ID。

服务端对返回值做 schema 解析和覆盖校验。AI 返回多余 ID、未知 ID、重复 ID 或漏 ID 时，优先重试当前批次，不将错误向下游传递。

### 10.3 全局规划器提示要求

规划器必须看到完整的评估账本和合并后的主题，而不是某个批次的 Top N。规划输出只允许包含：

- 选择哪些 `topicId` 或 `candidateId`。
- 每个区块的分配和排序。
- 排除候选 ID。
- 简短选择理由。

规划阶段接收的模板视图只包含可规划的 `section` blocks 及其稳定 `blockKey`、栏目说明和条数约束；摘要、趋势观察等 `text` blocks 只属于 WRITE 输出，不得出现在计划的 `sections` 中。模型返回的 `blockKey` 必须逐字来自该模板视图的合法 key 列表，不得使用 `text`、block 类型、栏目标题或自行生成的 key。

规划器不能写正文，也不能绕过模板的最小/最大条数限制。

### 10.4 写作器提示要求

写作器输入为“全局计划 + 被选候选的完整内容 + 模板”。它必须：

- 只写计划中的候选。
- 保持每个候选对应的 source/item 引用。
- 不重新选择、合并或新增候选。
- 不新增模板外区块。
- 对缺失证据使用明确的保守表达，不得补造事实。

写作器输出仍然经过 JSON 语法解析；语法修复和语义结构修复是两个独立步骤。

## 11. 合并与全局规划算法

### 11.1 确定性身份优先级

跨批次归并按以下优先级执行：

1. 同一 `clusterId`。
2. 同一已持久化事件身份或事件指纹。
3. 规范化后的 `eventType + subject + action + object + eventDate`。
4. 同一 `sourceKey` 且标题/URL 指纹一致。
5. 以上均不满足时，保留为独立主题，不因为模型返回相似 `eventHint` 就强行合并。

AI 产生的 `eventHint` 只能作为提示和歧义检测输入，不得覆盖系统已有的确定性身份。

### 11.2 歧义对处理

为控制成本，不进行所有候选的两两比较。只有在以下条件同时或部分满足时才记录歧义对：标题相似、事件实体相同、时间窗口接近、来源主题相同但确定性身份不同。

第一版不调用 AI 裁决器。确定性身份无法确认时，保留为两个独立主题，并在 `ambiguity` 中记录候选 ID 和原因；全局规划器通过来源、证据和栏目平衡决定是否分别入选。这样 Merge 仍然是本地规则阶段，不增加隐藏的 AI 调用、重试和成本预算。

### 11.3 全局选题策略

规划器应综合以下信号，而不是只按单一相关性分数排序：

- 候选相关性和新鲜度。
- 主题的重要性与读者价值。
- 多来源互证数量和来源质量。
- 与近期日报的重复程度。
- 栏目覆盖和日报整体平衡。
- 同一事件只保留一个主条目，其他来源作为证据。
- 模板每区块的上下限。

最终输出需要保留排除候选清单，以支持任务审计和后续质量分析。

## 12. 服务层改造

### 12.1 `generateDailyReport()` 重构边界

建议将现有长方法拆成以下服务函数，保持 `generateDailyReport()` 作为编排入口：

```text
loadDailyReportInput()
loadNormalizedDailyReportTemplate()
buildCandidateSnapshot()
resolveDailyReportBatchPolicy()
splitDailyReportCandidates()
assessDailyReportBatches()
mergeDailyReportAssessments()
planDailyReport()
validateDailyReportPlan()
writeDailyReport()
validateDailyReportDraft()
repairDailyReportDraftIfNeeded()
deduplicateAndPersistDailyReport()
```

每个函数只接收显式 DTO，避免通过隐式可变状态在阶段之间传递候选和模型输出。

### 12.2 候选快照持久化

候选快照、任务时间线和可恢复的中间产物需要分开保存：

- `DailyReport.candidateSnapshot`：日报成功持久化后的候选审计摘要，继续复用现有字段。
- `BackgroundTaskRun.taskTimelineJson`：阶段状态、耗时和聚合指标，不保存大段 AI 输出。
- `BackgroundTaskRun.pipelineCheckpointJson`：可断点恢复的阶段产物和批次状态。第一阶段直接在 `BackgroundTaskRun` 增加这个 JSON 字段，不把 checkpoint 混入时间线。

checkpoint 至少包含：

```ts
type DailyReportPipelineCheckpoint = {
  schemaVersion: 1;
  pipelineVersion: string;
  inputHash: string;
  lastCompletedStage: string;
  resumeEligible: boolean;
  failedStage: string | null;
  failureCode: string | null;
  resumeAttempt: number;
  candidateSnapshot: DailyReportCandidateSnapshot;
  assessmentBatches: Array<{
    index: number;
    candidateIds: number[];
    status: "pending" | "running" | "succeeded" | "failed";
    attempt: number;
    assessments?: DailyReportCandidateAssessment[];
    error?: string;
  }>;
  ledger?: DailyReportAssessmentLedger;
  mergedTopics?: DailyReportMergedTopic[];
  plan?: DailyReportPlan;
  draft?: DailyReportDraft;
  violations?: DailyReportViolation[];
};
```

每个阶段成功后原子更新 checkpoint；恢复时只有 `inputHash`、模板签名、pipeline version 和固定分批策略都一致，才能复用已有产物。不得把 API key、完整系统提示或其他敏感凭证写入 checkpoint。

checkpoint 只保存规划 DTO、评估结果、主题、计划和草稿，不保存完整原文、完整 prompt 或 Provider 请求体。成功任务在 `PERSIST/PUBLISH` 完成后清理大段中间产物，只保留摘要；失败、取消和部分成功任务按照现有任务清理保留策略保留 checkpoint，供任务详情页继续执行和排查。

成功或失败都应另外记录以下摘要到任务时间线或错误信息：

- `generationVersion`。
- `rawCandidateCount`、`assessedCount`、`unassessedCandidateIds`。
- `batchCount`、批次大小和重试次数。
- 合并主题数量、歧义对数量。
- 选中候选数量和各区块数量。
- 计划校验违规、文章校验违规和语义修复次数。
- 模型名、耗时和 token 使用量（如 provider 可提供）。

不得在任务快照中写入 API key、完整系统提示或其他敏感凭证。

### 12.3 去重位置

现有候选去重和最终文章去重继续保留，但职责需要明确：

- 生成前去重：减少已知重复候选，但必须在候选快照中留下被过滤记录。
- Merge 去重：识别跨批次同事件并合并证据。
- Plan 校验：禁止一个候选同时进入多个区块。
- Draft 校验：禁止文章内部重复引用或跨区块重复内容。

### 12.4 当前结果、历史版本与恢复

在 `PREPARE` 阶段先执行当前状态门禁：

- 当前没有日报：允许生成 draft 或 published；
- 当前日报为 `draft`：允许继续生成 draft，也允许按 `dailyReportAutoPublish=true` 生成 published；
- 当前日报为 `published` 且 `dailyReportAutoPublish=true`：允许生成新的 published，并先创建懒 `baseline` revision；
- 当前日报为 `published` 且 `dailyReportAutoPublish=false`：直接失败，返回 `daily_report_draft_over_published`，不得进入 AI 阶段，也不得覆盖当前 published 内容。

本期保持单个 `DailyReport` 当前投影，不增加 `publishedRevisionId` 或 `workingRevisionId`。如果未来需要在已发布日报上并行生成待审核 draft，再单独扩展双指针模型。

持久化阶段采用“不可变 revision + 当前投影”双写，但必须在同一个数据库事务中完成：

1. 校验通过后按 `taskRunId + inputHash` 做幂等检查，创建新的 `DailyReportRevision` 及其 `DailyReportRevisionSource`；同一 task run 恢复时不得重复创建 revision。
2. upsert 指定日期的 `DailyReport` 当前投影，更新 `currentRevisionId` 和现有正文/来源字段。
3. 只有 `dailyReportAutoPublish=true` 时当前投影才是 `published`；由于 published 上禁止生成 draft，历史版本的状态只表示生成时状态，不改变恢复时的发布门禁。
4. 成功后执行日报缓存失效和任务完成记录。

任一评估、规划、写作、校验或持久化阶段失败，都不得覆盖当前有效日报，也不得创建可恢复的成功 revision。失败信息保留在 `BackgroundTaskRun`、checkpoint 和任务时间线；失败路径不得更新已有 `DailyReport` 的正文、状态、`publishedAt`、`taskRunId`、来源或 `errorMessage`，避免污染当前有效结果。

Admin 历史接口固定为：

```text
GET  /api/admin/daily-reports/:date/revisions
GET  /api/admin/daily-reports/:date/revisions/:revisionId
POST /api/admin/daily-reports/:date/revisions/:revisionId/restore
```

列表和详情接口只读；restore 接口必须校验登录态、日期归属、当前日报为 draft、日期锁和 revision 存在性。恢复成功返回新的 revision 摘要和当前日报状态；失败使用稳定错误码，不把历史正文写入错误响应。

Admin 历史能力至少提供：

- 按日期查看 revision 列表：版本号、动作、生成时间、状态、标题、来源数、模型、任务 ID 和输入哈希；
- 查看某个 revision 的完整草稿、来源、候选审计摘要和校验结果；
- 将选定 revision 恢复为一个新的 `restored` revision，而不是直接修改或删除历史行；
- 只有当前 `DailyReport.status = draft` 时允许恢复；已发布日报的恢复按钮禁用并说明原因；
- 恢复默认写入 `draft`，管理员确认内容后再使用现有发布操作，避免误操作直接替换公开内容。

恢复事务复制选定 revision 的正文和来源到新 revision，并更新 `DailyReport` 当前投影和 `DailyReportSource`。恢复接口在服务端再次校验当前状态，非 draft 直接返回 `409 daily_report_restore_requires_draft`。恢复后必须执行 `invalidateDailyReportCache()`；同日期恢复与生成互斥，避免“最后提交者”在 Admin 操作和自动任务之间产生不可解释的结果。

不能把最后的 `dedup` 当作解决选题和结构问题的兜底；如果去重导致区块低于最小条数，任务应回到 Plan 重试或失败，而不是静默发布空区块。

### 12.5 同日期互斥

生成和历史恢复以 `date + timezone` 为互斥键，使用新增的 `DailyReportOperationLock` 记录实现 single-flight：

```text
DailyReportOperationLock
- date
- timezone
- operation: generate | restore
- ownerTaskRunId / ownerRequestId
- leaseExpiresAt
- createdAt / updatedAt

unique(date, timezone)
```

获取锁必须在数据库事务中完成。锁不存在时创建；锁存在且 `leaseExpiresAt` 未到期时，新的操作不执行：自动任务记为 skipped，Admin 操作返回 `409 daily_report_operation_in_progress`；锁已过期时允许新操作接管并写入新的 owner。worker 在阶段切换时续租，任务成功、失败、取消时释放锁；进程崩溃由 lease 到期自动恢复。

锁只负责同日期的生成/恢复互斥，不改变 checkpoint 的阶段恢复语义。恢复接口必须先获取 `restore` 锁，再检查当前日报仍为 draft，最后在同一持久化事务中创建 revision 和更新当前投影。

## 13. 校验与修复策略

### 13.1 计划校验

必须验证：

1. 所有 `topicId`、`candidateId` 均来自输入。
2. 所有选中候选均存在于评估账本。
3. 评估账本覆盖率为 100%。
4. 同一候选不能出现在多个区块。
5. 区块名称全部来自模板。
6. 各区块满足 `required/minItems/maxItems`。
7. 计划中选中的候选没有被标记为不可用或已被业务规则过滤。

### 13.2 草稿校验

必须验证：

1. JSON 可解析且符合 `DailyReportContent` schema。
2. required 区块存在；可选空区块按模板策略处理。
3. 每个区块条数在边界内。
4. 草稿引用的来源/条目 ID 与计划一致。
5. 草稿没有新增计划之外的候选或栏目。
6. 同一候选没有跨区块重复。
7. 标题、摘要、正文等必需字段非空。
8. 输出没有明显的占位符、JSON 残片或工具调用残留。
9. Markdown 渲染后标题层级与 `summaryJson` 区块一致。

### 13.3 修复顺序

1. 每个 AI 阶段由 provider 内部完成一次结构化 JSON 解析重试；仍不可解析则当前阶段失败。
2. 语法正确但违反计划/模板/引用约束时，调用 `repairDailyReportDraft`，把具体违规列表、原草稿、计划和模板一并传入。
3. 语义修复不得新增候选、改变计划或创造事实，只能重排、删去违规内容、补齐缺失字段或将内容放回合法区块。
4. 修复后重新执行完整校验；仍失败则任务失败且不发布。

“AI 再修复”是受控的最后一步，不是允许模型重新自由生成日报的第二次机会。这样可以避免修复阶段把原本可定位的问题扩大成新的选题漂移。

## 14. 任务、重试与发布门禁

### 14.1 状态机

推荐任务时间线节点：

```text
daily_report_prepare
  → daily_report_assess
  → daily_report_merge
  → daily_report_plan
  → daily_report_plan_validate
  → daily_report_write
  → daily_report_validate
  → daily_report_repair (optional)
  → task_finished
```

保留现有 `daily_report_generate` 作为兼容的聚合节点或父节点，避免破坏 Admin 任务监控和已有查询。

### 14.2 重试规则

阶段内重试使用固定 attempt matrix，不开放为日报任务配置。表中的“总尝试次数”包含首次调用；同一阶段超过上限后任务失败。网络、限流、超时、Provider 5xx 和结构化输出不合法都按对应阶段的上限处理；指数退避只影响等待时间，不增加次数。

| 阶段/粒度 | 总尝试次数 | 失败后的复用范围 | 特殊规则 |
| --- | ---: | --- | --- |
| `PREPARE` 本地规则 | 1 | 无 | 输入或模板非法直接失败 |
| `ASSESS` 单批 | 2 | 只重试当前批次 | 已完成批次不重复调用；候选覆盖校验失败也只重试当前批次 |
| `ASSESS` context overflow | 1 | 保留已完成批次 | 不动态拆分、不重试；当前批次直接失败 |
| `MERGE` 本地规则 | 1 | 完整 assessment ledger | 不调用 AI 裁决模型 |
| `PLAN` | 2 | 完整 ledger 和 merged topics | 第二次仍失败则不重新评估候选 |
| `PLAN_VALIDATE` | 2 | 完整 ledger 和 merged topics | 只允许重新规划，不允许改变候选输入 |
| `WRITE` | 2 | 已通过的 plan 和选中候选 | 不重新选题、不重新 Merge |
| JSON 语法修复 | 1 | 原始 writer 输出 | 修复后仍不可解析则失败 |
| `VALIDATE` | 1 | 原始 draft、plan 和模板 | 本地校验不循环重试 |
| `REPAIR` | 1 | draft、plan 和违规列表 | 只允许修复已知违规，仍失败则不发布 |
| `PERSIST/PUBLISH` | 2 | 同一事务和幂等键 | 仅允许数据库临时错误重试，不重复创建 revision |

本期移除日报任务级自动全量重试，不再读取或使用 `dailyReportMaxRetries` 触发新的日报任务。阶段内 attempt matrix 是唯一自动重试机制；阶段耗尽后任务进入终态失败。人工“继续执行”只能复用原 task run 和 checkpoint，不能绕过阶段上限；如果修改了 batch size、模板、候选或 inputHash，必须创建新的任务并从 `PREPARE` 重新开始。

任一候选最终未评估、评估账本覆盖率不足或任何硬约束未通过，整体任务失败，不允许部分发布。

### 14.3 Checkpoint 断点恢复

Checkpoint 是本期唯一的任务级恢复机制。人工“继续执行”只对 `resumeEligible=true` 的中断或可恢复失败开放；断点恢复的最小粒度是“阶段”，评估阶段进一步细化到“批次”。任务级自动全量重试已移除，不再通过新建 task run 从 `PREPARE` 兜底。

| 失败位置 | 恢复动作 |
| --- | --- |
| `PREPARE` | 重新构建候选快照和模板运行时 |
| 某个 `ASSESS` 批次 | 复用已成功批次，只重试仍有 attempt 预算的失败批次；`context overflow` 不可恢复 |
| `MERGE` | 复用完整 assessment ledger，重新归并 |
| `PLAN` / `PLAN_VALIDATE` | 复用 ledger 和 merged topics，重新规划或修复计划 |
| `WRITE` | 复用已通过的 plan，只重试写作 |
| `VALIDATE` / `REPAIR` | 复用 draft、plan 和违规列表，继续校验或修复 |
| `PERSIST/PUBLISH` | 使用同一 `taskRunId + inputHash` 做幂等检查，避免重复创建 revision，不重新调用 AI |

任务详情页提供“继续执行”动作。执行前服务端必须校验 task run 仍未被其他 worker 获取、checkpoint 完整、`resumeEligible=true` 且当前输入签名未变化；然后将 task run 置为 `queued`，把异常中断的 `running` 批次重置为 `pending`，由同一编排器从最近 checkpoint 继续。每次实际重新调用 Provider 前递增对应阶段或批次的 `attempt`，恢复次数写入 `resumeAttempt`。

以下情况不得显示“继续执行”，必须新建任务：阶段 attempt 已耗尽、发生 `context overflow`、输入/模板/分批策略已变化，或 checkpoint 校验失败。

以下情况不得恢复旧 checkpoint，必须重新从 `PREPARE` 开始：

- 候选集合或 `inputHash` 发生变化。
- 模板签名或模板约束发生变化。
- pipeline version、固定分批策略或 prompt 版本发生变化。
- checkpoint schema 版本不兼容或内容校验失败。

### 14.4 发布门禁

只有同时满足以下条件才允许自动发布：

- 评估账本覆盖率 100%。
- 计划通过全部硬约束。
- 草稿通过全部硬约束。
- 修复次数未超过上限。
- `summaryJson` 与 `renderedMarkdown` 渲染一致。
- 持久化事务成功。

失败任务可以保存诊断信息，但不能覆盖当天已有的有效日报，也不能把不合格草稿标记为已发布。

## 15. 监控、审计与成本

### 15.1 AI 用量

保留现有 `TaskAiCallBreakdownKey` 的 `daily_report` 聚合键，保证既有 API 和监控兼容。阶段细节先记录在任务时间线和 `errorSummary` 中：

- assess：调用次数、批次数、token、失败/重试数。
- merge：确定性合并数、歧义对数、保留为独立主题的歧义数。
- plan：调用次数、token、输出候选数。
- write：调用次数、token、输出字数。
- repair：调用次数、修复前后违规数。

后续若确有用量分析需求，再扩展稳定的细分 breakdown key，不在本期同时改动所有统计消费者。

### 15.2 核心指标

建议至少记录以下指标：

- `daily_report_candidate_count`。
- `daily_report_assessment_coverage`。
- `daily_report_batch_count`。
- `daily_report_unassessed_count`。
- `daily_report_merge_topic_count`。
- `daily_report_selected_count`。
- `daily_report_section_count` 和各区块 item 数。
- `daily_report_plan_validation_failure`。
- `daily_report_draft_validation_failure`。
- `daily_report_repair_count`。
- `daily_report_publish_blocked`。
- `daily_report_revision_created`、`daily_report_revision_restored`。
- `daily_report_current_revision_no` 和历史 revision 数量。
- 分阶段耗时、总耗时、token 和费用。

### 15.3 任务监控 UI

Admin 任务监控增加阶段化展示：

- 当前阶段和阶段耗时。
- 候选总数 / 已评估数 / 未评估数。
- 批次数、完成批次、失败批次和当前重试次数。
- 合并主题数、歧义对数和保留为独立主题的数量。
- 计划各区块数量。
- 校验违规和修复次数。
- 当前日报版本号和“查看生成历史”入口；历史面板只在 Admin 日报详情中展示。
- 每个 revision 的生成任务、输入哈希、模型和恢复来源；恢复操作要求二次确认并记录操作人和任务时间线事件。

日报详情页的入口位置固定在“内容”卡片右上角现有工具栏内，紧跟候选与去重按钮之后、导出 Markdown 按钮之前。使用一个历史/回溯语义的 icon button，tooltip 和无障碍名称统一为“生成历史”；只在 Admin 会话中渲染，公开日报不显示该按钮。

点击按钮后打开“生成历史”弹窗，不跳转新页面。弹窗采用左右分栏，桌面端左侧为版本列表、右侧为版本预览，移动端改为上下布局：

- 顶部显示日期、当前版本状态和当前版本生成时间；当前投影使用“当前版本”标记。
- 左侧版本列表按 `revisionNo` 倒序，展示版本动作（生成/恢复/基线）、生成时间、draft/published 状态、标题和来源数；列表支持选中某个版本。
- 右侧展示选中版本的标题、摘要、正文和来源；顶部同时展示模型、任务 ID、输入哈希、候选数/选中数等审计元数据。
- 版本预览使用与正式日报相同的安全 Markdown 渲染器，不直接注入历史原始 HTML。
- 底部在当前日报为 draft 时提供“恢复为草稿”操作；published 状态只展示禁用态和原因。点击后必须二次确认，确认后创建新的 `restored` revision，更新当前日报并关闭弹窗；恢复结果默认为 draft，管理员可在原有工具栏继续发布。
- 没有历史版本时显示说明性空状态；已有旧日报在第一次新链路生成前仍可正常查看，不能显示虚假的版本号。
- 加载、空数据、历史读取失败和恢复失败都在弹窗内给出明确状态，不影响当前正式日报展示。

弹窗不提供“直接覆盖当前版本”或“恢复并自动发布”按钮，避免历史回滚绕过现有发布门禁。恢复成功后刷新当前日报内容、状态、生成时间和版本标记，并失效日报详情缓存。

顶层时间线展示 `prepare / assess / merge / plan / validate / write / repair` 等阶段，不把每个批次都展开成顶层节点，避免 300 条候选产生过长时间线。`assess` 节点内部展示批次进度和失败批次详情；必要时从 checkpoint 读取某一批的错误摘要和 candidate ID。

已有 generic timeline fallback 可继续工作；新增节点需要补充 `TaskTimelineNodeKey`、标签映射、阶段指标、checkpoint 恢复入口和组件测试。时间线只展示摘要，不直接展示完整 prompt 或大段 AI 输出。

## 16. 兼容性与发布策略

### 16.1 兼容范围

- 公开 `/daily`、日报详情页和 RSS API 不改请求/响应格式。
- 现有历史 `summaryJson` 和 `renderedMarkdown` 不回填、不重生成。
- 现有日报 prompt 配置继续作为 Writer 的写作说明；新增结构约束从规范化模板生成，避免管理台同时维护两套栏目定义。legacy 模板只在应用/worker 启动时执行一次性迁移，普通 runtime/admin 读写路径不再隐式改写模板。
- `TaskSchedule` 新增 nullable 的 `dailyReportPlanningBatchSize` 字段；不需要回填已有记录，旧记录按 `null` 读取，由 SQLite setup upgrade 补齐字段。
- 日报不再读取或执行 `dailyReportMaxRetries`；Admin 表单、`ScheduleUpdateInput`、`TaskScheduleSnapshot` 和日报编排器移除该配置语义。本次未部署生产，因此由 SQLite setup upgrade 删除旧数据库列；不做历史值回填。
- `BackgroundTaskRun` 增加 `pipelineCheckpointJson` 字段；该字段与日报批次配置字段一起纳入 SQLite setup upgrade。
- `PromptConfig` 增加 nullable 的 `templateMigrationAuditJson`，保存最近一次模板迁移的只读审计摘要；不回填历史配置，迁移保存时按需写入。
- `DailyReport` 增加 nullable 的 `currentRevisionId`，并新增 `DailyReportRevision`、`DailyReportRevisionSource`、`DailyReportOperationLock` 表；不做全量历史日报回填，已有日报在第一次新链路重生成时懒创建 `baseline` revision。上述字段和表由 SQLite setup upgrade 交付。
- Admin 任务列表、任务详情和 AI 用量聚合键保持兼容。
- worker 路径和 Admin 同步执行路径必须共享同一编排服务，不能只修复其中一条。

本次 schema setup upgrade 随新应用和 worker 一起部署，由普通 `docker compose up -d` 在启动时幂等执行；不回填历史日报、revision 或 checkpoint，旧任务配置的 nullable 字段按文档定义读取。

数据库结构只由 `prisma/schema.prisma` 定义；builder 阶段通过 `npm run schema:generate` 生成 `prisma/schema.sql`，app/worker 启动时由 `scripts/setup-sqlite.mjs` 幂等应用 schema snapshot，再执行少量已验证的旧库结构升级和 FTS/runtime 初始化。仓库不维护或执行 Prisma migration history，后续 schema 变更必须同步更新 setup upgrade 逻辑和测试。

### 16.2 灰度

建议按以下顺序上线：

1. 完成所有启用日报模板的 version 2 迁移和 validator。
2. 在 staging/test DB 使用真实规模候选执行 full-coverage，验证候选覆盖、Merge、Plan、Write、Validate 和 checkpoint。
3. 生产首轮使用 `dailyReportAutoPublish=false` 的受控任务生成 draft，观察覆盖率、结构失败率、费用、总耗时和任务时间线。
4. 确认无误后再开启自动发布。
5. 后续所有日报统一使用 full-coverage 新链路，不保留第二种执行模式或旧执行分支。

`dailyReportAutoPublish` 是唯一控制日报结果状态的开关：

- `false`：生成并保存 `draft` 日报；
- `true`：生成并保存、发布 `published` 日报。

生产验证不得对已有 `published` 的同日期日报直接执行 draft upsert；应使用 staging/隔离数据库，或选用没有正式日报的受控日期和输入。若需要与已有日报比较，先做只读或离线比较，不写正式 `DailyReport`。

### 16.3 回滚

回滚只能回滚部署版本或关闭自动发布；不通过运行模式切换恢复旧链路。模板迁移前可以直接回滚部署；模板迁移后，只有在旧版本通过 version 2 `blocks` 模板读取 smoke 的前提下才能回滚代码，否则采用“关闭自动发布 + 保留任务诊断 + 前向修复”。回滚不删除 checkpoint，历史已发布日报不做破坏性修改。

## 17. 测试与验收标准

### 17.1 单元测试

至少覆盖：

- 固定 batch size 切分后候选 ID 完整覆盖且无重复。
- 模板只在配置保存/版本变化时做完整规范化，运行时命中规范化缓存。
- Provider 返回上下文超限时当前批次直接失败，不动态拆分，不影响 checkpoint 中已完成批次。
- 批次结果缺 ID、重复 ID、未知 ID 时被拒绝。
- 全量账本 `assessedCount` 和 `unassessedCandidateIds` 计算正确。
- `clusterId`、事件身份、sourceKey 的跨批次归并优先级。
- 歧义对生成条件以及无法确定时保留独立主题。
- 计划区块、候选引用、上下限和重复校验。
- 草稿与计划的 candidate/source 映射校验。
- 旧模板缺少约束字段时的兼容默认值。
- 模板签名和 pipeline version 进入 input hash。
- JSON 语法修复和语义结构修复边界不混淆。
- 当前日报为 published 时恢复按钮不可用；当前为 draft 时恢复会创建新的 draft revision。
- 同日期并发生成/恢复由 operation lock 串行化，过期锁可以安全接管。
- 阶段 attempt 耗尽后不会创建新的日报 task run；`dailyReportMaxRetries` 不再触发自动重试。

### 17.2 Provider 测试

- 单次全局评估成功。
- 分批评估成功并合并。
- 批次输出不完整时只重试失败批次。
- 全局规划失败后复用评估账本。
- Writer 不得引用计划外候选。
- Repair 只能处理给定违规，不得新增 ID。
- Provider 错误、超时、限流和 token 超限的分类。
- 各阶段 attempt matrix 达到上限后任务失败，context overflow 不动态拆分。

### 17.3 集成测试

建议新增或扩展 `tests/integration/daily-report-service.test.ts`：

1. 300 条候选全部进入账本，未评估数为 0。
2. 同一事件被切到两个批次后最终合并为一个主题，并保留多来源证据。
3. 两个相似但不同事件不会被确定性规则误合并。
4. 全局规划能从所有批次中选择跨批次最高价值内容。
5. 计划缺少强制区块时任务不发布。
6. 写作器生成计划外内容时草稿校验失败并触发修复/失败。
7. 修复仍失败时不会覆盖已有日报。
8. Admin 同步路径和 worker 路径都经过相同阶段。
9. 对可恢复的评估批次失败只重试失败批次，已成功批次不重复调用 AI；context overflow 按固定矩阵直接失败。
10. Merge、Plan、Write、Validate 任一阶段失败恢复时复用前一阶段 checkpoint。
11. 模板、inputHash 或 pipeline version 变化时旧 checkpoint 不会被错误复用。
12. 任务时间线记录每个阶段和关键指标，批次作为 assess 阶段内部明细展示。
13. 同一日期的每次成功生成都会创建不可变 revision，当前日报只指向最新 revision。
14. 旧日报第一次被新链路覆盖前会懒创建 baseline revision，不需要全量历史数据回填。
15. 失败重生成不会覆盖已有有效日报，也不会创建成功 revision。
16. Admin 可以查看历史 revision 并将历史内容恢复为新的 draft revision；公开日期详情仍只返回当前结果。
17. 恢复会复制正文和来源快照、更新当前投影并失效日报缓存，历史 revision 不被修改。
18. 阶段失败后不会自动创建新的日报 task run；人工继续执行只在 `resumeEligible=true` 且仍有 attempt 预算时可用。

### 17.4 回归验证

按项目约定执行：

```bash
vitest run tests/unit/daily-report.test.ts \
  tests/unit/daily-report-template.test.ts \
  tests/unit/ai-provider.test.ts

vitest run tests/integration/daily-report-service.test.ts \
  tests/integration/event-briefing.test.ts \
  tests/integration/background-task-service.test.ts

npm run lint
npm run build
```

宽改动收工时再执行 `npm test`。生产 smoke 至少检查：

```text
/daily
/daily/<date>
/api/daily/rss
Admin 任务监控中的日报阶段时间线
summaryJson 区块与 renderedMarkdown 标题一致性
```

## 18. 分阶段实施建议

### Phase 1：契约和门禁

- 抽取模板规范化函数，补齐 `required/minItems/maxItems`，并按配置版本缓存规范化结果。
- 扩展日报 validator，先阻止缺失区块、非法引用和超限结果发布。
- 增加 candidate snapshot、template signature 和 pipeline version。
- 增加 `pipelineCheckpointJson` 及阶段级 checkpoint 读写能力。
- 增加 `DailyReportRevision`、`DailyReportRevisionSource`、`DailyReportOperationLock` 和 `currentRevisionId`，完成同事务写入、同日期互斥及失败不覆盖当前结果的持久化边界。
- 完成所有启用日报模板的 version 2 迁移；迁移未完成时阻止新 Pipeline 运行。

### Phase 2：选题/写作拆分

- 增加 `planDailyReport` 和 `writeDailyReport` provider 接口。
- 实现单次全局模式：完整候选 → 全局评估 → 全局计划 → Writer。
- 让 Writer 不再负责选题，只消费计划选中的候选。
- 增加计划校验和草稿校验。

### Phase 3：全量覆盖分批

- 增加任务级 `dailyReportPlanningBatchSize`，严格按配置切分；上下文超限直接失败并保留批次诊断。
- 实现 assessment ledger 和 100% 覆盖门禁。
- 实现跨批次确定性归并和歧义对。
- 增加全局 reducer/planner，保证最终选择通看所有批次。

### Phase 4：修复、观测和灰度

- 增加语义结构修复接口，保留 JSON 语法修复接口。
- 增加时间线阶段、覆盖率和发布阻断指标。
- 增加失败任务的 checkpoint 继续执行和任务详情页“继续执行”入口；不再提供日报任务级自动全量重试。
- 增加 Admin 日报历史面板、revision 预览和恢复为 draft 的操作。
- 通过 staging/受控 draft run 完成新 Pipeline 的生产前验证。
- 按 release-delivery 流程完成生产灰度、观测和回滚预案验证。

## 19. 方案取舍

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 只增加结构校验 | 不足 | 能阻止坏结果，但不能解决选题和写作耦合；需要配合新流程作为发布门禁 |
| 先截断一个 planning shortlist | 不采用 | 会让 AI 看不到用户配置的完整候选集合，改变 `dailyReportCandidateLimit` 语义 |
| 每批直接选 Top N，再拼文章 | 不采用 | 会造成跨批次不可比较、重复事件和栏目偏科 |
| 全量候选一次性给全局模型 | 首选 | 信息最完整，但受上下文、成本和输出长度限制 |
| 全量覆盖 Map → Merge → Plan → Write | 采用 | 在上下文不足时保留 100% 候选覆盖和全局选择能力 |
| 每个栏目一个 Agent | 暂不采用 | 成本、延迟和一致性更高，且容易重复选题；可作为后续实验 |
| 通用 Agent 框架 | 暂不采用 | 当前问题是固定流水线的边界和契约不清，不是缺少开放式工具调用 |

## 20. 风险与待确认项

### 20.1 风险

- 全量评估可能增加 AI 调用次数和费用。
- 长候选正文可能导致固定批次触发上下文超限；第一版直接失败，需要通过调整任务级 batch size、压缩 DTO 或升级模型处理。
- 事件归并规则过严会重复，过松会误合并。
- 强制区块的最小条数可能与“当天没有合适内容”的现实冲突。
- 新旧 prompt、模板和历史自定义配置之间可能存在隐含兼容问题。
- 版本正文和来源快照会增加存储量；按 365 天保留并确保清理不删除当前 revision。
- 同日期的自动生成、手动重试和历史恢复存在并发覆盖风险，必须通过 `DailyReportOperationLock` 按日期串行化。

### 20.2 上线前必须通过的实验

1. 使用生产规模约 300 条候选跑离线 benchmark，测量单次上下文是否可行以及分批平均批次数。
2. 用真实历史候选标注跨批次同事件样本，评估确定性归并的 precision/recall。
3. 对比当前生产结果与新流程的区块覆盖率、选中率、重复率、修复率、费用和总耗时。
4. 验证自定义模板缺少机器约束字段时的兼容行为。
5. 验证任务失败时已有日报、缓存和 RSS 不被错误覆盖。
6. 验证同一日期连续生成、首次懒 baseline、恢复 revision 和再次发布的完整链路。

### 20.3 当前建议默认值

在 benchmark 完成前，不把具体批次条数写死为产品默认值。第一版完全使用任务配置 `dailyReportPlanningBatchSize`；配置为空时单批处理完整候选，配置为正整数时按该值切批。生产打开 `full-coverage` 前必须确认任务配置对应的候选规模、上下文失败率和总耗时在可接受范围内。

## 21. 完成定义

本改造完成的判断标准不是“代码能生成一篇日报”，而是以下条件全部满足：

- 用户设置的候选条数被完整纳入 AI 评估范围。
- 单次模式或分批模式都能证明候选覆盖率为 100%。
- 跨批次内容经过合并后再进行全局选题。
- Writer 不再拥有自由选题权。
- 模板区块、条数、候选引用和 Markdown 一致性都有机器校验。
- 任何校验失败都不会自动发布不合格日报。
- 任务监控能定位失败阶段，且保留足够快照用于复盘。
- 同一日期的成功生成结果具备 Admin 可见的不可变历史，失败重生成不会覆盖当前有效日报，历史恢复会生成新的 draft revision。
- 新 Pipeline 统一使用 full-coverage，生产发布有可执行的部署回滚和自动发布关闭路径。
- 单元、集成、lint、build 和生产 smoke 均通过。
