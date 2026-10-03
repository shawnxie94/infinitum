# 事件聚合评估基线（Cluster Merge Evaluation Baseline）

本目录是 infinitum 事件聚合（聚类归组 + 合并 pass）的评估基线。

## 文件

- `reviews/cluster-quality-composite-2026-10-03/` — 复合开发评测集（2026-10-01 dev 24 对 + 2026-10-02 dev 16 对；2026-10-02 holdout 8 对原样保留）；多来源 cohort 必须分层报告，1420 对稀疏门审查仅为 diagnostic-only、非人工 gold。目录内 `verify_set.py` 校验源文件哈希、标签、split 和 cluster 隔离
- `eval-cluster-baseline.md` — 基线报告（主文档，含数据、方法、发现、结论）
- `baseline-regression.json` — **回归守护基准**（sample_metrics + snapshot_freeze 说明，含 guard_rules）
- `baseline-snapshot-2026-09-18.json` — 冻结快照 pair 级基线（2190 对，快照重放维度的对比基准）
- `embedding-recall-result.json` — Phase 1 语义召回评估结果（rule vs RRF 融合，见下文）
- `merge-gray-gate-result.json` — 第二层灰区门评测结果（合并预筛 rule-only vs 规则+向量，见下文）
- `embedding-mined-pairs.csv` — 向量挖掘扩充标注集（120 对高相似 ≥0.72 + 25 对中相似对照 0.60-0.72；AI 辅助标注 117 approved / 26 declined / 2 failed，待人工抽检）
- `below-gray-truth-2026-09-19.md` — B0 真值补盲报告（below-gray/anchor/conflict 三层正例率、object_conflict 误杀形态；与 embedding-mined-pairs 互补）
- `below-gray-truth-2026-09-19.csv` — B0 真值集（107 对 AI 辅助标注，reviewVerdict 列待人工抽检）
- `label-cases.md` — 238 unique pair 抽样标注记录（AI 辅助标注，人工抽样建议；逐条覆盖 approved 12 + strong-declined 36 + failed 抽查）
- `eval-sample-30d.csv` — 标注样本集原始数据（30 天窗口，240 行 / 238 unique pair，含 2 重复 failed pair）
- `production-declined-2026-09-20.csv` — 生产快照中双方仍存活的 200 条最新 declined pair，作为困难负例；不作为 approved 正例
- `production-overmerge-2026-09-23.csv` — **decision-layer FP 负例 + 漏合并正例对照**：2026-09-21/22 生产误合并聚类重建的 19 对（14 diff / 4 same / 1 uncertain）+ 2026-09-23 追加第二批（1 diff：HN 营销腔↔HarnessTax；5 same：Step5Preview、Gemini 入侵、豆包手机/NaviX、Amodei 节奏、Claude Code Projects 的碎片化漏合并对，双侧 cluster 存活故为 cluster 级文本，`verdictStored=none` 表示生产从未提名送审），共 25 对（15 diff / 9 same / 1 uncertain）；配 `eval:overmerge-gate` 使用。现有其余负例全部来自 declined 决策，本文件是唯一覆盖「LLM 批准了不该批准」盲区的集合
- `bm25-ab-result-2026-09-23.json` — 词汇打分通道 A/B 实验（`scripts/eval-bm25-vs-lexical.ts`）：BM25(in-code, bigram+in-window IDF) 对照现有 scoreClusterMergeCandidatePair。结论：碎片化变体/同日异事件层（overmerge 集）BM25 AUC 1.0 vs 0.52（median 192 vs 28）；below-gray 双低层两者均弱（0.59 vs 0.63）；eval-sample approved 12 对因合并删侧缺文本无法重算（数据闭环动机案例），且现有守卫会否决全部 12 对（守卫漂移，需重校准）

## 复跑

