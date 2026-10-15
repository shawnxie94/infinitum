# 当前 Docker 数据到生产 DTO 的离线桥接

规范记录：`sqlite://artifact/evaluation/cluster-relation-production-bridge-2026-10-14`。

本轮完成**生产输入形状与部分准入路径的桥接诊断**，不宣称完整运行链路等价。这里“生产”指仓库中线上代码使用的 DTO/分片形状；数据来自本机 Docker，不是远程生产主机。没有调用模型（含 embedding）、读取 API 配置或密钥、触发任务、更新业务数据库或提交代码。

## 最大差距：原 6 对不能直接平移

快照时间：2026-10-14T14:51:09.025Z。按原 item ID + 原 URL 核对；官方 release 外部 ID 只允许唯一精确 URL 匹配，不做标题猜测或子稿替代。

| 原来源 case | 当前库中的状态 | 为什么不能直接作为当前待合并 Pair |
|---|---|---|
| SR-02 | 两个不同 active 簇，最新发布时间分别 09-24、09-21 | 超过候选扫描 7 天窗口 |
| SR-04 | 两个 item 已在同一簇，簇有 2 条 | 不制造自配对，不拆成假单条簇 |
| SR-05 | 两个 item 已在同一簇，簇有 2 条 | 同上 |
| SR-06 | 两个 item 已在同一簇，簇有 3 条 | 原来源级“漏并”不是本快照中等待解决的 cluster Pair |
| SR-08 | 左侧为已处理的聚合父稿，无 clusterId；右侧簇也已过窗 | 不把 parent roundup 偷换为某个 child item |
| FN-01 | 两个官方 GitHub release 均未在当前库匹配到 item | 不伪造 item、summary 或事件字段 |

因此原 6 对中，**0 对可直接平移为此快照的模型候选 Pair**。这个结论是状态映射，不是重新标注。上轮 4/6→5/6 只对来源增强 dev 输入成立，不可当作当前生产漏并已修复；本轮没有写库，也不把当前已同簇状态归因于草案。

所有新路由的 gold=null、requiresClusterLevelReview=true，原来源标签、AI 判断/理由、辅助确认都不迁移成 cluster gold。当前簇已有 summary/事件签名是保存的分析结果，不是人工事实真源；簇包含的文章及语义范围也可能比原来源更广。

## 当前库的形状探针

`packet/`：

- snapshot.json：单条 SQLite SELECT 的一致性读快照，含 12 个精确 ID/URL 匹配的 item 元数据与 161 个相关簇；包括 parent 共有 URL 的子稿元数据，但映射优先精确原 ID，不替代父稿。
- inventory.json：固定 6 dev 的身份引用；保留 holdout 身份只存 hash，不含其正文、标签或推理。读取时用身份/URL和递归子孙关系排除已知保留家族所在簇。
- dto-with-ids.json：调用当前 `buildClusterMergeInput` 生成的内部 DTO。
- model-batches.json：调用真实 `splitClusterMergeInputBatches` 和 `compactClusterMergeInputForModel` 后的模型输入形状，**不是请求或可发送队列**。
- routing.json：按 `(batchIndex,pairId)` 关联真实 cluster ID；每批 p1..p3 重新开始，不能沿用原来源单批 p1..p6 的映射。
- bridge-report.json：source case 状态、部分选择诊断及明确的未覆盖项。
- manifest.json / manifest.sha256：文件与代码指纹，绑定原来源包，禁止覆盖。

实际快照：7 天范围、满足当前 source gate 且排除已知 holdout 家族后的 **156 个簇**；42 个 dirty。纯 BM25/事件指纹路径选中 63 个簇、**122 对 pre-block probe**，按线上每批 3 对形成 **41 批**（最后 2 对）。计数刷新在内存模拟，存量计数此次无需变化，未 UPDATE 数据库。

**122 对不等于最终会被发送的 122 对**。它们没有新 gold，也没有家族/簇独立性保证；一个簇可出现在多个图边中。这是 DTO 探针，不是新的盲测集，不得直接拿原 6 对的标签覆盖它们或发完 41 批。待核 SR-01 没有作为 source case 参与映射/评分，其标签仍隔离；普通候选探针不作新增语义评测，未来抽样还需核对未定/保留家族隔离。

## 输入结构的变化

