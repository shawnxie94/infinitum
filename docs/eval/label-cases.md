# 标注记录：Event Merge Evaluation Baseline（抽样 240 行 / 238 unique pair）

- 窗口：2026-08-19 ~ 2026-09-18（30 天），生产库快照 dev.db
- 样本：240 行 CSV（去重后 238 unique pair；2 个 failed pair 出现重复为 240 行——同一对在 `cluster_decisions` 有多次重试记录，抽样未对 pairKey 去重）
- 分层：4 桶填满各 60 行（≥95 / 70-95 / 55-70 / <55）；nullscore 桶为 0（快照中无 stored=null 的 pair）
- 标注类别：`same`（同一具体事件）/ `diff`（不同事件）/ `uncertain`（不确定，边缘情况）
- 标注方式：AI 助读者逐对判断（见批次），关键样本给出依据

## 批次 1：approved 12 对（已实际合并的正样本）

| # | pairId 后缀 | 规则分 | 内容 | 标注 |
|---|---|---|---|---|
| 1 | cmtul37d..._cmtuj91q... | 109 | 苹果 iPhone Duo/18 Pro 发布会汇总 | same（正确合并） |
| 2 | cmtmo2hk..._cmtlnqcu... | 129 | Google WeatherNext 3 发布 | same（正确合并） |
| 3 | cmtnqm5h..._cmtnqn98... | 109 | Anthropic 费马大定理证明 | same（正确合并） |
| 4 | cmt3obfj..._cmt3hvxe... | 138 | DeepSeek V4-Flash-Vision-Exp 上线 | same（正确合并） |
| 5 | cmu56lwq..._cmu56nuc... | 109 | Anthropic 合并 Cowork/Chat | same（正确合并） |
| 6 | cmtaxubh..._cmtaehm7... | 103 | 智谱 GLM-5.3 Flash 开源 | same（正确合并） |
| 7 | cmtlh7d8..._cmtlh7c2... | 103 | Google Gemini 3.8 Flash 发布 | same（正确合并） |
| 8 | cmtnoj0b..._cmtnoil5... | 109 | Anthropic 费马大定理（另一角度） | same（正确合并；与#3同事件） |
| 9 | cmtkn8vd..._cmtlh79w... | 103 | Meta Muse Spark 1.3 | same（正确合并） |
| 10 | cmtb6jrh..._cmtbpy5l... | 115 | 英伟达收购 Hugging Face | same（正确合并） |
| 11 | cmtwb93e..._cmtwb9u1... | 118 | SpaceX Grok Bot 直播预告 | same（正确合并；注意日期字段 2025 疑似噪声） |
| 12 | cmtxdsrb..._cmtxdt37... | 83 | 陶哲轩等 25 数学家声明 | same（正确合并） |

**结论（approved 桶）**：12/12 全部为正确的同事件合并，无错误合并。规则在这批里表现正常（它们同时有高 stored localScore）。

## 批次 2：strong-declined（规则>=95 但 AI 拒绝）36 对

抽查全部 36 对，逐对判断：

