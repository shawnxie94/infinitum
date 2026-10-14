# synthesis / follow_up 边界审查（未改线上）

规范结果：`sqlite://artifact/evaluation/cluster-relation-boundary-audit-2026-10-14`。来源抓取：[boundary-source-audit.json](boundary-source-audit.json)；分析：[boundary-analysis.json](boundary-analysis.json)；开发期望用例：[boundary-cases.json](boundary-cases.json)；未应用的精简规则草案：[boundary-prompt-candidate.txt](boundary-prompt-candidate.txt)。

## 原材料核对

只读查询本地运行容器的 5 条来源记录：3 条保留 RSS 正文，5 条均无 fullText。对缺正文的 2 条 GeekPark 来源进行了免费公开页面抓取，分别匹配到目标新闻小节；整页是多主题早报，不能将整页替换成输入的拆分子条目。当前网页/RSS 不是冻结时刻的逐字历史证明，未改任何冻结输入或人工标签。

### DR-03

- 左侧 RSS：[Agent 全家桶](https://www.aibase.com/zh/news/31273)，正文提及 Enterprise Context、数字员工、协作、安全及 QwenNote 的首款产品 A2。
- 右侧 RSS：[QwenNote Eva 发布](https://www.aibase.com/zh/news/31276)，描述 Eva 机器人、899 元售价及开售。
- 两篇均在本地标为 isAggregation=false、无 parentItemId，但这个标志本身不能证明文本没有多个具体发生。
- **证据缺口：A2 与 Eva 是否同一具体产品/发生尚未证明。** 用户确认的 synthesis gold 保留为开发诊断，不将其升级为已独立核实的综合稿正例。

### DR-08

- 左侧聚合组实际包含两条不同报道：Meta Connect 硬件/Muse 发布（[保留 RSS 来源](https://www.aibase.com/zh/news/31346)），以及人工外包接管 Muse 通话的内测试验。
- 后者是从 [9 月早报](http://www.geekpark.net/news/370917) 拆出的子条目，源页成功匹配「Meta 被曝内测 Muse 新机制」小节；右侧是从 [10 月早报](http://www.geekpark.net/news/372070) 拆出的子条目，匹配「Muse 将登陆智能眼镜平台」小节。两页访问时间均为 2026-10-14T09:52:09+00:00，抽取器 defuddle。只认对应小节，不把页面其他新闻计入当前子条目。
- 左侧两条合在一个 cluster 的多事件快照会干扰关系判定；这是已经混合的输入，不能只按“稿件标志”解释成模型分类问题。
- 冻结左侧 eventDate=2025-09-23，与 2026 年原文时间及保留 RSS 的年度上下文不一致。当前材料不能独立确定历史事件年份；未自动修正日期。
- 两个相关小节都写“将接入/近期登陆”，没有证明已经上线等新动作。较晚报道不能单独证明 follow_up。

## Prompt 审查

CodeGraph 索引完整、无 pendingChanges；定位 `AI_TASK_CONTRACTS`、`DEFAULT_CLUSTER_MERGE_PROMPT`，核对了当前 `src/config/prompts.ts` 与 `src/lib/ai/contracts.ts`。后者将 cluster_merge 绑定到代码拥有的系统 Prompt，实际回放也由原请求回执保留；不是修改旧 DB systemPrompt 就能修复。

现有 Prompt 已有 synthesis 定义，也规定 follow_up 是新事件，问题不是完全缺少规则。待验证的表达风险是：

1. “多篇独立报道”未明确区分“多来源报道同一次发生”与“多个独立发生”。
2. 优先信任结构化签名可能压过正文中明显的多事件覆盖，特别是日期错误或已混合的 cluster。
3. 未显式排除“报道更晚、同期展开、补充细节”作为后续进展证据。

草案只保留判定所需业务条件：定位具体发生；综合覆盖须包含对方对应的发生；follow_up 要有直接关联的新动作；同次发生的详略差异不算 synthesis；材料冲突时 uncertain。没有历史背景、任务编号或修订缘由进入草案。**草案未写入 src、未更新 DB、未调用模型验证。**

若后续真正修改系统 Prompt，直接入口为 `src/config/prompts.ts` 与契约测试；影响当前 provider、设置展示和契约 hash，属于独立实施切片，需要对应回归/新盲标对照，不在本次资料审查里顺带上线。

## 用例与验证边界

固化 10 组人工设计的合成开发期望，覆盖五类关系，包括：综合覆盖与组成事件、详略差异、预告→实际发布、晚报道无新动作、新召回动作、不同产品、日期冲突、多事件快照、综合稿与不包含的其他事件、父网页与子条目单位区分。

- 这些是开发期望，不是独立人工 gold，不计入真实样本质量指标。
- 结构校验通过只说明 fixture 格式和期望齐全，不说明模型判对。
- 原 gold v4、原回执、当前生产 Prompt/契约文件的 SHA256 保持不变。
- 现有 `ai-contracts` / `cluster-merge-protocol` 共 21 项测试通过；只验证现有契约/协议，不代表语义分类改善。
- 0 AI/付费调用，线上行为无变更。

## 下一步

先建立资料充分的独立盲标样本：明确原文对应发生、来源单元与日期，区分综合文章和已混合 cluster；A2/Eva 先确认身份，父早报按小节映射。可优先从可靠来源准备新的开发/留出批，不以反复更正过的样本作为独立验证。再决定是否实施最小 Prompt 修订；任何新付费回放另行授权。不要为了修饰现有指标直接改日期、拆在线 cluster、覆盖 gold 或根据 holdout 错题调参。
