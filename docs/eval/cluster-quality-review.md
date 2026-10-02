# Cluster quality human review foundation

离线人工盲审基础工具（2026-10-01）。只做三件事：冻结盲审包 → 人工回填 → 评估标注 readiness。它不评估聚类质量，也不是基线结果。

## 命令

```bash
# 1. 冻结盲审包（只读快照 + 既有 pending CSV / manifest；默认输出 docs/eval/reviews/cluster-quality-YYYY-MM-DD，目录已存在且非空会拒绝，需换新目录）
npx tsx scripts/eval-cluster-quality-review.ts prepare \
  --snapshot docs/eval/snapshots/prod-snapshot-2026-09-21.db \
  --labels docs/eval/bm25-hard-cases-review-2026-09-26.csv \
  --manifest docs/eval/bm25-hard-cases-manifest-2026-09-26.json

# 2. 人工在 blind-review.csv 中回填 5 个人工列：humanLabel（same|diff|uncertain）、reviewer（非空）、
#    reviewedAt（可解析时间戳，推荐 ISO 8601）、humanReason（可为空）、并将 reviewStatus 置为 reviewed；
#    否则该行仍按 pending 计。输入列（titles/summaries/signatures/dates/counts）不可改动。

# 3. 评估 readiness（expected-manifest-sha 由 root 记录提供，是必填信任锚）
npx tsx scripts/eval-cluster-quality-review.ts assess \
  --frozen docs/eval/reviews/cluster-quality-2026-10-01/frozen-manifest.json \
  --expected-manifest-sha <sha256-of-frozen-manifest.json> \
  --labels docs/eval/reviews/cluster-quality-2026-10-01/blind-review.csv \
  --out docs/eval/reviews/cluster-quality-2026-10-01/readiness-report.json
```

退出码：`0` ready_for_replay；`1` invalid_input（缺/多/重复 case、输入被篡改、snapshot sha 不符、manifest digest 不匹配、schemaVersion/methodVersion 非法等，fail-closed）；`2` insufficient_truth（0 标注、全 uncertain、任一 split 缺 same/diff、仍有 pending——0 标注时这是预期阻塞，不是成功）。

## 文件用途

- `blind-review.csv`：给盲审人的唯一文件。只有 caseId、pair 输入列与人工回填列；不包含 weak verdict、localScore、reason、sourceStratum 等任何提示。
- `frozen-manifest.json`（私有，勿交盲审人）：记录 split、sourceStratum、cluster 连通分量、每 case 输入 checksum、snapshot/源文件 sha256、baseCommit、methodVersion（本脚本代码 hash）。当前 git HEAD 只作为参数记录。
- `frozen-manifest.sha256`：manifest 精确字节的 sha256，仅作本地便利。**信任根不是这个 sidecar**：真正的 trust anchor 是 root 记录在外部（SQLite Artifact）中的 digest，assess 必填 `--expected-manifest-sha` 并在 parse/读取 snapshot 路径之前先比对。即使攻击者同时改写 manifest 和 sidecar，只要 external digest 独立保管未被动过，assess 仍会以 digest 不匹配拒绝——同改两个本地文件并不自动越界；只有能改写外部 SQLite trust anchor 本身才超出本工具防护边界。只使用 sha256，无 HMAC/密钥。
- CSV 入口严格校验：header 列名唯一，未知列（输入列白名单之外，如 weakScore/stratum）与缺列直接拒绝；unclosed quote、unquoted 字段内引号、行列数不齐均拒绝。prepare 的非空断言只有 leftTitle（其余输入列如 signatures/dates 允许为合法空值），即「必需输入列必须存在，leftTitle 非空」，且人工列必须为空。原 36 例 pending CSV 的 `reviewerNotes` 列被明确允许以保持兼容；assess 侧 labels CSV 必须与 BLIND_COLUMNS 完全一致，缺列报 invalid_input 而非误导性 checksum 错误。
- `readiness-report.json`：assess 输出。`aiCounts`/`aiCost` 恒为 `not_measured`；本工具永不输出 quality_passed，最好结果是 `ready_for_replay`。

## 盲标规则

只依据 pair 双方可见信息独立判断是否同一事件；`same` / `diff` / 证据不足标 `uncertain`；`uncertain` 永不计入 `diff`。`reviewStatus=reviewed` 且 reviewer 非空、reviewedAt 可解析的行才可能计入指标；reviewer 留空的行会被排除并单独计数。

## 可信来源与边界

- 数据来源：36 条 BM25 hard-case pending 样本（`docs/eval/bm25-hard-cases-review-2026-09-26.csv` + 同日 manifest），只读快照 `prod-snapshot-2026-09-21.db`（sha `72c7049a…828e`）。prepare 会校验 sha、36 个 caseId 唯一且内容一致、cluster id 方向（pairKey 无序匹配）。
- dev/holdout 按共享 cluster id 的连通分量整块切分（分量不跨 split，确定性约 2:1 按 stratum 平衡；当前实际 24/12，各 stratum 内也 2:1）。同一分量过大无法切分时报 `cannot_split`，不伪造 holdout。
- 这 36 例是刻意挑选的 hard cases，**不能**解读为总体错误率或完整候选召回基线。
- Baseline 状态：deferred, not completed。旧 `scripts/eval-bm25-vs-lexical.ts` 的 currentScore 实际是 legacy lexical 分数，不是当前生产策略，也不是端到端 AI 管线；其任何回放结果只能是 diagnostic_only，不得当作质量结论。真实回放待人工标注完成后进行。
