# 事件聚合评估基线（Cluster Merge Evaluation Baseline）

本目录是 infinitum 事件聚合（聚类归组 + 合并 pass）的评估基线。

## 文件

- `eval-cluster-baseline.md` — 基线报告（主文档，含数据、方法、发现、结论）
- `baseline-regression.json` — **回归守护基准**（sample_metrics + snapshot_freeze 说明，含 guard_rules）
- `baseline-snapshot-2026-09-18.json` — 冻结快照 pair 级基线（2190 对，快照重放维度的对比基准）
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
```

基线更新：指标改善后重设 `baseline-regression.json` 基准；换冻结快照时同步重建 freeze JSON 并提交。

## 数据源

- 生产库：`root@152.32.230.86` → docker `infinitum-worker-1:/app/data/dev.db`（2026-09-18 快照）
- 窗口：2026-08-19 ~ 2026-09-18
