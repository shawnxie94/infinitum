# 新来源定向审核候选（尚未标注）

规范冻结：`sqlite://artifact/evaluation/cluster-relation-follow-up-freeze-2026-10-14`。

审核入口：[review-packet.md](review-packet.md)，按 FN-01 / FN-02 给出 `same_event / synthesis / follow_up / unrelated / uncertain` 及一句原文依据。也可填写 [blind-review.csv](blind-review.csv)，不要为了补齐类别而改变实际判断。

- 2 对官方 GitHub 发布记录，4 份来源；FN-01 固定为 dev、FN-02 为 holdout，产品/仓库组互斥。组内两侧是有依赖的连续发布记录，不当作独立来源交叉证据。
- 保留原文发布摘要的逐字摘录、完整说明、官方页面 URL、GitHub published_at 与公开 API 访问时间。两次公开 REST API 抓取均无认证、免费，不是模型调用。
- 定向抽取候选，不是随机全盲样本；只对模型预测保持盲态，未预填标签。版本不同不预定任何关系。
- 本地剩余五个动作线索标题不足以证明关联的新动作，没有强行拼对。实际选中的官方记录都在当前 30 天内，每对发布相隔不超过 7 天，因此没有启用历史替代来源。
- **这是新来源发布记录级诊断，不是当前本地 DB 生产 cluster 候选，不表示通过线上候选准入或生产 DTO 回放。** 不是旧 8 对样本的标签更正，不混算其指标。尚无新增人工正例或模型预测，ready_for_replay=false。

[frozen-manifest.json](frozen-manifest.json) SHA256：

`5b4556ff02a859228857771d9d2dab1c303887be512dbde84618f112a8ae1973`

[sources.json](sources.json) 保留完整原文及摘录范围，[cases.json](cases.json) 固定分组。结构/逐字摘录/发布时间/已有来源排除/保留旧标签及 Prompt 的校验通过。0 AI/付费调用，未改线上或旧 gold。下一步登记人工标签，再核对是否真的补到 follow_up；不能把定向小样本当完整效果证明。任何新付费对照仍需新授权。
