# 抓取、聚合、速览与日报优化清单

## 目标

在不把问题归因于 LLM 能力的前提下，提高 Infinitum 以下四条链路的确定性质量：

- 抓取：尽量不漏掉时间窗内的新内容，避免未知时间内容被误判为最新。
- 聚合：保持误合并防护，同时减少因主体、对象写法差异导致的漏合并。
- 速览：优先展示“当天真正新增且值得关注”的事件，而不是历史累计证据最多的事件。
- 日报：提高当日候选召回、多源证据完整性、后续进展保留率和跨栏目去重质量。

本清单只覆盖数据选择、规则、排序、证据传递、输出校验和质量度量；不评价模型本身的理解、写作或总结能力。

## 当前总体判断

| 链路 | 当前判断 | 主要风险 |
|---|---|---|
| 抓取 | 基础可靠 | RSS 先截断再过滤；缺失发布时间会回退到当前时间 |
| 聚合 | 高精度、偏保守 | 主体/对象 alias 不足；高峰期候选上限可能损失召回 |
| 速览 | 结构合理但偏历史证据 | 已计算的当日新增来源数/条目数没有进入排序 |
| 日报 | 候选链路存在确定性损失 | 重复过滤后不回填；后续进展可能被同 cluster 直接过滤；模型证据过少 |

## 优化清单

### A. 抓取流程

| ID | 优先级 | 检查项 | 建议动作 | 验收标准 |
|---|---|---|---|---|
| ING-01 | P1 | RSS 截断顺序 | 先解析并按发布时间倒序，再应用处理时间窗，最后取每源 N 条；增加独立 `maxFeedItemsToScan` 安全上限 | 非严格倒序 RSS 中，时间窗内新条目不会因前 N 条旧内容被漏掉；超过安全上限的内容不会突破单源处理预算 |
| ING-02 | P1 | 缺失发布时间 | 增加 `publishedAtKnown` 或等价标记；未知发布时间保留 `createdAt` 纳入口径，但不使用回退时间获得发布时间新鲜度或延迟惩罚优势，并将未知状态传入日报候选证据 | 无日期条目不会因回退的当前时间获得时效加分；仍可按系统入库日进入日报，符合 `createdAt` 纳入语义 |
| ING-03 | P2 | Feed hash 覆盖范围 | 确认 hash 的输入范围与实际扫描范围一致；避免只对截断后的局部内容做变化判断 | Feed 后段变化不会被错误判断为“无变化” |
| ING-04 | P2 | 抓取质量监控 | 记录每源解析条数、扫描条数、时间窗内条数、未知时间条数、丢弃原因 | 可按 source 识别“源站排序异常”和“时间字段异常” |

相关代码：[src/lib/ingestion/service.ts:452](/Users/shawn/Documents/GitHub/infinitum/src/lib/ingestion/service.ts:452)、[src/lib/ingestion/item-processor.ts:103](/Users/shawn/Documents/GitHub/infinitum/src/lib/ingestion/item-processor.ts:103)。

### B. 聚合与事件身份

| ID | 优先级 | 检查项 | 建议动作 | 验收标准 | 当前状态 |
|---|---|---|---|---|---|
| AGG-01 | P1 | 主体/对象 alias | 在现有字符串归一化之上增加轻量 alias/canonical key，优先覆盖公司、品牌、产品和常见中英文写法 | 已知 alias 的同一事件能在初次归组阶段命中；不引入明显跨主体误合并 | 未做 |
| AGG-02 | P1 | 初次归组与后续 merge 规则一致 | 让 item assignment 和 7 天 merge 共用主体、对象、日期的 canonical 规则与硬冲突规则 | 同一对内容不会出现“初次判断冲突、后续判断可合并”的无解释差异 | 已完成：初次归组与 merge 共用事件签名 canonicalization；日期冲突在两条路径均被阻断 |
| AGG-03 | P1 | 候选上限损失 | 监控 `preLimitCandidates`、`postLimitCandidates`、`dirtyCandidateCount` 和邻居扫描截断次数 | 能量化高峰期因候选上限导致的潜在漏合并；超过阈值时产生告警 | 部分完成：已有运行指标，尚未补齐截断计数与告警 |
| AGG-04 | P2 | 日期规范化 | 统一 `YYYY-MM-DD`、斜杠日期、月份日期和时区边界的比较格式 | 同一事件日期的格式差异不会造成无谓 date conflict | 已完成：支持日/月/年级 canonical date，并允许低精度日期与其覆盖范围内的高精度日期兼容 |
| AGG-05 | P2 | 聚合离线评估 | 建立人工标注的小型 pair 集合，区分应合并、应拆分、信息不足 | 能分别计算 merge precision、merge recall、over-merge 和 split rate | 未做 |