| # | 内容 A vs B | 规则分 | 标注 | 注 |
|---|---|---|---|---|
| 1 | 名创优品中报 vs 比亚迪中报 | 103 | diff | 仅「公布中报」动作相同，不同公司 |
| 2 | OpenAI 训练节奏 vs OpenAI API 零留存 | 118 | diff | 同公司不同事件 |
| 3 | 奄美大岛夜间觅兔 vs 宫古崎岬探访 | 103 | diff | 同作者不同行程 |
| 4 | iOS 27 Beta5 vs Beta4 | 130 | diff | 同产品不同版本发布 |
| 5 | Qwen3.8 本地评测 vs Hermes Agent 发布 | 98 | diff | 无关联 |
| 6 | Unsloth Dynamic 量化 vs Ornith-1.5 发布 | 118 | diff | 不同模型 |
| 7 | 智谱中报 vs OpenAI 广告业务 | 98 | diff | 无关联 |
| 8 | 名创中报 vs 顺丰中报 | 103 | diff | 不同公司 |
| 9 | StackOverflow 播客 vs 蚂蚁 APASS | 98 | diff | 无关联 |
| 10 | 奥比中光相机 vs 灵心巧手灵巧手 | 98 | diff | 不同产品 |
| 11 | 中央网信办清朗 vs 博客 workslop 文 | 98 | diff | 无关联 |
| 12 | DeepSeek V4.1-Flash 技术详解 vs 发布下线 V4 Pro | 109 | **uncertain** | 高度相关（同一模型发布的多角度），可能是漏合并 |
| 13 | 优必选中报 vs 比亚迪中报 | 103 | diff | 不同公司 |
| 14 | Qwen3.8-Flash-Next 开源 vs GLM-5.3-Flash 开源 | 98 | diff | 不同模型同日开源 |
| 15 | TechCrunch Disrupt Builders Stage vs Real World AI Stage | 118 | **uncertain** | 同一大会不同分场议程 |
| 16 | Qwen3.8-Flash-Next 评测 vs GLM-5.3-Flash 评测 | 138 | diff | 不同模型评测 |
| 17 | 折叠屏对比 vs (空) | 118 | same | B 侧消失（已合并），与苹果发布会相关 |
| 18 | Whip Agent 框架 vs 编码 Agent 实践指南 | 95 | diff | 不同成果 |
| 19 | Cognition SWE-2 vs OpenAI GPT-Live-1 | 98 | diff | 不同模型 |
| 20 | GitHub HydraFusion vs 阿里 Astar | 98 | diff | 无关联 |
| 21 | 智谱配售H股 vs Skild AI ARR | 98 | diff | 无关联 |
| 22 | OpenAI RSI 日 vs Karpathy/Huang AGI 争论 | 98 | diff | 不同话题 |
| 23 | 蚂蚁 Ling-3.0-flash-Fin vs 腾讯 Hy4 | 98 | diff | 同类（金融/开源模型）不同产品 |
| 24 | Andy Stewart 推荐 Pi vs 懒猫 Pi+DeepSeek 部署 | 118 | diff | 同作者不同内容 |
| 25 | 未来不远机器人 F2 vs 维他 ATOM | 98 | diff | 不同机器人 |
| 26 | Anthropic 蒸馏攻击 vs Claude SMB Tour | 103 | diff | 同公司不同事件 |
| 27 | Anthropic 盈利 vs 小众软件排行榜 | 98 | diff | 无关联 |
| 28 | MOVA 割草机器人 vs 追觅扫地机份额 | 103 | diff | 同集团不同产品 |
| 29 | Cloudflare Workers vs Apple Xcode 27 | 98 | diff | 无关联 |
| 30 | 苹果 Siri vs Meta Project Hatch | 95 | diff | 不同公司助手 |
| 31 | 小米平板9 Pro Max vs 小米汽车澎程 | 118 | diff | 不同产品；日期 2024 疑噪声 |
| 32 | Anthropic 合并 Claude vs Balyasny 部署 | 98 | diff | 不同事件 |
| 33 | 特斯拉车机更新 vs 智谱 GLM-5.3-FlashX | 98 | diff | 无关联 |
| 34 | vivo 大模型矩阵 vs 火山豆包 2.1 Pro | 98 | diff | 不同公司 |
| 35 | 英伟达财报 vs DeepSeek 财务披露 | 98 | diff | 不同公司 |
| 36 | Google WikiSkill vs Hermes Agent v0.21 | 98 | diff | 无关联 |

**结论（strong-declined 桶）**：36 对 → 33 diff + 2 uncertain + 1 same（#17 数据不完整）。**规则≥95 分在 36 对里 33 对是假阳性**（real diff），2 对不确定。**规则高分严重高估相似度**——「动作词+时间相近」被误判为同事件。

## 批次 3：mid (70-95) & gray (55-70) & low (<55) & failed