来源增强输入用原文 sourceEvidence，summary/事件签名为 null、itemCount=1（单来源记录）。当前生产 DTO 改为真实 cluster.title/summary、保存的五个事件字段经已有 helper 规范化、processed+allowed/restored 的真实计数以及实际本地 score；**不从发布时间构造 eventDate**。

模型看到的字段：pair_id、score、left/right 中 title/summary/eventType/eventSubject/eventAction/eventObject/eventDate/itemCount；cluster ID 在压缩时移除，sourceEvidence/url/contentText/人工标签不进入模型形状。

候选回溯按 `clusters.latestPublishedAt` 7 天，这是 merge 的现行规则；**公共 Feed 仍按 items.createdAt 时间过滤**，未修改或混用两者。

## 准入链路：已核对与未复现

CodeGraph 在开始时 complete、pendingChanges=0，定位结果按当前源代码核对。本轮只新增离线脚本/测试/证据，不改共享源码。关键路径：

| 步骤 | 源码位置 | 本轮证据范围 |
|---|---|---|
| 标记 orphan decisions / 刷新计数 | service.ts:1834、1728 | 不执行任何写路径；计数 SELECT 后仅内存映射 |
| recent scan | service.ts:1767 | active、7天、processed/allowed/restored、source aggregationEnabled 或 child、排序/2500上限；剔除保留家族后是审计子池 |
| entity aliases | service.ts:1745 | 仅核对路径，未读 resolver 状态或 canonicalize |
| live vector recall | service.ts:1848 | 不调用 embedding；因此不等价于有向量通道的线上集合 |
| dirty/BM25/事件指纹 | helpers.ts:1507 | 复用纯 helper、保留 mergeInputHash，不强制 dirty 或解除规则；作用于上述审计子池 |
| clean cache | service.ts:1371、1899 | 未读或合并 cache、TTL/attempt/hash/clean 条件；可能补充候选 |
| cannot_link/历史declined/review阻塞 | service.ts:1553 | 未复现状态过滤；可能删减候选 |
| all-clean skip | service.ts:1967 | 记录无 cache 分支的快照条件，不冒充完整运行判定 |
| DTO→分片→压缩 | helpers.ts:1720、protocols/cluster.ts:51/67 | 真实函数重建；每批3对、移除ID、局部短ref |
| 输出/聚合父稿/传递性安全守卫/执行合并 | service.ts:2043-2150 | 不调用 AI，不运行这些写/执行路径 |

所以 matchedCurrentDtoBuilders=true，但 finalCandidateAdmissionMeasured=false、productionRuntimeCodeEqualityVerified=false、readyForModelReplay=false、releaseEligible=false。没有证明当前 Docker 镜像的打包代码与宿主机这些源码完全相同，也没有覆盖当前任务触发时的 liveClusterIds。

## 验证

- 新增 **18 项**桥接测试，含自配对/缺失/父子/ID漂移/旧簇/非法池/clean保留/保留家族/3对分片与局部refs/只读SQL/严格字段/不可覆盖/重建校验。
- 桥接 + 现有候选/协议 + 原输入测试共 **76/76 通过**；新代码定向 ESLint 通过。
- 实际只读 Docker 抓取→真实 helper 生成→冻结→按外部可信 SHA 重建验证成功。
- 模型请求 0、密钥读取 0、业务写入 0，未 stage/commit/push；旧包、gold、草案和前轮代码指纹不动。

```bash
node_modules/.bin/tsx scripts/prepare-cluster-relation-production-bridge.ts --verify \
  docs/eval/reviews/cluster-relation-production-bridge-2026-10-14/packet \
  8972f3375abc15df9a0e587377ff9c0e9bee15b7def09999e6a90382a739df45
```

源包锚仍 `1495ed0fb7576e0304e9045554abb4ad77d18b88be7bf83bf454396146b4fb40`，桥接锚为上面的 SHA。校验只用冻结快照与代码重建，不重新抓活库，避免后台变化被混为数据漂移。

## 下一步

继续免费、只读补**最后准入状态过滤**：entity resolver、可复用现存 cache、cannot_link、declined/review 等；无法无调用重建的向量召回明确留作边界，不伪造。然后从更接近最终准入的真实不同簇里抽少量、家族不重用的样本，独立标 cluster 关系（特别是 follow_up）。未有新 gold/完整准入范围及付费授权前，不发这 41 批，也不把来源级改善应用线上。
