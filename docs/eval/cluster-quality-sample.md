# Cluster quality local qualification snapshot + fresh blind sample（2026-10-02，round 2）

阶段：`local_qualification_snapshot_sampler`（只读导出 + 本地配额采样；无 AI、无网络、无源库写入）。

## capture / 窗口

- 捕获 asOf：**2026-10-02T11:41:35.000Z**（round 1/2 同一快照冻结时刻，非重新取时）。
- 语料：99 eligible clusters（严格 production 窗口 + EXISTS 过滤 + scan cap 2500）；全库 911 active 中仅有的 2 组相同 eventFingerprint 重复是 `mock-review-*` 测试数据，不在窗口内，未入样（真实语料 sameFP 对为 0）。

## round 2 采样（替换 round 1 的 24 全 high-BM25 样本）

- universe：99 clusters 全 unordered pairs = **4851 对**，逐对保留真实 safety 判定与 BM25 分（不再预筛掉 safety-rejected / zero-score）。
- 显式配额（scheduling hints，非 gold labels）：`high_similarity_or_same_fp 18 + safety_rejected_related 2 + low_similarity_coverage 4`。实际配额全满：{"high_similarity_or_same_fp": {"requested": 18, "actual": 18}, "safety_rejected_related": {"requested": 2, "actual": 2}, "low_similarity_coverage": {"requested": 4, "actual": 4}}。
- 实际 strata：{"low_similarity_coverage": 4, "high_bm25_near_neighbor": 18, "safety_rejected_related": 2}。real 7 天语料内 sameFP/已验证 event 边界对为 0；boundary stratum 命名要求 eventDate 或 eventAction 确实不同，否则归入 generic strata，不编边界。
- 选择算法：分数降序 + seed `'cluster-quality-fresh-sample'` sha 平局 tiebreak；配额顺序调度；原子驱逐式增广保证 24 对 cluster-disjoint 且 fp 组不跨 case；不放宽 source 过滤；无 label 先验，AI 未调用。
- 配额不满足时 fail-closed（`insufficient_sampling_capacity` + 逐配额缺口），不伪造 strata；候选采样自然偏置≠总体率，controls 不是人工 diff 标签。
- 弱线索（stratum / weakBm25Score / weakSafetyReason）只进私有 sampling manifest；blind CSV 无任何 hint，24 行 5 个人工字段全空 / pending。

## 命令（禁止覆盖；目标目录非空即拒绝，无 force 开关）

```bash
npx tsx scripts/prepare-cluster-quality-sample.ts sample \
  --snapshot docs/eval/snapshots/local-qualification-snapshot-2026-10-02.db --as-of 2026-10-02T11:41:35.000Z \
  --sources-dir docs/eval/reviews/cluster-quality-2026-10-02/sources --target 24
npx tsx scripts/eval-cluster-quality-review.ts prepare --snapshot docs/eval/snapshots/local-qualification-snapshot-2026-10-02.db \
  --labels docs/eval/reviews/cluster-quality-2026-10-02/sources/pending-review.csv --manifest docs/eval/reviews/cluster-quality-2026-10-02/sources/sampling-manifest.json \
  --out-dir docs/eval/reviews/cluster-quality-2026-10-02/packet
npx tsx scripts/eval-cluster-quality-review.ts assess --frozen docs/eval/reviews/cluster-quality-2026-10-02/packet/frozen-manifest.json \
  --expected-manifest-sha <frozen sha256> --labels docs/eval/reviews/cluster-quality-2026-10-02/packet/blind-review.csv \
  --out docs/eval/reviews/cluster-quality-2026-10-02/packet/readiness-report.json   # pending 时预期 insufficient_truth，exit 2
```

复评 baseline 时必须显式 `--as-of 2026-10-02T11:41:35.000Z`（与 frozen asOf 语义相等；capture 可晚于 snapshot MAX published）。

注：下表与命令中 blind-review.csv 的 hash 为冻结输入时刻值；人工回填后 canonical CSV sha 已改变，属预期，输入保护以 frozen manifest 的 per-case checksum 为准。评测建设已暂停，资料保留，后续不自动补样本/调策略。

## 文件与 SHA256 锚

| 文件 | 用途 | sha256 |
|---|---|---|
| `docs/eval/snapshots/local-qualification-snapshot-2026-10-02.db`（gitignored） | sanitized 资格快照（15/6/2 列，911/1095/3 行，round 1/2 未变动） | `0d6e998bff7495cb3df3487983351b247a13d22ba147210185c781b6be9146cd` |
| `docs/eval/reviews/cluster-quality-2026-10-02/sources/pending-review.csv` | 不可变来源 pending CSV（人工列全空） | `bc358419046baf1d811ed35f0147dbc0ff62934225e97c0a95837d1b1228308d` |
| `docs/eval/reviews/cluster-quality-2026-10-02/sources/sampling-manifest.json` | 私有采样 manifest（weak 分/safety 原因/配额统计） | `54866e23d06193ff0dc2288bd18d83eb3369175eeb9bed6269e6f60144725fc5` |
| `docs/eval/reviews/cluster-quality-2026-10-02/packet/frozen-manifest.json` | 私有冻结 manifest（sidecar 同值） | `10fa0c8a69ea400d70e3e3e1c45f2a0dc9c1a9a3938f2b3a1554a165e36471d1` |
| `docs/eval/reviews/cluster-quality-2026-10-02/packet/blind-review.csv` | 盲审 CSV（24 行 pending） | `bc358419046baf1d811ed35f0147dbc0ff62934225e97c0a95837d1b1228308d` |
| `docs/eval/reviews/cluster-quality-2026-10-02/packet/readiness-report.json` | assess 实际输出：`insufficient_truth`（exit 2），dev 16/holdout 8 | `40305cf880bd429dd54c6e77b5a6546b834a771ab1df0b5db5fe2df0e2a8844d` |

## round 2 再生成日志（用户标签 0 条，逐行确认后才删除重建）

删除并重建的文件（删除前 sha256，见 /tmp/cq-date02-previous-hashes.log 同值）：

```
sources/pending-review.csv 10029afb053e4c6f14dcd6ca1d055522cd1692cc33633ce02570624d820c2371
sources/sampling-manifest.json 88c39a4cdf1e8c1574d181663dad97b799829007d9a5b1c6e861c5a3bed5d904
packet/blind-review.csv 10029afb053e4c6f14dcd6ca1d055522cd1692cc33633ce02570624d820c2371
packet/frozen-manifest.json dd779dd16bb56cbc85fa8fab46067ae2f67c79bee8563c05c4af13e4ddd42d68
packet/frozen-manifest.sha256 c3f731ee61869e93bc8be50c83633fdff182e6afa987dfc9b2779cfb0600b312
packet/readiness-report.json 40305cf880bd429dd54c6e77b5a6546b834a771ab1df0b5db5fe2df0e2a8844d
README.md 0aacdb992b61e67994742bb84391f3122c84b5c353b77d31db03b1f485fded38
```

round 1 packet 未交付、未被 root pin；本轮修复了增广 relocation 的簇不相交 bug（重定位与端点重查后 48 cluster id 全唯一）。10-01 的任何 artifact/labels 与源 snapshot 未触碰；raw 备份临时文件（host+容器）round 1 已删除，本轮无新增。
