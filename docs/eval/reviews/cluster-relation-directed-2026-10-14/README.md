# 定向事件关系候选冻结包

状态：等待独立人工盲标，未获得正例真值，未进行AI回放，不是质量通过。

审核人只打开 [blind-review.md](blind-review.md) 或 packet/blind-review.csv。sources/sampling-manifest.json 与 packet/frozen-manifest.json 是私有采样/分组材料，不作为标注依据。

12对、24个互不重叠的簇；排除既有 blind/dev/holdout 中使用过的簇；按共享簇连通分量冻结 dev 8 / holdout 4。此次是30天定向挑战批，不能与7天总体候选准入率混报。原始来源、摘要和签名均从既有资格快照直接映射，未使用外部服务。

资格快照不含 isAggregation、原始全文或来源URL。综合稿候选依据摘要中的多次具体发生提名，不能宣称已按真实 isAggregation 筛选，不能将提名当成 synthesis 真值。明显日期冲突应允许 uncertain。

规范状态与独立 SHA256 信任锚：sqlite://artifact/evaluation/cluster-relation-directed-2026-10-14。这些文件是显式人工审核导出，SQLite Artifact 为规范状态。

后续：人工确认审核身份/时间 → assess → 检查四类真实标签覆盖与 uncertain → 不足则如实记录 → 冻结模型/Prompt/方法版本和调用预算后才运行当前策略对照。不得用模型补人工 gold，不根据留出集调整规则。
