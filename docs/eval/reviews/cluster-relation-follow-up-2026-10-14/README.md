# 新来源定向审核批

## 当前人工确认 v1

FN-01、FN-02 均经用户确认标为 **follow_up，不合并**：[reviewed-v1.csv](reviewed-v1.csv)，审计：[human-review-v1.json](human-review-v1.json)。规范登记：`sqlite://artifact/evaluation/cluster-relation-follow-up-reviewed-v1-2026-10-14`。

用户确认原话：“认可，按follow_up处理吧”。确认前已经看到助手对两例的关系建议及理由，因此这是**辅助人工复核，不是独立盲标**。助手依据单独注明来源，不冒充用户独立撰写的理由；CSV 的理由及未提供的审核完成时间留空，recordedAt 只表示登记时间。

冻结 dev/holdout 标记不变，但 FN-02 也不能作为独立 holdout 效果证明。本批有 2 个辅助确认的 follow_up 开发诊断例，新增独立盲标正例仍为 0；不混算此前 8 对或 12 对指标。原始空白表及冻结证据保持不变，未回放模型或修改线上。

下一步可将两例用于开发边界诊断；若要补独立盲标证据，需要新的未曝光样本，并在人工判断前不展示助手/模型建议。任何新付费对照仍需新授权。

以下保留原始冻结说明（“尚未标注”指冻结时状态）。

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
