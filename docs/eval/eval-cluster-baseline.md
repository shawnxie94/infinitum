# 事件聚合评估基线（30 天窗口，生产数据）

> 基线目标：量化当前事件聚合（聚类归组 + 合并 pass）的**召回精度**与**错误模式**，作为后续「证据增强 / RAG 语义召回 / 漂移约束」等优化措施的对比基准。
>
> 数据：生产库快照（2026-09-18 复制，1473 MB）。窗口：2026-08-19 ~ 2026-09-18（30 天）。
> 方法：全量聚合决策统计 + 240 行（238 unique pair + 2 重复 failed pair）分层抽样人工（AI 辅助）标注 + 碎片化（同事件签名拆分）探测。

## 1. 结论摘要

| 维度 | 结果 | 判定 |
|---|---|---|
| AI 合并决策精度 | approved 12/12 正确；declined 202/204 unique 正确（含 2 重复行 207 行） | **决策层精准** |
| 规则层假阳性 | 规则分 ≥95 的候选，36 对抽样中 33 对是不同事件（91.7% FP） | **规则分严重高估** |
| 碎片化（召回缺口） | 8 组同事件签名拆分 ≥2 cluster，23 碎片、68 条 item | **存在确定性漏合并** |
| failed 决策 | 261 条模型调用失败被静默跳过，其中含确定同事件案例 | **失败盲区** |
| 日期/时间噪声 | 观测到 2024/2025 年份异常值注入事件签名 | **输入质量风险** |

**一句话**：AI 判断层很准，但规则召回层（候选生成）假阳性极高且存在可复现的碎片化漏合并，**问题不在"判断"，而在"谁被送到 AI 面前"**。

## 2. 窗口概览

- 30 天内 `content_clusters`（active/hidden，latestPublishedAt ≥ 窗口起点）：**8157 个**
- 事件签名完整度（subject+object+action/type 齐）：**99.7%**（8130/8157）
- 窗口内 `cluster_pair` 决策：**2306 条**（approved 69 / declined 1972 / ambiguous 4 / failed 261）

## 3. 决策行为（真实运行统计）

### 3.1 已存储规则分分布（AI 决策时看到的分数）

| 桶 | approved（合并成功） | declined（拒绝） |
|---|---|---|
| ≥95 | 60 | 188 |
| 70–95 | 8 | 448 |
| 55–70 | 1 | 1336 |
| mean / median | 105.3 / 103 | 67.7 / 58 |

**解读**：合并成功的对，规则分中位数 103；拒绝的对中位 58。规则分确有一定区分度，但重叠明显（declined 里有 188 条 ≥95 分）。

### 3.2 决策与规则强相关（alive pairs 重算）

规则对「两侧 cluster 仍存活」的对重算当前规则分（复用 `scoreClusterMergeCandidatePair`，与线上同源码）：

```
>=95:  298 对，其中 AI declined 182 (61.1%)，failed 115
70-95: 502 对，其中 AI declined 421 (83.9%)
55-70: 1282 对（几乎全 declined，AI 在灰区大量拒绝）
```

**核心发现**：**规则打高分（≥95）的对，AI 拒绝的比例高达 61.1%**。规则高分 = 强烈"相似"信号，但与"同一事件"差距巨大。

## 4. AI 辅助标注（240 行 / 238 unique pair）

- 样本：240 行 CSV，分层抽样（≥95 / 70-95 / 55-70 / <55 四桶填满各 60 行；nullscore 桶实际为 0，因为快照中 stored=null 的 pair 不存在）
- 240 行中 2 个 failed pair 出现重复（同一对在 `cluster_decisions` 有多次重试记录，抽样未对 pairKey 去重），去重后 238 unique pair
- 全部 unique 样本经逐对阅读标题、摘要、事件签名判断
- 标注类别：`same` / `diff` / `uncertain`

### 4.1 分层标注结果

