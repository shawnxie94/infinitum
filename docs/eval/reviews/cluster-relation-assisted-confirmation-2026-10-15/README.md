# PB-08～10 辅助人工确认

规范记录：`sqlite://artifact/evaluation/cluster-relation-assisted-confirmation-2026-10-15`。

用户原样回执见 `user-confirmation.verbatim.txt`：“确认，和你建议一致”。按紧邻上一条表格映射为PB-08 same_event、PB-09 follow_up、PB-10 same_event，新增3个用户辅助确认。不是用户逐条输入的标签；mappingBasis明确记录整体确认到具体case的解析依据。

`reviewed-v1.json`/`.csv`绑定冻结handoff `0481b7d87f7b9077f4f6d0d7a90c8febb7a22bc61596ecc7718a4c23968110bf`、真实6簇和7篇材料，不改原包、空模板或AI建议。助手已提前披露建议，因此labelProvenance=assisted_human_confirmation，不能声称独立盲标或新独立holdout。

用户没有单独写依据、标注人身份或明确完整阅读确认；这些字段保持null/空白，不把助手理由伪装成人工理由。确认本身有效，已接收3个关系标签；但gold=null、独立新正例gold仍0，qualityPassed/releaseEligible/readyForModelReplay=false，指标null。

原文为30天源种子，不是当前7天生产准入的复现；源站全文/报道事实/主题独立性、实际准入/hash/TTL/约束/向量/触发范围未验证。不能据此宣称生产误并/漏并改善或填补独立follow_up评测缺口。

旧6个人工unrelated与PB07未确认状态不改；额外模型/embedding/外网补文/密钥读取/业务写入/提交0。本次用户确认不构成模型请求授权。后续若需正式评测，另补未披露预测的独立材料与实际人工依据，不能回溯改成本批独立标签。
