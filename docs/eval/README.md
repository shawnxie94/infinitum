# 事件聚合评估基线（Cluster Merge Evaluation Baseline）

本目录是 infinitum 事件聚合（聚类归组 + 合并 pass）的评估基线。

## 文件

- `eval-cluster-baseline.md` — 基线报告（主文档，含数据、方法、发现、结论）
- `label-cases.md` — 240 对抽样标注记录（AI 辅助标注，人工抽样建议）
- `eval-sample-30d.csv` — 标注样本集原始数据（30 天窗口，240 对）

## 复跑

```bash
# 需要一份生产库只读快照（复制自服务器 /app/data/dev.db）
npx tsx scripts/eval-cluster-baseline.ts --db <snapshot> --days 30
```

## 数据源

- 生产库：`root@152.32.230.86` → docker `infinitum-worker-1:/app/data/dev.db`（2026-09-18 快照）
- 窗口：2026-08-19 ~ 2026-09-18
