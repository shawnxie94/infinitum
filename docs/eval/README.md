# 事件聚合评估基线（Cluster Merge Evaluation Baseline）

本目录是 infinitum 事件聚合（聚类归组 + 合并 pass）的评估基线。

## 文件

- `eval-cluster-baseline.md` — 基线报告（主文档，含数据、方法、发现、结论）
- `baseline-regression.json` — **回归守护基准**（sample_metrics + snapshot_freeze 说明，含 guard_rules）
- `baseline-snapshot-2026-09-18.json` — 冻结快照 pair 级基线（2190 对，快照重放维度的对比基准）
- `embedding-recall-result.json` — Phase 1 语义召回评估结果（rule vs RRF 融合，见下文）
- `embedding-mined-pairs.csv` — 向量挖掘扩充标注集（120 对高相似 ≥0.72 + 25 对中相似对照 0.60-0.72；AI 辅助标注 117 approved / 26 declined / 2 failed，待人工抽检）
- `label-cases.md` — 238 unique pair 抽样标注记录（AI 辅助标注，人工抽样建议；逐条覆盖 approved 12 + strong-declined 36 + failed 抽查）
- `eval-sample-30d.csv` — 标注样本集原始数据（30 天窗口，240 行 / 238 unique pair，含 2 重复 failed pair）

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
  --csv "docs/eval/eval-sample-30d.csv,docs/eval/embedding-mined-pairs.csv" \
  --out docs/eval/embedding-recall-result.json

# 扩充标注集：从快照挖掘「高相似但未合并」的候选对（输出 pending，AI 辅助标注 + 人工抽检）
INFINITUM_EMBED_URL=... INFINITUM_EMBED_MODEL=... INFINITUM_EMBED_KEY=... \
  npx tsx scripts/mine-embedding-pairs.ts --db <快照db> --out docs/eval/embedding-mined-pairs.csv
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

基线更新：指标改善后重设 `baseline-regression.json` 基准；换冻结快照时同步重建 freeze JSON 并提交。

## 数据源

- 生产库：`root@152.32.230.86` → docker `infinitum-worker-1:/app/data/dev.db`（2026-09-18 快照）
- 窗口：2026-08-19 ~ 2026-09-18