| 桶 | 数量 | same（同事件） | diff（不同事件） | uncertain |
|---|---|---|---|---|
| approved（已合并） | 12 | 12 | 0 | 0 |
| declined 且规则≥95 | 36 | 1* | 33 | 2 |
| declined 且规则 70-95 | 54（抽查） | 0 | 54 | 0 |
| declined 且规则 55-70 | 60（抽查） | 0 | 60 | 0 |
| declined 且规则 <55 | 60（抽查） | 0 | 59 | 1 |
| failed | 21 unique（23 行，含 2 重复 pair） | 0 | 20 | 1 |

\* 标 1 的是一侧 cluster 已消失（A-only），内容显示为同一事件碎片，实为**已合并残余**，详见碎片化。

### 4.2 关键含义

1. **approved 全部正确**：12/12 都是同事件的不同角度报道被正确合并。
2. **规则 ≥95 的高分对，几乎全是"动作词+时间窗相同但本质不同"的事件**。典型：
   - 名创优品中报 vs 比亚迪中报（同为"公布中期业绩"，不同公司）→ 103 分
   - Qwen3.8-Flash-Next 开源 vs GLM-5.3-Flash 开源（同为"开源模型"同日）→ 98 分
   - 英伟达财报 vs DeepSeek 财务披露（同为"财报"）→ 98 分
   这类对都被 AI 正确拒绝，但**消耗了大量 LLM 调用**（它们被判定为"强候选"送审）。
3. **不确定样本**（2 个 declined uncertain + 1 个 failed uncertain）值得人工复核：DeepSeek V4.1-Flash 发布与技术详解（可能同事件多角度）、TechCrunch Disrupt 分场议程、Waymo Ojai 集成与低成本版开放（同公司同车型同天）。

### 4.3 已知边界案例（AI 当次 declined 错）

逐对独立复核 238 unique pair 后，发现 2 个 declined 评估集边界错误：

| pairKey 摘要 | score | 实质 |
|---|---|---|
| 苹果 发布 iPhone Duo、iPhone 18 Pro 系列… vs Apple 发布 iPhone 18 Pro / Pro Max | 0（low 桶） | **同一 2026-09-09 苹果发布会**的不同报道，AI 当次 declined 漏合并 |
| Apple 发布 Apple Watch 音频智能… vs 苹果 发布 iPhone Duo… | 0（low 桶） | **同一 2026-09-09 苹果发布会**的不同报道，AI 当次 declined 漏合并 |

两条都在 low 桶（score=0），**不影响**上述 § 4 结论（规则高分假阳率、碎片化等主指标以 strong/mid/gray 桶为准）。但提示两点：
- 评估集中的 stored verdict 约 99% 与独立判断一致（213/217，1.8% 不一致，其中 1 个边界 ambiguous、1 个单侧消失语义冲突、2 个真实 declined 错）
- failed 桶的 high-score pair（≥95）才是漏合并的主要风险源，本评估集中有 10 条（详见 § 4.1 表格后的 failed-strong 样本）

## 5. 碎片化（召回缺口）—— 本基线最重要的实证发现

### 5.1 现象

30 天窗口内，**同事件签名（eventFingerprint 精确一致）被拆成 ≥2 个 cluster** 的组有 **8 组、23 个碎片 cluster、共 68 条 item**：

| 事件 | 碎片数 | 总 item |
|---|---|---|
| OpenAI 发布 GPT-6 Astra | **6** | 24 |
| Stripe 收购 OpenRouter | **4** | 11 |
| 英伟达收购 Hugging Face | **3** | 19 |
| 小鹏上市 G9L | 2 | 2 |
| 苹果发布 iPhone Duo | 2 | 2 |
| 宇树发布 G1+ | 2 | 2 |
| 华为发布 Mate XT2 | 2 | 2 |
| OpenAI 发布 ChatGPT Images 2.5 | 2 | 6 |

### 5.2 根因（GPT-6 Astra 案例，6 碎片逐一核对）

6 个碎片 cluster 的 item 内容全部确认为同一事件（OpenAI 于 2026-09-03/04 发布 GPT-6 Astra 的不同报道），事件签名（S=OpenAI, O=GPT-6 Astra 模型, A=发布）完全相同。

但这些 cluster 的 `fingerprint` 字段是 **`single-{itemId}` / `pending-{itemId}`**（单条待定 cluster），而非事件指纹。因此：

