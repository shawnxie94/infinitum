# PB-08～10 输入与准入只读诊断

规范记录：`sqlite://artifact/evaluation/cluster-relation-input-admission-diagnostic-2026-10-15`。

## 结论

1. 捕获时刻为2026-10-14T16:56:22.374Z；当前工作树配置的7天起点为2026-10-07T16:56:22.374Z。3组6簇的latestPublishedAt均在起点之前，状态active/sourceGate通过不改变超窗事实。只能认定该冻结元数据在当前查询语义下超窗，不能归因召回差或倒推事发时历史漏并。
2. 按当前工作树的生产构造函数投影，compact只去每侧cluster ID并加批内pair_id，其他非ID字段逐值相等。最终每侧含title、summary、eventType/Subject/Action/Object/Date和itemCount，不含保留原文、文章原发表时间或cluster.latestPublishedAt。这是输入契约，不等于本次证实“缺全文导致误判”。
3. 主体、具体产品和阶段线索仍在现有标题/摘要中。PB-09的研发/早期未明确计划与正式发布均保留；不能因为没有全文就优先扩Prompt或加大上下文。
4. 上游结构化字段存在可疑错位：PB-08的eventObject指向竞争者GPT-6 Astra，而报道主事件为Anthropic拟推尚未命名模型；PB-10左侧eventDate为2025-10-15，原稿发表于2026年9月，原文“10月15日”指未来完整权重安排而非当前全量开放。日期值在快照中已存在，且原样进入投影DTO，不能归因compact，更未证明是某版Prompt造成或实际触发了拒绝。

## 检查方法与边界

- 只读已冻结capture/source-cases和用户辅助确认，不重新读取业务库或网络，不导入service执行器，不加载密钥、模型或embedding。
- 当前代码：`src/config/constants.ts:56-57`为7天；`src/lib/clusters/service.ts:1767-1808`的loadRecentMergeClusters同时要求active、latestPublishedAt窗口及有效源成员，affected IDs路径也保留baseWhere，不能绕窗。仅阅读该查询，未执行Prisma业务路径。
- `src/lib/clusters/helpers.ts:1720-1757`构造字段；`src/lib/ai/protocols/cluster.ts:67-94`进行compact。本次逐值断言compact除ID外与raw DTO一致，原文锚点仅做词面存在检查，不把词面命中率当关系正确率。
- `raw-dto-projection.json`与`compact-dto-projection.json`是**人为指定真实6簇路由的序列化投影**，score=0是布局占位，不是召回分数/实际获准边，也不是可发送请求。未执行实体canonicalization，没有历史resolver/部署制品核验；不声称它们就是某次实际线上最终输入。
- 阶段先后明确：超窗后scan cap排序不必继续证明；dirty hash、BM25、向量、clean-pair TTL、历史decision、cannot-link/must-link及模型调用均标not_executed，不能伪造“缓存/约束放行/阻塞”结果。
- CodeGraph索引complete但有6个pending新增，本次小范围以现行符号源码和冻结字段为据，未重建索引。

## 采样说明更正

当前生产scan cap为2500，上轮source采样cap为1000，因此上轮README“提高至1000”的用词不严谨：它是诊断采样上限，不是提高线上上限。实际30天pool仅477、未触1000，故不影响本批窗口判断；保留旧包不改，在此补充区别。整个30天采样池并非完整当前生产池，禁止用其统计生产召回率。

## 文件与验证

- `case-diagnostics.json`：逐侧窗口、日期、字段锚点与未执行阶段。
- `report.json`：可验证结论及语义观察。
- `manifest.json` / `manifest.sha256`：锚定原捕获、辅助确认、代码和投影文件；诊断锚 `d9b1d8f0743f89946c5ca0db4f1f1fae4aa36a033fcebead9dbe5b78388f6ab5`。

```bash
node_modules/.bin/tsx .agent/tmp/cluster-relation-input-admission-diagnostic/diagnose.ts --verify
```

重建原文/确认引用链、输入投影、字段恒等、窗口与已观察日期异常，并核验所有输入/代码/文件SHA；结构验证不证明语义判断、模型效果或历史生产行为。诊断脚本未产生模型请求，不需要/不授予发送授权。

## 下一步

优先单独定位eventDate的**提取来源、年份锚点与日期角色**（当前事件发生日 vs 将来开源/上市日），同时检查eventObject是否把比较对象当主事件对象；先做可复现、跨类型的边界验证，再决定是否需修上游提取/校验。不要直接改聚类Prompt、线上时间窗或阈值，也不自动重跑旧文章写库。

若随后要验证真正候选召回，需要窗口内材料和真实当时快照/只读准入证据；不能用当前元数据把时钟拨回9月来伪造历史回放。PB-08～10仍只有辅助人工确认，独立新正例gold=0，指标null，qualityPassed/releaseEligible/readyForModelReplay=false。额外模型/embedding/外网/密钥/业务写入/提交均0；旧标签、旧包、授权与共享代码不改。
