# 生产 DTO 桥接：只读状态准入层

规范记录：`sqlite://artifact/evaluation/cluster-relation-admission-state-2026-10-14`。

范围：在本机 Docker 数据上，补冷启动实体别名、已有 clean 缓存、cannot_link 和历史判定阻塞；仅生成离线 DTO 探针，不调用模型/embedding、不读密钥或 API 配置、不改业务库/线上代码/旧证据，不提交。

## 结果

快照时间 **2026-10-14T15:28:57.226Z**。业务快照与所需状态在同一 SQLite 只读事务中取得：156 个候选簇、205 条 processed+allowed/restored 簇成员；只保存本池所需的 239 个实体/10 个别名、全局排序上限后的 80 条 cache、0 条匹配 cannot_link 与 422 条相关历史元数据。没有 reasonText、人工来源标签或模型新结果。

| 同一快照中的步骤 | 候选对数 |
|---|---:|
| 原始保存字段 + BM25/事件指纹 | 122 |
| 冷启动 DB 别名规范化 + 同样的选择器 | 108 |
| 现有 clean cache 补充 20 对 | 128 |
| 历史拒绝判定阻塞 8 对 | **120** |

22 个簇的 subject/object 被已有实体名规范化；raw dirty=42、canonical dirty=38。别名会改变召回/排序与输入 hash，108 不是简单从原集合删14条。Cache 全局先按 version/TTL/score/updatedAt/id 取80条，再验证原始 hash、clean、attempt、稀疏/向量安全和候选上限；本轮新增20条达到消费上限，另记录 attemptSkipped=1、invalidSkipped=17。缓存20条均有归因，其中过滤后的4对有**已保存的 vector recall**，没有生成向量。Cannot_link 命中0、review命中0，历史拒绝命中8；拒绝类包含 follow_up/synthesis/unrelated，不仅 unrelated。

120对形成40个三对批次。**它们是明确边界的 shadow 探针，不是完整线上发送队列、盲测gold或效果结论**。gold均null，不发送这40批。

原6个 source case 映射状态未变：SR04/05/06已同簇；SR02过窗；SR08父综合稿无簇，不能以child替代；FN01两release不在库。旧来源级得分不迁移，辅助FN01也不替代独立盲标follow_up。

## 如何复用生产规则

不复制业务判定阈值，不 import 带业务写路径的 service 入口。新脚本用 TypeScript AST 从当前源码取**显式白名单函数/常量**，去掉 export，转译后在独立执行上下文内调用；生产函数的 Prisma 查询由严格只读、冻结内存表适配：

- service.ts：canonicalizeClusterMergeEntityMentions、loadStoredCleanMergePairs、mergePrecomputedCleanPairs、filterBlockedClusterMergeEdges 及其少量纯依赖。
- mention-resolution.ts：原 cold resolver、别名覆盖实体的顺序和规范化key；不读取真实进程的常驻cache。
- constraints.ts：原 cluster-cluster 和 processed/allowed/restored cross-item cannot_link；保留 expiresAt>now 的边界。
- decisions.ts：原 kind/pairKey/**canonical inputHash**、appliedAt、最新createdAt/id、uncertain、拒绝次数上限和cooldown。
- helpers/protocols：原 raw cache hash、BM25/事件指纹、DTO、3对分片与压缩；批内p1..p3必须由(batchIndex,pairId)路由。

内存查询适配保留 SQLite 原始存储类型的排序（历史createdAt可为TEXT或整数）和BINARY id顺序；返回记录再转成Date。未知查询能力失败退出，不让生产resolver的fallback悄悄掩盖适配错误。这个上下文是受信任源码的离线执行适配，不宣称抵抗恶意源码的安全沙箱。

实际 pipeline 在开头会将 orphan uncertain 标 stale。本轮禁止 UPDATE，在抓取历史时排除同等 orphan uncertain（缺left/right或簇不存在）；不排除拒绝类 orphan，不改变其他业务规则。

## 家族、盲标与剩余边界

- 固定6dev以外的原来源家族都排除，包含待核SR01及3个holdout；ID/URL仅用于查找根及递归后代，持久化引用只留hash，不加载保留原文/人工标签。相应整个簇不进入本审计池。
- 全局cache截取在本池无效检查**之前**，不先丢掉池外行再补满80而夸大cache召回；池外cache只有身份/hash/数值元数据，不进入DTO。
- 尚未执行新的 live embedding/向量邻居，也不伪造缺失通道。已有cache的向量相似值可以按原规则复用。
- 未捕获真实任务liveClusterIds、运行进程内陈旧resolver cache或证明Docker打包代码等于宿主机源码。镜像ID只是环境出处，不是代码等价证明。
- 为保护家族而剔除数据的审计子池会改变全库BM25上下文；不宣称与未剔除的整库严格等价。
- allHashesMatch=false、无实时向量分支的结构skip条件=false；这不是调用许可，未读provider配置。模型之后的综合稿/传递性/最终执行守卫不运行。
- 120条边可重用同一簇，没有新gold或家族独立性证明。下一轮应抽少量家族不重用的不同簇；**独立盲标包只展示原始文章，不展示本包历史关系、已有summary/签名、score或召回归因**，避免先看判断再补标签。

`fullProductionAdmissionEquivalent/readyForModelReplay/qualityPassed/releaseEligible` 仍全部false。

## 冻结与校验

`packet/`：snapshot/state/inventory、原DTO、压缩后的model-batches、gold=null的routing、阶段clusters/edges、report、manifest及SHA；10个新冻结文件。模型形状不含sourceEvidence、原文、URL、cluster ID或人工标签，只有真实title/summary/保存的事件字段/计数/score及批内ref。

- **20项新增测试** + 原桥接/候选/协议共 **78/78通过**；新脚本与测试定向ESLint通过。
- 系统sqlite3在内存库执行实际两条SELECT事务，覆盖递归保留家族、orphan处理及query_only拒绝写入；不新增Node内置SQLite版本/类型依赖。
- 实际Docker readonly抓取→执行白名单生产函数→DTO生成→冻结→可信外部SHA重建通过。
- 上轮冻结包的SHA/文件/代码复验通过，没有改写上轮包；0模型/0embedding/0密钥读取/0业务写入，未stage/commit/push。
- 全库 `tsc --noEmit --incremental false` **未通过**：现存RouteContext生成类型缺失、旧v2 replay literal SHA类型及旧offline-input负例类型错误；本轮两份新增代码诊断为0。不改已绑定的旧脚本/指纹来掩盖这些问题，不声称全库编译通过。

```bash
node_modules/.bin/tsx scripts/prepare-cluster-relation-admission-state.ts --verify \
  docs/eval/reviews/cluster-relation-admission-state-2026-10-14/packet \
  04215bfd953cd798ca8e968a199091c91638077a353c10b29d9921e869915f71
```

上轮锚：`8972f3375abc15df9a0e587377ff9c0e9bee15b7def09999e6a90382a739df45`。
镜像：`sha256:579a05517ff5e3b90ea2975526ea1470a7b2ff0b0e08fe96c0a8b91da36ee5d4`。
校验从冻结数据重建，不重新读取会变化的活库。此脚本无send模式；后续模型请求仍须新授权。

下一步：准备一小批家族不重用、覆盖follow_up可能性的真实不同簇原文盲标材料，先人工标再看模型，不能把已有历史阻塞关系当gold或以历史错误热调Prompt。
