# 人工标签更正 v2：DR-07

用户确认：发布会预告 → 正式发布/评测按 `follow_up` 区分，DR-07 从 `same_event` 更正为 `follow_up`。更正记录见 [gold-correction-v2.json](gold-correction-v2.json)。仅开发集这一条标签变化，原始提交、CSV、AI 请求/响应与 v1 报告均保留不变。

当前标签：[packet/blind-review.corrected-v2.csv](packet/blind-review.corrected-v2.csv)；离线重算结果：[ai-one-round.corrected-v2.report.json](ai-one-round.corrected-v2.report.json)。独立审计锚：`sqlite://artifact/evaluation/cluster-relation-gold-correction-v2-2026-10-14`。

## 重算结果

| 切片 | 四类关系一致 | 合并/不合并一致 | 按当前人标误并 | 同一事件未识别 |
|---|---:|---:|---:|---:|
| 全批 | 8/12 | 9/12 | 1 | 2 |
| dev | 5/8 | 6/8 | 1 | 1 |
| holdout（未更正，仅汇总） | 3/4 | 3/4 | 0 | 1 |

当前人工标签：same_event 6、synthesis 2、unrelated 3、follow_up 1；synthesis 精确命中仍为 0/2。DR-07 的 AI 预测原本就是 follow_up，更正后不再计作模型错误。

- 新增模型请求：0；原单轮 1 次请求、7298 tokens、19.176 秒的记录不变。
- 指标变化仅来自人标更正，不是模型或策略改善，也不是新增回放。
- 这是看过模型分歧后的开发集人工复核，不是新增独立盲标 follow_up 正例，不能因此声称四类关系已得到独立验证。
- 更正后的 assess 仍为 `ready_for_replay`；本批仍是定向诊断，不能外推总体率或视作发布通过。
- 剩余开发集分歧为 DR-03、DR-04、DR-08；原始分歧报告只作为 v1 历史，不能以模型结论直接覆盖 gold。后续先确认事件边界，不从 holdout 错题调规则。