相关代码：[src/lib/clusters/identity.ts:38](/Users/shawn/Documents/GitHub/infinitum/src/lib/clusters/identity.ts:38)、[src/lib/clusters/helpers.ts:298](/Users/shawn/Documents/GitHub/infinitum/src/lib/clusters/helpers.ts:298)、[src/lib/clusters/helpers.ts:968](/Users/shawn/Documents/GitHub/infinitum/src/lib/clusters/helpers.ts:968)。

### C. 速览排序

| ID | 优先级 | 检查项 | 建议动作 | 验收标准 |
|---|---|---|---|---|
| BRF-01 | P0 | 当日新增信号未入分 | 将 `newSourceCountOnDate`、`newItemCountOnDate` 纳入排序；历史 source/item count 主要表示可信度，不代表今日重要性 | 多源当日新事件不会被历史累计量大的旧事件稳定压过 |
| BRF-02 | P1 | 新鲜度影响过弱 | 将 `latestCreatedAt` 从平分条件提升为有限时间衰减或分桶项 | 同质量、同证据量的内容按当日新增和最新进展优先 |
| BRF-03 | P1 | follow-up 固定加分 | 将 follow-up 拆成“状态标签”和“新增事实强度”；有新来源/新条目/新动作时加分，否则不固定加分 | 普通旧事件不会仅因 follow-up 标签长期占据前列 |
| BRF-04 | P1 | 偏好规则影响可解释性 | 保留 curator boost/penalty 上限，并输出每个候选的排序分项 | 管理员能解释某个事件为何靠前，且偏好不会完全淹没时效性 |
| BRF-05 | P2 | 排序试验方式 | 先做 shadow score 或离线重排，不立即替换线上排序 | 用历史数据比较 Top-K 命中率、当日相关率、历史事件占比后再定权重 |

当前排序入口：[src/lib/events/service.ts:32](/Users/shawn/Documents/GitHub/infinitum/src/lib/events/service.ts:32)；当日新增量计算：[src/lib/events/repository.ts:384](/Users/shawn/Documents/GitHub/infinitum/src/lib/events/repository.ts:384)。

建议的分数构成先保持简单：

```text
内容质量
+ 当日新增来源数
+ 当日新增条目数
+ 新鲜度 / 时间衰减
+ 有新事实的后续进展
+ 主理人偏好
```

不要在第一轮引入复杂的实时热度或新的实体系统。

### D. 日报候选集

