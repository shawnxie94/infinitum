# 正例来源种子探针

规范记录：`sqlite://artifact/evaluation/cluster-relation-positive-seed-probe-2026-10-15`。

给标注者：只打开 `blind.html`，独立读 PB-07 的全部 A/B 原文，回复关系与简短依据。可填空白CSV的副本，不修改冻结文件；不要先看audit或内部簇字段。关系仍为same_event / follow_up / synthesis / unrelated / uncertain，不因为这是“正例种子探索”就强判正例。

## 结果

排除先前6对后，原冻结材料剩20个簇/25篇原文，没有共享明确版本/产品标题锚点的不同簇组合。没有重新随机抽无锚点的负例。

扩大到本地7天active原文池，仍排除所有旧20个source、已标17篇出处及其递归后代/相应簇、聚合稿与AI拆分子稿：新事务快照2026-10-14T16:27:17.584Z，141个池内簇，抓取74篇原始文章/67个簇；54个簇具有完整有效成员及每篇充足保留正文。

按原始title的明确产品/版本 token 或完整引号内事项名称做确定性锚点匹配，不用AI摘要/签名、历史预测或score；跨侧/跨case不得复用已知身份及规范化出处家族。只找到**1对、3篇文章：PB-07**。不降低来源门槛、不拆同簇造不同簇、不复用旧标签来凑正例。

匹配是富集候选的启发式，不是关系判断或gold，也不保证同一产品版本就属于同一事件。本批正例标签收到0；等待用户独立标注，不能先填same_event/follow_up。所有旧6个unrelated标签保持原样，不因缺正例而改标。

## 与生产准入分开

PB-07 **不在上一轮冻结120条post-state准入边中**。这里是从更广的原始文章池发现的source-seed，生产准入条件、hash/TTL/约束/向量/触发范围没有重新全链复现。不能仅据此称“线上漏并”，也不能用它直接跑旧的生产回放队列。

标注后若为same_event/follow_up，再分别检查实际候选准入原因及对应DTO；若unrelated/uncertain，保留该结论，不倒推调整Prompt。已同簇材料也不能拆成假生产Pair。主题/事件holdout独立性、源站全文完整性未证明。

## 盲面与验证

盲面 `blind.html`/`blind-cases.json` 只含原始title、出处、已知原发表时间、全部保留原文及材料性质；无建议关系、AI摘要或译题、事件签名、score、锚点高亮、gold、cluster ID。`audit.json`的锚点/真实路由/生产准入出处仅供标注后的内部检查，不先给盲标者看。

验证：旧冻结盲包及上游链重建；锚点匹配正/负/纯版本边界断言；新字段严格schema、父子/身份/材料与出处约束；文件SHA核对；从新快照重建blind JSON/HTML/CSV/报告/路由。实际业务数据以readonly/query_only事务取得，静态页面沿用已测全文转义及禁网络渲染。这里只是定界数据探针，没有改共享代码，也不宣称新增完整模型评测。

```bash
node_modules/.bin/tsx .agent/tmp/cluster-relation-positive-seed-probe/probe.ts --verify
```

新manifest SHA见 `manifest.sha256`，绑定旧盲包锚 `fa551275c112e5947436fd751400e4d25f5c9b28173b0b4d3c8b00b8d3e3318f`。模型/embedding/外网补文/密钥读取/业务写入均0；不stage/commit/push。qualityPassed/releaseEligible/readyForModelReplay=false，新增模型请求仍须独立授权。
