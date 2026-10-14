# 新来源关系盲标批

最新 dev 复核：[../cluster-relation-dev-recheck-2026-10-14/README.md](../cluster-relation-dev-recheck-2026-10-14/README.md)。SR-06 保持 same_event，理由注明为助手建议后确认；SR-01 的 follow_up 只是待验证倾向，已列待核，原 v1 标签不改，但暂不作已定边界证据。规范状态：`sqlite://artifact/evaluation/cluster-relation-dev-recheck-2026-10-14`。

## 当前人工标签 v1

用户已给出 SR-01～SR-08 的关系：[reviewed-v1.csv](reviewed-v1.csv)，登记审计及分布：[human-review-v1.json](human-review-v1.json)。规范登记：`sqlite://artifact/evaluation/cluster-relation-source-reviewed-v1-2026-10-14`。

- 全批：same_event 5 / synthesis 2 / follow_up 0 / unrelated 1 / uncertain 0。
- dev：same_event 4 / synthesis 1 / unrelated 1；holdout：same_event 1 / synthesis 1。分组未改。
- 用户未提供逐条理由或本批审核完成时间：字段留空，不补造。recordedAt 仅表示登记时间，审核人沿用本会话此前确认的 Shawn。
- 原始空白 CSV 与冻结包保留；未改旧 12 对 gold v4，未混算指标。没有模型预测，不计算准确率。
- 尚缺 follow_up 人工正例，文章级材料也不是生产 cluster_merge DTO；目前不具备完整五分类或生产回放资格。下一步另准备有明确新增动作证据的来源候选，由人工判断，不预填标签；任何新付费对照重新授权。

以下保留原始冻结时的审核说明（“尚未标注”指冻结时状态）。

规范登记：`sqlite://artifact/evaluation/cluster-relation-source-verified-freeze-2026-10-14`。

## 审核入口

- 阅读 [review-packet.md](review-packet.md)，按 SR-01～SR-08 给出关系和一句原文依据。
- 关系五选一：`same_event / synthesis / follow_up / unrelated / uncertain`。缺少具体发生或日期证据时可以 uncertain，不必凑类别比例。
- [blind-review.csv](blind-review.csv) 的 humanLabel、humanReason、reviewer、reviewedAt 全部留空。模型未预测任何标签。
- 8 对中 6 对 dev、2 对 holdout 在人标前固定。留出错误不用于调整候选规则或 Prompt。

## 冻结边界

- 16 个完整来源单元、16 个不同来源家族，每个来源只用于一对；没有把父早报偷换成拆分子条目，也没有沿用已混合的线上 cluster 快照。
- 15 份本地保留 RSS 正文，1 份免费公开网页抓取（少数派 115197，defuddle；访问时间见 sources.json）。少数派只保留八个新闻分节，确定性移除评论与网站运营区，未改写新闻正文。
- 使用 30 天来源发布时间窗；每对报道时间相差不超过 7 天。发布时间仅供定位，不当作事件发生时间；没有新造 eventDate。
- 已排除 216 个既有评测 cluster 对应的可追溯来源家族、URL，以及上轮核对过的来源。删除过的历史来源未完整重建，因此只证明与已知保留来源不重叠，不声称已证明所有历史事件互斥。
- 多数材料来自同一家二手资讯媒体。不同 URL 或来源家族不等于独立事实交叉验证，原稿的传闻、回应及背景范围仍须审核人判断。
- **这是文章/完整来源单元层诊断，不是生产 cluster_merge DTO 或端到端聚类评测。** 当前线上 DTO 尚未附带这些来源正文，不可直接将本批当作生产回放通过证明。若后续对接模型，需要独立的数据契约与冻结步骤。

## 证据与状态

冻结清单 [frozen-manifest.json](frozen-manifest.json) 的 SHA256：

`17c10e5d87601c793ca94a6aa34c5dd37c592c9a6c549b02c76545ce982a6c8e`

清单锚定 [sources.json](sources.json)、[cases.json](cases.json)、审核包与初始空白 CSV；旧标签、原 AI 回执、线上 Prompt/契约文件未改。来源发布时间和当前网页/RSS 不是历史原文逐字真实性证明。

结构、已知来源排除、来源家族互斥、冻结 hash、空白标签及旧材料保留校验通过。**关系类别覆盖仍未知，尚未获得新的人工正例，也未达到回放资格。** 0 新增模型调用，0 付费调用，未改线上。人标完成后先检查来源/具体发生和类别覆盖；任何新付费对照再次授权。
