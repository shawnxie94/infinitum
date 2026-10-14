# 单轮 AI 关系判定对照

阶段：`directed_relation_ai_judgment_single_round`。仅评估冻结材料上的关系判定，不是候选准入、最终图合并或生产总体质量；`releaseEligible=false`，不调整线上策略。

## 授权与冻结

- 用户授权：12 对，一轮，不自动重发。实际以 12 对单批执行，1 次外部请求，0 次重试/回退请求。
- 模型：MiniMax-M3；当前本地运行容器的聚类默认模型及用户指令，当前仓库代码拥有的 cluster_merge system contract；temperature=0，maxTokens=2000。
- 配置与输入冻结：[ai-one-round.freeze.json](ai-one-round.freeze.json)。凭证只由 macOS Keychain 读取到执行内存，未写入材料或日志。
- 原始非敏感请求/响应回执：[ai-one-round.receipt.json](ai-one-round.receipt.json)。请求只含冻结标题、摘要、事件字段及条目数，不含人工标签、采样提示或人工身份。
- JSON 结果：[ai-one-round.report.json](ai-one-round.report.json)。独立 SHA256 锚与规范状态：`sqlite://artifact/evaluation/cluster-relation-ai-once-result-2026-10-14`。

## 结果

| 切片 | 返回 | 四类关系一致 | 合并/不合并一致 | 按人标误并 | 同一事件未识别 |
|---|---:|---:|---:|---:|---:|
| 全批 | 12/12 | 7/12 | 8/12 | 1 | 3 |
| dev | 8/8 | 4/8 | 5/8 | 1 | 2 |
| holdout（仅汇总） | 4/4 | 3/4 | 3/4 | 0 | 1 |

- 人工 same_event 7 对中，AI 正确识别 4 对；人工不合并 5 对中，AI 正确拒绝 4 对。
- 人工 synthesis 2 对均未被 AI 判为 synthesis（分别判为 follow_up、same_event）；本批 synthesis 精确命中 0/2。
- 输入 6237 tokens，输出 1061 tokens，总计 7298 tokens；耗时 19.176 秒。金额未测量，不能把 token 量等同于实际账单。
- 无缺失或调用失败。本轮一次正常返回不能证明稳定性，未追加调用验证。

## Dev 分歧（不据 holdout 逐题调参）

| Case | 人标 | AI | 需要复核的边界 |
|---|---|---|---|
| DR-03 | synthesis | follow_up | 全家桶/硬件综述与单一机器人发布：多事件覆盖，还是具体后续？AI 将“同期展开”也解释为 follow_up。 |
| DR-04 | synthesis | same_event | 同一场大会主旨演讲的精简报道，还是多个独立发布事件的综合覆盖？事件身份应按具体发布动作还是整场大会界定。 |
| DR-07 | same_event | follow_up | 发布会预告与正式发布/评测：按当前“同一次发生”的定义，应与“同一产品”身份区分；人标需明确采用哪种业务口径。 |
| DR-08 | same_event | follow_up | 大会上的硬件/智能体发布与后来宣布落地：是重述此前动作，还是新发生？仅靠摘要与存在冲突的日期未必足够。 |

以上只是分歧复核问题，不预判模型正确，也不改动人工 gold。没有原始全文/URL/真实 isAggregation 的资格快照不能消除所有边界歧义。

## 下一步与限制

1. 先由审核人确认开发集中的事件边界，特别是“预告→正式发布”以及“整场大会→独立产品发布”的口径；标签若有更正，追加审计版本，保留原始提交和本次回放。
2. 口径稳定后再判断是否需要改 Prompt/策略；只基于 dev 开发，不根据 holdout 错题调参。
3. 本批无 follow_up 人工真值，仍需独立补标；不能把模型的 follow_up 预测当人工正例。
4. 这是 30 天定向挑战批，不是总体率。另行严格 7 天准入诊断覆盖为 0/12，不能把两阶段指标混报或放宽线上窗口制造覆盖。
5. 单轮预算已用完；后续任何付费回放须另获授权，失败/未知结果也不得自动重发。
