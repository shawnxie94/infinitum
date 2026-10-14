# 人工标签更正 v3：DR-04

用户确认：同一场云栖大会主旨演讲的不同详略报道按 `same_event`。DR-04 从 `synthesis` 更正为 `same_event`；保留 v2 的 DR-07=`follow_up`。其余标签不变，未新增模型调用。

当前标签：[packet/blind-review.corrected-v3.csv](packet/blind-review.corrected-v3.csv)。审计：[gold-correction-v3.json](gold-correction-v3.json)；结果：[ai-one-round.corrected-v3.report.json](ai-one-round.corrected-v3.report.json)。规范证据：`sqlite://artifact/evaluation/cluster-relation-gold-correction-v3-2026-10-14`。

| 切片 | 四类关系一致 | 合并/不合并一致 | 按当前人标误并 | 同一事件未识别 |
|---|---:|---:|---:|---:|
| 全批 | 9/12 | 10/12 | 0 | 2 |
| dev | 6/8 | 7/8 | 0 | 1 |
| holdout（未更正，仅汇总） | 3/4 | 3/4 | 0 | 1 |

当前人标：same_event 7、synthesis 1、follow_up 1、unrelated 3。唯一 synthesis 正例 DR-03 仍被 AI 判为 follow_up，精确命中 0/1。剩余开发集分歧为 DR-03 与 DR-08。

v1、v2 标签和报告、原始 AI 回执/决策均未覆盖。原模型请求仍仅 1 次、7298 tokens；本次只是离线重算。指标变化来自看过分歧后的人工 gold 更正，不是模型或策略改善，不增加独立盲标真值；0 误并仅限这批更正后的定向诊断，不能外推生产总体质量。线上策略未改，不以 holdout 错题调参。
