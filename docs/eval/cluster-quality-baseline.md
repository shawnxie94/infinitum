# Cluster quality snapshot baseline（当前生产纯规则候选准入诊断）

对冻结快照做反事实基线：重建生产 7 天语料窗口，调用真实纯函数
`buildClusterMergeCandidateSelection` 一次全语料，把已复核 endpoint 强制 live，
统计人工标注 same/diff 对被准入为**合并候选**（`allowedPairs`）的比例。

stage：`production_candidate_selector_snapshot_counterfactual`。
不是历史完整线上 replay，不是最终合并（final merging）评估；
实体别名归一化、cannot-link 过滤、AI 评审、最终图合并均不在本 stage，标记 not_measured。

## 命令

```bash
npx tsx scripts/eval-cluster-quality-baseline.ts \
  --frozen docs/eval/reviews/cluster-quality-2026-10-01/frozen-manifest.json \
  --expected-manifest-sha 36fa4b92b314ace918683ebbdb23c6f6f8e3f994d5ed04cc9d81c5b4e8bff260 \
  --labels docs/eval/reviews/cluster-quality-2026-10-01/blind-review.csv \
  --snapshot docs/eval/snapshots/prod-snapshot-2026-09-21.db \
  --out docs/eval/reviews/cluster-quality-2026-10-01/baseline-report.json
```

## 退出码

- `0`：diagnostic_complete（各 split 双类别齐全且覆盖完整）。
- `1`：invalid input（manifest/snapshot sha 不符、输入被篡改、身份/时间缺失等，fail-closed）。
- `2`：diagnostic_incomplete —— **预期内的评测覆盖不足**（有排除 case、某 split 缺类别），
  不是工具崩溃。本轮实际退出码为 2。

## 结果解读

- `--expected-manifest-sha` 是唯一信任锚，先校验再解析；CSV input checksum 按冻结
  `inputSha256` 逐条复核，reviewer/reviewedAt 严格验证。
- asOf 取快照 active 的 `MAX(latestPublishedAt)`，不使用 `Date.now`；语料窗口为生产
  7 天 lookback + order-by + `CLUSTER_MERGE_SCAN_CLUSTER_LIMIT` 的严格 SQLite 翻译。
  items/sources 表存在时强制生产 EXISTS 过滤（items processed + allowed/restored，
  source.aggregationEnabled OR parentItemId），缺列显式 invalid_input；快照导出无
  items/sources 表时报告 `unavailable_missing_tables:items,sources`，不做静默放宽。
  本 stage 是条件性 candidate-selector，scope 永久不完整，不是全生产过滤回放。
- 方向映射来自 sampling manifest 的 `leftClusterId/rightClusterId`（冻结 clusterIds
  无序，不得用排序 ID 配 CSV 标题）；CSV input checksum 按 36/36 全量校验；
  **快照字段比对只对通过窗口检查的 case 执行**（本轮 7/36，29 例窗口外未比对，
  不对未比对样本作"无漂移"推断）；漂移 case 计入 `stale_field_not_reconstructed`
  并列出字段名，绝不静默用最新 DB 值替换人工输入。
- 拒绝原因仅有 evidence 类别（safety_rejected:*、bm25_zero、clean_pair_not_scanned），
  其余一律 `not_selected_with_available_diagnostics`——无生产 scan/排名插桩，不猜测 topk 原因。
- 排除 case 不计负例正确也不计漏召：指标分母仅 eligible，同时报告 total/coverage。
- 采样偏置：12 same-event-fingerprint + 24 high-score declined 难例，比率是偏置样本
  诊断，不是全局错误率。
- AI call/token/cost/latency 均为 `not_measured`；`offline_runtime_ms` 真实测量且不入
  `stableDecisionDigest`（排除时间戳/timing；涵盖 snapshot/frozen/sampling/labels CSV
  精确 SHA、语料 canonical fingerprint（含 ids 顺序与每 candidate 全字段、保留生产排序）、
  scenario（liveIDs/asOf/cap/window/vectorMode/missingTables/itemsSourceFilter）及
  helpers/bm25/constants/脚本 SHA + git HEAD，可复现。报告 MD 由 `renderMarkdown(report)`
  自动生成，与 JSON 字段一致）。
- `release_eligible` 本轮恒为 false；holdout 仅聚合 + 覆盖 flags，不做调参或逐题分析。

## 本轮局限

- 36 例中 29 例落在快照 7 天窗口外（采样窗口为 30 天），按要求不放宽窗口；
  holdout 无一例 eligible，故 status=diagnostic_incomplete、holdout 各率为 null。
- 向量召回通道 disabled_not_measured；items/source 资格过滤 not_evaluable。
- 结果详见 `docs/eval/reviews/cluster-quality-2026-10-01/baseline-report.{json,md}`。