| ID | 优先级 | 检查项 | 建议动作 | 验收标准 | 当前状态 |
|---|---|---|---|---|---|
| DLY-01 | P0 | 重复过滤后不回填 | 扩大候选池，或过滤过程中继续向后取候选，直到达到目标数量 | 历史重复内容占据前 N 名时，后续新事件可以补位 | 已完成 |
| DLY-02 | P0 | 同 cluster 后续进展被过滤 | 日报候选保留 `isFollowUp`、当日新增条目和新增来源信息；同 cluster 只有在无新事实时才排除 | 同一事件的新动作、新数据或新影响可以进入日报 | 已完成 |
| DLY-03 | P0 | 代表条目不一定是当日证据 | 候选转换时优先选择当日新增条目作为日报代表；保留历史代表条目作为背景 | 日报候选的代表标题、发布时间和 URL 与当日新增内容一致 | 已完成 |
| DLY-04 | P0 | 多源证据传递不足 | 每个聚合候选附带 2～3 个当日代表来源的标题、摘要、来源名和发布时间 | 模型输入能区分“多源互证”和“单源历史累计” | 已完成 |
| DLY-05 | P1 | 入库日与事件日混淆 | 保留 `createdAt` 作为纳入范围，同时增加 `publishedAt`、`eventDate`、延迟抓取标记和时效分 | 旧事件延迟入库不会无条件成为今日头条；真正的当日新进展仍能保留 | 已完成 |
| DLY-06 | P1 | 候选快照不足以解释漏选 | 快照增加原始排名、去重原因、匹配的历史日报日期和补位过程 | 可以回答“为什么没有进入日报” | 部分完成 |

当前候选截断入口：[src/lib/events/service.ts:277](/Users/shawn/Documents/GitHub/infinitum/src/lib/events/service.ts:277)；日报过滤入口：[src/lib/daily-report/service.ts:830](/Users/shawn/Documents/GitHub/infinitum/src/lib/daily-report/service.ts:830)；候选转换：[src/lib/daily-report/service.ts:149](/Users/shawn/Documents/GitHub/infinitum/src/lib/daily-report/service.ts:149)。

### E. 日报输出校验

| ID | 优先级 | 检查项 | 建议动作 | 验收标准 | 当前状态 |
|---|---|---|---|---|---|
| DLY-07 | P1 | 跨栏目重复 | 按 cluster、事件主体+对象和来源 key 做 deterministic duplicate check | 同一事件不会同时出现在多个栏目，除非明确允许 | 已完成：生成后按 cluster、事件主体+对象、来源 key 和条目 key 复核 |
| DLY-08 | P1 | 只校验来源编号，不校验内容覆盖 | 检查选中候选是否来自合法候选、是否过度集中在低排名、是否覆盖当日新增 | 日报不会只引用合法但不重要的候选 | 已完成：记录高排名覆盖、当日新增覆盖、低排名入选和告警 |
| DLY-09 | P1 | 模板要求未完全落地 | 对可确定的栏目数量、空栏目、单条事件和来源要求做后处理校验 | 输出结构符合模板，失败时触发修复或安全降级 | 部分完成 |
| DLY-10 | P2 | 质量指标不够覆盖流程缺陷 | 在已有 fill rate、source diversity、miss rate、day overlap 之外增加重复率、当日相关率、follow-up 保留率 | 每次排序或候选规则调整都能看到收益和回归 | 未做 |

当前输出校验主要在：[src/lib/daily-report/validator.ts:41](/Users/shawn/Documents/GitHub/infinitum/src/lib/daily-report/validator.ts:41)；来源合法性校验在：[src/lib/daily-report/service.ts:637](/Users/shawn/Documents/GitHub/infinitum/src/lib/daily-report/service.ts:637)。

## 建议试跑顺序

### 第 0 阶段：建立基线，不改变线上行为

先保留现有逻辑，收集至少 3～7 天数据，或者对历史日报做离线重放。

记录：

- 每源 RSS 原始条数、时间窗内条数、未知时间条数和最终入库条数；
- 聚合候选截断数量、人工复核中的误合并/漏合并；
- 速览 Top 20 中当日首次出现事件的比例、历史 follow-up 比例；
- 日报原始候选数、重复排除数、过滤后候选数、补位缺口；
- 日报选中候选的当日相关率、跨栏目重复率、多源覆盖率和 follow-up 保留率。

验证：先确认指标能从现有快照和任务日志计算出来；不能计算的指标只补观测，不改规则。

### 第 1 阶段：先修确定性正确性问题

按以下顺序实施：

1. DLY-01：日报重复过滤后回填。
2. DLY-02：保留同 cluster 的真实后续进展。
3. DLY-03：日报代表条目优先使用当日新增证据。
4. ING-01 / ING-02：修复 RSS 截断顺序和缺失发布时间语义。