1. `assignItemToCluster` 的精确匹配（`findActiveClusterByFingerprint`）用 `fingerprint`（single-*）匹配 → **失效**；
2. 碎片 cluster 之间的 pair **从未进入合并候选**（碎片间 0 条 pair 决策记录）；
3. 合并 pass 的候选扫描（400 邻居上限 + 每簇 3 对上限 + pending 处理）**未能把同签名的 pending cluster 拉进同一批**。

**本质**：事件指纹（eventFingerprint）存在，但没被用于候选生成的索引路径；`single-*`/`pending-*` fingerprint 掩盖了真实事件身份。

### 5.3 影响

这些碎片化了的是**热点事件**（旗舰模型发布、重大收购），前端会把同一事件展示成 6 个"聚合组"，且每个碎片只有 1-4 条 item，事件摘要质量被稀释。

## 6. failed 决策盲区

窗口内 261 条 failed（LLM 调用失败）。抽查发现**确定同事件案例被静默跳过**：

- **Waymo 集成 Gemini 进 Ojai** vs **Waymo 低成本 Robotaxi 开放**（同公司、同车型 Ojai、同天 2026-08-19，规则 118 分）→ failed → 无重试、无转人工。

当前 failed 的处理是"记录失败、跳过"，没有重试或转人工队列，会在高流量时段放大漏合并。

## 7. 输入质量风险

- SpaceX Grok Bot 直播预告（2025-09-15）、小米平板 9 Pro Max（2024-09-07）的 `eventDate` 出现异常年份——疑似 AI 抽取的事件日期错误，会污染事件指纹与时间窗匹配。
- 事件签名完全相同的 cluster（fingerprint 同）仍分散，说明**匹配路径不依赖 eventFingerprint**，这是设计层面的间隙。

## 8. 优化建议（供后续 baseline 对比）

按性价比排序：

1. **用 eventFingerprint 建立候选检索路径**（高优先，直接消灭碎片化）：合并候选扫描时，除现有 rule score 外，同 eventFingerprint 的 pending/single cluster 应强制进入候选并速判合并。预计可消除 8/8 组碎片。
2. **规则分作用是"召回信号"而非"合并决策"**：当前 `>=95` 即强候选送 LLM，61.1% 是浪费的 LLM 调用。可将 ≥95 的候选**直接走 LLM 轻代理**（或加大 `CLUSTER_MERGE_RELATED_PAIR_LIMIT` 控制），并把 strong 桶误报率作为 RAG 改造后的对比指标。
3. **failed 补机制**：failed 对转人工复核队列或指数重试，避免静默漏合并。
4. **事件日期异常检测**：`eventDate` 年份与 `publishedAt` 偏离 >1 年时降级处理。
5. **边界 uncertain 案例**（DeepSeek V4.1-Flash 发布 vs 技术详解、Waymo Ojai）建议人工复核后入训练/阈值校准样本。

## 9. 复跑

```bash
npx tsx scripts/eval-cluster-baseline.ts --db <prod-snapshot> --days 30
# 附加标注样本：--samples 300 --out <csv>
```

脚本读生产快照（只读），复用线上同源码的 `scoreClusterMergeCandidatePair` 复算规则分。

## 10. 限制与风险

- 标注为 AI 辅助（逐对阅读标题/摘要/事件字段），主观性强，建议抽 20 对人工复核校准。
- approved 对因源 cluster 被合并删除，无法重算当前规则分；碎片化检测以 eventFingerprint 相同为锚，属保守下限（实际碎片可能更多，如描述改写导致的签名差异无法被精确指纹捕获）。
- 窗口锚点取快照内最新决策时间（2026-09-18T08:02Z），避免本机时钟偏差。

## 附：术语

- **eventFingerprint**：`buildEventFingerprint`——事件类型+主体+动作+对象的归一化 hash（不含日期，含千年虫风险的独立字段）。
- **fingerprint**（cluster 字段）：创建时指定的归组 key；pending/single cluster 用 `{mode}-{itemId}`。
- **scoreClusterMergeCandidatePair**：合并 pass 的局部规则打分（helpers.ts:1143），本基线复算同源码。