# 定向事件关系候选冻结包

状态：人工标注已登记，assess 为 `ready_for_replay`；未进行 AI 判定回放，不是质量通过。

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

后续：冻结模型/Prompt/方法版本与明确调用预算，再对本批 30 天挑战样本进行 AI 关系判定对照；候选准入阶段与关系判定阶段分报，不改生产 7 天窗口来制造覆盖。仍需另补独立人工 follow_up 真值；不得用模型补人工 gold，不根据留出集调整规则。