这一阶段不改变复杂排序权重，也不引入 alias。目的是真正消除“应该出现但在候选阶段丢失”的问题。

验证：

- 新增日报候选过滤、回填、follow-up 和异常发布时间测试；
- 运行日报、事件速览、抓取相关集成测试；
- 用一组固定历史数据比较候选数量、漏选率和重复率。

### 第 2 阶段：做速览排序的离线/影子试验

1. BRF-01：加入当日新增来源数和条目数。
2. BRF-02：加入有限新鲜度分。
3. BRF-03：拆分 follow-up 标签与新增事实强度。
4. BRF-05：先 shadow rank，再决定线上权重。

建议先保留旧 `rankScore`，新增一个实验分数并记录两者 Top-K 差异，不要一次性替换所有排序。

验证：

- 比较 Top 10 / Top 20 的人工命中率；
- 比较当日相关率和历史事件占比；
- 检查 source group、keyword、event type 偏好是否仍在有效范围内；
- 如果排序变化只提高“新”而明显降低质量，回调权重而不是继续堆加分项。

### 第 3 阶段：补日报证据包

1. DLY-04：加入有限多源证据。
2. DLY-05：加入事件日、发布时间和延迟抓取信号。
3. DLY-06：扩展候选快照，记录排除和补位原因。

证据包应有字符和来源数量上限，优先使用当日新增来源，不直接传递整个 cluster 的所有历史内容。

验证：

- 日报输入中每个聚合候选至少能看到多个当日来源（如实际存在）；
- 报告来源覆盖率上升，但输入规模没有失控；
- 多源事件的日报正文不再只依赖一个历史代表条目。

### 第 4 阶段：提高聚合召回

1. AGG-03：先确认候选上限是否真实造成损失。
2. AGG-01：补主体/对象 alias 和 canonical key。
3. AGG-02 / AGG-04：统一初次归组与 merge 的规范化规则。
4. AGG-05：用人工标注集验证 precision/recall，而不是只看 cluster 数量变化。

这一阶段应保持对象冲突、日期冲突、cannot-link 等误合并防护不变。任何 alias 扩展都必须配反例测试。

### 第 5 阶段：建立持续质量闭环

1. DLY-07～DLY-10：完善日报输出后检查和指标。
2. ING-04：补信息源级抓取质量监控。
3. 将人工复核结果回写为聚合评估样本。
4. 对排序、候选、聚合规则保留版本号，支持按版本比较质量指标。

## 依赖关系与关键路径

```text
基线指标
  ├─> 日报候选正确性修复 ─> 日报证据包 ─> 日报输出校验
  ├─> 速览影子排序 ────────┘
  └─> 聚合候选截断观测 ─> alias/canonicalization ─> 聚合评估集
```

关键路径建议为：

```text
基线 → 日报候选修复 → 速览排序试验 → 日报证据包 → 聚合召回优化 → 质量闭环
```

## 建议的停止/回滚条件

出现以下任一情况时，先停止扩大范围：

- 聚合误合并率明显上升，即使 cluster 数量下降；
- 速览当日相关率提高，但高质量事件命中率下降；
- 日报候选数量增加，但重复率或跨栏目重复率上升；
- 证据包导致任务耗时、输入量或失败率明显上升；
- 抓取修复使源站异常内容大量进入处理队列。

每个阶段只推进一个主要变量，保留旧结果和新结果的对照，确保可以判断收益来自候选召回、排序、证据还是输出校验。

## 验证命令建议

```bash
vitest run tests/integration/event-briefing.test.ts tests/integration/daily-report-service.test.ts
vitest run tests/integration/ingestion-service.test.ts tests/integration/background-task-service.test.ts
vitest run tests/integration/feed-api.test.ts tests/unit/feed-range.test.ts
npm run lint
```

宽改动收尾时再运行：

```bash
npm test
npm run build
```