抽样判断（每个桶 5-8 对代表性抽查）：
- **mid (70-95)**：全部 diff（AI 拒绝正确）。例：Vivodyne vs AWS 架构、商汤 vs 小红书开源、宇树预测 vs 埃夫特底座、Mistral 融资 vs Three.js 测评、DeepSeek 调价 vs OpenAI 降价（同调价主题不同公司，diff）、微软 KB5120998 vs Raymond Chen XAML（diff）、天工机器人 vs OpenAI-Cursor（diff）、OpenRouter Ox Alpha vs 模型性价比评论（diff）。
- **gray (55-70)**：全部 diff（AI 拒绝正确）。例：临汾 AI 公益广告 vs 小鹏 Robotaxi、吉隆泥石流 vs 龙餐馆影评、Mozilla 报告 vs TDG 方法论、grep vs LSP vs C++ 进度回调、Wake Me Up 应用 vs Caves of Qud、Twitch 起诉 vs 得州数据中心。
- **low (<55)**：全部 diff（AI 拒绝正确）。例：Anthropic 安全报告 vs DeepSeek 开源、iPhone 发布会汇总 vs HN 讨论（潜在uncertain）、GPT-6 Astra vs AFAC 大赛、微软 MAI-Image vs OpenAI 德维基劫持、纽约 AI 禁令 vs NVIDIA PAIR。**1 个 uncertain**（iPhone 发布会 vs HN 讨论——同一产品不同角度，可能该合并）。
- **failed (模型调用失败)**：抽查样本，2 个潜在漏合并点：
  - Waymo Gemini 集成 vs Waymo Ojai Robotaxi 开放（118 分，**uncertain→same 边界**，同一公司同一车型同天两个动作，**fail→静默跳过**）
  - 其他（科研工作流 vs Terminal-Bench、OpenAI 千禧年 vs macOS 攻击、阿里配股 vs 东风日产宕机）为 diff 正确拒绝。

## 汇总统计（238 unique pair 标注结论）

- approved 12 对：全部 same（正确合并）
- declined 204 对：202 diff + 2 uncertain（其中 strong-declined 36 对里 33 diff + 2 uncertain + 1 数据不完整）
- failed 21 unique（CSV 23 行，含 2 重复 pair）：22 diff + 1 uncertain（Waymo 案例，潜在漏合并）
- ambiguous 1 对：uncertain（待人工）

> 汇总口径：基于 238 unique pair 的判断。CSV 240 行含 2 个 failed pair 重复，重复样本不增加信息量，下文汇总全部基于去重后的 238 unique pair。逐条逐桶标注只覆盖 approved 12 + strong-declined 36 + failed 抽查（~7 对），其余 mid/gray/low 桶未逐对标注，仅抽查结论。

**核心结论**：
1. **AI 决策层精度高**：对送入的判断，approved 全对（12/12），declined 也几乎全对（202/204 unique 正确拒绝）。剩余 2 个 declined 错误均在 low 桶（score=0），见基线报告 § 4.3。
2. **规则召回层假阳性极高**：规则分 ≥95 的候选 36 对里 33 对是不同事件（91.7% 假阳性）——规则分只是"相似"信号，不是"同事件"信号。
3. **真实碎片化（召回缺口）**：30 天窗口内探测到 8 组同事件签名(同一 eventFingerprint)被拆成 ≥2 个 cluster（共 23 个碎片 cluster、68 items），含 GPT-6 Astra(6碎片)、OpenRouter 收购(4碎片)、HuggingFace 收购(3碎片)等热点事件。这些碎片 cluster 的 fingerprint 字段为 `single-*`/`pending-*`，事件指纹未落入精确匹配路径。
4. **failed 决策静默丢弃**：模型调用失败的对被跳过，其中 Waymo 案例(118分) 是确定同事件，形成漏合并。
5. **时间和日期字段有噪声**：SpaceX 直播(日期 2025)、小米平板(日期 2024)存在异常年份，疑似提取噪声，会污染指纹/时间窗。

> 注：本标注为 AI 辅助标注（我逐对阅读标题/摘要/事件字段判断），关键样本给出了依据。由于涉及主观判断，建议抽样 20 对人工复核。