```bash
# 需要一份生产库只读快照（复制自服务器 /app/data/dev.db）
npx tsx scripts/eval-cluster-baseline.ts --db <snapshot> --days 30

# 机器可读回归指标（发布前后对比用）
npm run eval:baseline  # 或: npx tsx scripts/eval-cluster-baseline.ts --db <snapshot> --days 30 --json -

# 基线回归门（固定评测集样本级，跨版本可比）——劣于基准即 exit 1
npm run eval:baseline-gate
# 重设样本基准：npm run eval:baseline-gate:init

# 基线回归门（冻结快照重放维度，无漂移）——同一快照逐 pair 判定变化检测
npm run eval:snapshot-gate -- --snapshot <快照db> --freeze docs/eval/baseline-snapshot-2026-09-18.json
# 换基线时冻结新快照：npx tsx scripts/eval-cluster-baseline.ts --db <新快照> --days 30 --freeze docs/eval/baseline-snapshot-<date>.json

# Phase 1 语义召回评估：同一快照上对比 rule 切片 vs embedding+RRF 融合切片
# 分层：灰区候选（银标正例）/ declined 双侧存活（银标负例）/ CSV 标注集（--csv 逗号分隔多个）
# 需要 embedding 端点：INFINITUM_EMBED_URL / INFINITUM_EMBED_MODEL / INFINITUM_EMBED_KEY（env 名可换）
# 向量落盘缓存（默认系统临时目录），重跑不重复调用
INFINITUM_EMBED_URL=http://<gateway>/v1 INFINITUM_EMBED_MODEL=BAAI/bge-m3 INFINITUM_EMBED_KEY=<key> \
  npm run eval:embedding-recall -- --db <快照db> \
  --csv "docs/eval/eval-sample-30d.csv,docs/eval/embedding-mined-pairs.csv,docs/eval/production-declined-2026-09-20.csv" \
  --out docs/eval/embedding-recall-result.json

# 扩充标注集：从快照挖掘「高相似但未合并」的候选对（输出 pending，AI 辅助标注 + 人工抽检）
INFINITUM_EMBED_URL=... INFINITUM_EMBED_MODEL=... INFINITUM_EMBED_KEY=... \
  npx tsx scripts/mine-embedding-pairs.ts --db <快照db> --out docs/eval/embedding-mined-pairs.csv

# 第二层灰区门评测：合并预筛 rule-only vs 规则+向量准入（--min-sim / --conflict-override 可调阈值）
INFINITUM_EMBED_URL=... INFINITUM_EMBED_MODEL=... INFINITUM_EMBED_KEY=... \
  npm run eval:merge-gray-gate -- --db <快照db> --out docs/eval/merge-gray-gate-result.json
```

## 人工反馈闭环（Phase 3）

标注不再靠批量人工标注，而是管理台动作自动回写进生产库 `cluster_pair_labels` 表：

- 复核候选「合并」→ approved；复核候选「忽略」→ declined
- 聚类详情「移出条目」→ declined；「加入聚类」→ approved

标签带双侧文本快照，随快照自动进入评估：`eval-embedding-recall` 读取为
`feedback-approved` / `feedback-declined` 分层（旧快照无此表自动跳过），
并输出每层 rule分带分布（≥95 / 55-95 / 35-55 / <35 / rejected）——人工判定
落在规则分轴的位置即阈值校准依据。

注意：embedding 评估的银标口径有边界——approved 决策对的被合并侧已删除无法取文本，
正例主要来自灰区候选表与向量挖掘标注集；「规则完全漏掉但语义同事件」的增量召回
需等人工反馈闭环（Phase 3）积累真值后才能完整度量。

## 第二层灰区门评测（合并预筛，Phase 1.5）

合并预筛的候选提名门有两个阈值：规则灰区线 `CLUSTER_MERGE_AI_PAIR_GRAY_SCORE`（55）
与向量准入线 `CLUSTER_MERGE_VECTOR_GRAY_SIM`（0.72，bge-m3 挖掘标定：≥0.72 同事件
精确率约 99%）。`object_conflict` 否决向量路径，但 sim ≥ `CLUSTER_MERGE_VECTOR_CONFLICT_OVERRIDE_SIM`
（0.9）时视为 AI 抽取噪声、豁免否决仍交 LLM 终审（标注集实测：sim 0.94-0.97 的
冲突对 23/27 为人工正例；0.72-0.9 区间保留否决，防短标题同句式真冲突）。

`eval-merge-gray-gate` 在标注集上直接重放生产准入函数 `resolveMergePairAdmission`，
输出两门提名率与增量评审量（区分新鲜提名与被既有决策阻断的对）。当前结果
（2026-09-19 快照）：

