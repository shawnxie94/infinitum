# PB 人工关系标签 v1

规范记录：`sqlite://artifact/evaluation/cluster-relation-production-blind-labels-2026-10-14`。

收到用户对 PB-01～PB-06 的直接标注：**6 对全部 unrelated**。`user-submission.txt` 原样保留回复，`reviewed-v1.csv/json` 关联冻结盲包的 case/cluster 路由；没有覆盖原盲页、空模板、旧包、gold 或代码指纹。

来源记为 user / human_user_submission_relation_only。用户没有提供每对依据、完整阅读确认或实际盲标过程确认，这些字段明确留空/未验证，不由助手补理由，也不重判关系。收到人工关系标签6条，不宣称6条已完成来源审查的独立gold。

分类计数：unrelated=6，same_event/follow_up/synthesis/uncertain=0。因此这是**人工标注的纯负例小批**，可作为后续误并检查输入；尚不能验证漏并、follow_up 识别或整体关系能力。模型未运行，准确率、误并率、漏并率全部未计算（null），不把“6条候选均 unrelated”当成模型已经误并。

模型请求/密钥读取/业务数据库写入均0；不调Prompt、改准入规则、发请求、提交。qualityPassed/releaseEligible=false。原盲包SHA仍 `fa551275c112e5947436fd751400e4d25f5c9b28173b0b4d3c8b00b8d3e3318f`。

验证：原盲包完整重建通过；本轮回执/CSV/JSON/路由/分类计数/缺失证据/null指标/新hash/旧空模板一致性校验通过。新结果收录与材料准备分开，旧报告的“收到0条”保留其历史快照语义。

下一步优先补独立的 same_event 与 follow_up 正例，不因缺正例而改这6条标签。需用于严格gold/回放时，再确认已看完整A/B文章且未先看内部模型判定，并补简短依据；任何新模型请求仍需独立授权。
