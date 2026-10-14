# 定向事件关系候选冻结包

## 当前版本：人工更正 v2

用户确认 DR-07 为 `follow_up`，仅更正开发集这一条，原始 CSV、AI 回执及 v1 报告保持不变。当前标签为 [packet/blind-review.corrected-v2.csv](packet/blind-review.corrected-v2.csv)，重算见 [ai-one-round.corrected-v2.report.md](ai-one-round.corrected-v2.report.md)：关系一致 8/12、合并判断一致 9/12、误并 1、未识别同一事件 2。没有新增模型调用。

这条 follow_up 是看到模型分歧后的人工复核，不算新增独立盲标正例；当前仍非质量通过。规范审计：sqlite://artifact/evaluation/cluster-relation-gold-correction-v2-2026-10-14。以下保留 v1 阶段记录。

状态：人工标注已登记，assess 为 `ready_for_replay`；授权单轮 AI 判定已完成，存在关系分歧，不是质量通过。

MiniMax-M3，12 对单批、实际 1 次请求、0 次重试；完整返回 12/12。按原始人标，关系一致 7/12、合并/不合并一致 8/12、误并 1 对、同一事件未识别 3 对；synthesis 命中 0/2。总计 7298 tokens，19.176 秒，金额未测量。详见 [ai-one-round.report.md](ai-one-round.report.md)，规范证据为 sqlite://artifact/evaluation/cluster-relation-ai-once-result-2026-10-14。

- 审核人：Shawn；审核时间：2026-10-14T08:17:38.650025+00:00（用户明确同意以此次提交时间登记）。
- 原样保留 12 条标签：same_event 7、synthesis 2、unrelated 3、follow_up 0、uncertain 0；无模型代填。
- dev 8（same 4 / diff 4），holdout 4（same 3 / diff 1）。两组满足同一事件/不合并的二分类真值门槛，但缺 follow_up 真值，不能声称四类关系覆盖完整。
- 严格 7 天生产纯规则准入诊断已执行：139 簇语料，12 对均因至少一端超出窗口而排除，eligible 0/12，status=`diagnostic_incomplete`，各准入率为 null。这是覆盖不足，不是 0% 召回，也不是没有误并。
- 详见 [baseline-report.md](baseline-report.md)；该阶段不含 AI 判定及最终图合并。另行校验了全部 12 对 CSV 输入与冻结快照的逐字段映射；不可将其误写为基线脚本对全部 12 对进行了窗口内字段比对。

审核人只打开 [blind-review.md](blind-review.md) 或 packet/blind-review.csv。sources/sampling-manifest.json 与 packet/frozen-manifest.json 是私有采样/分组材料，不作为标注依据。

12对、24个互不重叠的簇；排除既有 blind/dev/holdout 中使用过的簇；按共享簇连通分量冻结 dev 8 / holdout 4。此次是30天定向挑战批，不能与7天总体候选准入率混报。原始来源、摘要和签名均从既有资格快照直接映射，未使用外部服务。

资格快照不含 isAggregation、原始全文或来源URL。综合稿候选依据摘要中的多次具体发生提名，不能宣称已按真实 isAggregation 筛选，不能将提名当成 synthesis 真值。明显日期冲突应允许 uncertain。

规范状态与独立 SHA256 信任锚：sqlite://artifact/evaluation/cluster-relation-directed-2026-10-14。这些文件是显式人工审核导出，SQLite Artifact 为规范状态。

已确认标签与登记证据：sqlite://artifact/evaluation/cluster-relation-directed-reviewed-2026-10-14。

后续：先复核开发集的事件身份口径（预告→正式发布、同一大会中的独立产品发布、综合覆盖与直接后续），保留人标不变，未经审核人确认不改 gold。口径稳定后再决定 Prompt/策略调整；候选准入与关系判定阶段分报，不改生产 7 天窗口制造覆盖。仍需另补独立人工 follow_up 真值，不根据留出集错题调整规则。单轮付费预算已用完，不自动追加调用；后续回放另需授权。
