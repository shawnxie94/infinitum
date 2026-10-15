# 真实不同簇原文盲标包

规范记录：`sqlite://artifact/evaluation/cluster-relation-production-blind-pack-2026-10-14`。

**给标注者：只打开 `packet/blind.html`。先读完整的 A/B 文章，判断整个簇的关系，再回复 PB-01..PB-06 的 relation、依据和标注者。不要先看 audit/capture 或上轮模型/历史判定。**

关系：same_event / follow_up / synthesis / unrelated / uncertain。不要为了补正例而选 follow_up；保留正文不足以判断时选 uncertain。可填写 `labels.blank.csv` 的副本，不修改冻结空白模板或其他 packet 文件。

## 已准备，不等于已标注

6 对、12 个不同簇，共 **17 篇保留原文**。采集时间2026-10-14T15:59:42.037Z，从上轮冻结120条状态过滤探针中筛选。独立人工标签收到0、独立确认follow_up仍0；qualityPassed/releaseEligible=false。

本轮不调用模型/embedding、不访问源站补文、不读密钥或API配置、不触发任务/改业务库/线上Prompt、不提交。没有生成建议判定或把历史关系当gold。

## 样本来源与隔离

- 排除所有20个旧来源身份（包含既有dev、holdout、待核SR01），按ID/URL识别根和递归后代，相关整个簇不进入新抓取正文。引用只持久化hash。
- 不用聚合父稿或AI拆分子稿冒充原始单篇，簇内任何processed/allowed/restored成员为此类就排除整个簇。
- 原始title、发表时间（未知明确留空）及保存的fullText/RSS正文，仅从本机Docker同一只读事务取得；不用translatedTitle、summaryText、rssExcerpt、事件签名、score或历史关系。
- 簇的原始输入hash及完整有效成员ID集合必须与上轮候选快照一致，发生变化则跳过；每个入选簇所有有效成员都展示，不把singleton片段当整簇。
- 正文去HTML噪音并解码实体，不按32k截断；每篇至少350个保留文本字符。fullText不够时才尝试RSS内容；没材料就拒绝，不合成内容。
- 42条边满足原始材料检查，再按固定hash顺序和原发表时间差做3/3分层，选6对；没有按预测关系、分数、签名或看原文猜标签来挑follow_up。时间差分层不是gold、并不保证有follow_up。
- 所有case之间不重复cluster、item身份或规范化出处URL；A/B之间也不能共享来源家族。URL保守统一HTTP/HTTPS并剔除常见tracking参数，不按标题或模型主体猜来源身份。
- 贪心曾只能找到5对，不能因此复用家族或降低正文要求；最终用固定大小回溯找到了合规6对、3/3分层。旧快照/抽样阈值不修改。

此处“家族独立”是已知原始身份/出处及父子关系层面的隔离，**不是语义主题/事件家族独立性证明，也不是独立holdout**。保留fullText/RSS不等于已检查源站完整全文。原文采集只核对输入/成员没有漂移，没有重新证明当前全部最终准入条件；新live embedding、触发liveIds、运行进程cache和镜像代码等价的边界沿用前轮。

## 盲面与内部审计

盲面：`blind.html`、`blind-cases.json`、`labels.blank.csv`。只展示case编号、A/B的全部原始文章、出处/原发表时间、保留正文及材料性质，不展示模型判断/理由、AI摘要或标题、事件签名、score、抽样stratum、真实cluster ID、gold。

页面为静态HTML，全文字段转义，CSP禁止脚本、网络资源和form；URL以文字显示，不自动加载图像或外部内容。没有JavaScript、服务端或隐式请求。

内部审计：`capture.json`（含只为漂移检查的簇字段与原文）、`inventory.json`、`audit.json`（路由/来源hash/分层，gold=null）、`report.json`、manifest及SHA。内部文件不是给盲标者先读的材料；不要把它们一起当“盲包”发送。

## 验证

- **17项新增测试**，连同已有准入/桥接共**55/55通过**；定向ESLint通过。
- 覆盖原文/成员全量、旧来源隔离、父子/聚合/短文拒绝、cluster与URL家族不复用、输入漂移、未知日期、全文不截断、HTML字段转义与禁止网络、按hash稳定且无score影响、贪心陷阱回溯、空白模板/禁止覆盖/外部SHA/篡改拒绝。
- 实际只读Docker事务→原文抓取→筛选→静态盲面+空模板→冻结→可信SHA重建已通过。旧准入包及其上游绑定复验通过，不改旧文件或代码指纹。
- 新2文件类型诊断0；全库tsc仍因既有RouteContext生成类型/旧replay SHA类型/旧offline-input负例问题未通过，不声称全库编译通过。

```bash
node_modules/.bin/tsx scripts/prepare-cluster-relation-production-blind-pack.ts --verify \
  docs/eval/reviews/cluster-relation-production-blind-pack-2026-10-14/packet \
  fa551275c112e5947436fd751400e4d25f5c9b28173b0b4d3c8b00b8d3e3318f
```

准入来源锚仍 `04215bfd953cd798ca8e968a199091c91638077a353c10b29d9921e869915f71`。本脚本没有send/自动标注模式；收到独立人工标注后另建reviewed结果，不覆盖空模板。新增模型请求仍需单独授权，不先跑模型再回填标签。