- approved 129 对：提名率 69.8% → 86.8%，向量新增 22 对全部为人工正例
- declined 230 对：66.1% → 66.1%，零增量评审成本
- 已知盲区：12 对最早的人工正例 sim 仅 ~0.45（跨改写最难档），绝对阈值门抓不到

调灰区阈值前先跑此评测；阈值变更视为基线变更（向量重算不涉及，但提名分布会变）。

基线更新：指标改善后重设 `baseline-regression.json` 基准；换冻结快照时同步重建 freeze JSON 并提交。

## Overmerge 回归门（决策层假阳性，2026-09-23）

snapshot-gate / baseline-gate 只重放**规则与准入层**；LLM 合并决策层此前无门——
2026-09-18 基线 approved 抽样仅 12 对（恰好全对），无法外推。2026-09-21/22 生产
观测到决策层假阳性放量（14 个误合并聚类、约 15 对 FP，送审分 70-118 全部由规则
提名、LLM approved），由此从生产重建 `production-overmerge-2026-09-23.csv`：
pair 两侧取自合并后 cluster 的存活成员 item（标题/摘要/事件签名），itemCount 按
pending 合并链重建，localScore 取当次决策存档分。

```bash
# 不调用模型，检查 fixture 解析与 pair 组装
npm run eval:overmerge-gate -- --dry-run

# 实跑：对全部 pair 重放当前 assessClusterMergePairs（默认 batch 8/次）。
# fixture 扩到 25 对后脚本内置默认阈值（12/3）偏松，建议显式收紧：
INFINITUM_EVAL_AI_URL=http://<gateway>/v1 INFINITUM_EVAL_AI_KEY=<key> INFINITUM_EVAL_AI_MODEL=<model> \
  npm run eval:overmerge-gate -- --min-diff-declined 13 --min-same-approved 7 --out docs/eval/overmerge-gate-result.json
```

判定口径：`diff` 对必须 declined（默认 ≥12/14），`same` 对必须 approved
（默认 ≥3/4，防「全部拒绝」退化通过）；`uncertain` 仅展示不进门；任何调用
失败即 FAIL。阈值变更视为基线变更。

2026-09-23 首跑基线（生产默认模型 MiniMax-M3，batch 8）：19/19 全对
（`overmerge-gate-result-2026-09-23.json`）。两次 batch-19 单调用重放各翻转
1 对且翻转对不同（verus_whirlpool approved↔declined、sunilpai declined、
qwen_image_sam31 approved）——同输入随机判决噪声实测存在，批量越长噪声
暴露越多；门的容忍阈值（各允许 2 对）即为此设计。运行门时保持默认
batch 8 作为规范配置。

已知边界：pair 侧文本为合并后重建，非当次决策的逐字节输入；重建的
itemCount 为近似值；fixture 是一次性人工标注快照。第二批 5 对漏合并
（same）在生产中从未进入合并候选（0 条决策记录），属提名层/碎片化漏——
门只重放决策层，对这些对的判定通过只说明决策层本身能正确合并，
提名层召回由 `eval:embedding-recall` 与碎片化检测覆盖。

## 数据源

- 生产库：`root@152.32.230.86` → docker `infinitum-worker-1:/app/data/dev.db`（2026-09-18 快照）
- 窗口：2026-08-19 ~ 2026-09-18

## 生产快照与 snapshot-gate（2026-09-21）

- `snapshots/` 目录（**已 gitignore**）：`prod-snapshot-2026-09-21.db`（生产库 `content_clusters` + `cluster_decisions` 两表瘦身导出，11228 聚类 / 41149 判定）与 `prod-freeze-2026-09-21.json`（同一快照的冻结基线，2195 对）。
- 重跑快照维度回归门：

  ```bash
  npm run eval:snapshot-gate -- --snapshot docs/eval/snapshots/prod-snapshot-2026-09-21.db --freeze docs/eval/snapshots/prod-freeze-2026-09-21.json
  ```

- 基线冻结时点 = 2026-09-21（生产 v0.2.3-rc8 之后、mastra 迁移合入前）；此后任何影响合并判定的代码改动跑此门即可对比生产基线（默认容忍 ≤10 变化，`--strict` 归零）。
- 换新基线：从生产重新导出两表（worker 容器内 sqlite3 对 `content_clusters`/`cluster_decisions` ATTACH 抽表），再 `eval-cluster-baseline.ts --freeze` 生成新 JSON。
