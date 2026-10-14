# 开发集人工复核收口：v4

用户选择 DR-08=`synthesis`，由 v3 的 `same_event` 更正；保留 DR-04=`same_event`、DR-07=`follow_up`，并已确认 DR-03 维持 `synthesis`。本批开发集分歧标签已逐项复核，不再待补这四条用户决策。

当前人标：same_event 6、synthesis 2、follow_up 1、unrelated 3。标签：[packet/blind-review.corrected-v4.csv](packet/blind-review.corrected-v4.csv)；审计：[gold-correction-v4.json](gold-correction-v4.json)；重算结果：[ai-one-round.corrected-v4.report.json](ai-one-round.corrected-v4.report.json)。规范证据：`sqlite://artifact/evaluation/cluster-relation-gold-correction-v4-2026-10-14`。

| 切片 | 四类关系一致 | 合并/不合并一致 | 按当前人标误并 | 同一事件未识别 |
|---|---:|---:|---:|---:|
| 全批 | 9/12 | 11/12 | 0 | 1 |
| dev | 6/8 | 8/8 | 0 | 0 |
| holdout（未更正，仅汇总） | 3/4 | 3/4 | 0 | 1 |

## 已确认的开发集剩余缺陷

DR-03、DR-08 两对用户确认的 synthesis，AI 都判为 follow_up，关系精确命中 0/2。两种关系均不合并，因此不影响这两对的合并安全，但会影响关系展示和后续进展语义。开发集当前没有合并/不合并分歧，不能据此声称整体生产效果通过。

下一步聚焦综合稿与直接后续的判别证据：综合报道覆盖多个发生，不等于发生了后续动作；报道时间更晚不能单独证明 follow_up。先核对原文、日期及事件身份，再设计 dev 对照切片；不据 holdout 错题调规则，未授权不追加付费回放，不在本次更正中改线上 Prompt/策略。

## 保留与局限

- 无新增 AI 请求；原单轮 1 次请求、7298 tokens、19.176 秒的回执、预测和 v1-v3 标签/报告全部保留。
- 指标变化来自看过模型分歧后的开发集人工更正，不是模型改善，不增加独立盲标正例，也不是总体率或发布验收。
- DR-08 冻结材料仍缺原文/URL，左侧事件年份与原文时间矛盾尚未修复；用户选择分类不等于验证这些源事实。日期与材料歧义仍需在后续样本建设中显式处理。
- 更正后的 assess 为 ready_for_replay，仅说明二分类标注门槛满足；独立盲标四类覆盖与端到端生产效果仍不能由本批更正推导。
