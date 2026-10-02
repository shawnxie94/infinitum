# Cluster quality review 2026-10-01

36 条 BM25 hard-case 盲审的持久归档。工具与流程见 `docs/eval/cluster-quality-review.md`。

## 文件

- `blind-review.csv`：已回填的人工标注导出（36 行：14 same / 22 diff，reviewStatus 全 reviewed，humanReason 留空）。
- `frozen-manifest.json` / `frozen-manifest.sha256`：冻结 manifest 及其 sha256 sidecar。
- `readiness-report.json`：assess 实际运行输出。

## 来源（SQLite Artifact，持久记录真源；本目录文件只是人读导出）

- `ab artifact get --kind evaluation --id cluster-quality-review-2026-10-01`（冻结包，trust anchor `expected_manifest_sha256` = `36fa4b92b314ace918683ebbdb23c6f6f8e3f994d5ed04cc9d81c5b4e8bff260`）
- `ab artifact get --kind evaluation --id cluster-quality-annotation-submission-2026-10-01`（人工标注提交，36 行规范 CSV）

frozen-manifest.json 为 artifact 内 `frozen_manifest_exact_utf8` 的逐字节导出，sha256 与独立锚点一致；manifest 内 `snapshot.path` 保持 repo 相对路径（`docs/eval/snapshots/prod-snapshot-2026-09-21.db`）。

## 审核确认

reviewer=Shawn、reviewedAt=2026-10-01T15:05:01.424Z 为本轮执行时用户确认的记录时间，仅回填这两列；humanLabel / 输入列与提交 artifact 完全一致。

## Readiness 结果（真实 CLI assess，exit 0 = ready_for_replay）

- dev（24 例）：same 10 / diff 14
- holdout（12 例）：same 4 / diff 8
- metrics 非空仅表示标注覆盖足以回放；`quality_passed` 恒为 false，baseline 仍为 deferred。

## 边界

- 这 36 例是刻意挑选的难例，不能解读为总体质量。
- 尚未回放完整线上策略；manifest 的 methodVersion 是上一 run 冻结时的脚本 hash，后续 governance 路径默认目录改动不重冻结该 hash，基线计分代码另行冻结。
