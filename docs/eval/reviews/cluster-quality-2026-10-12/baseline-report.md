# Baseline report — cluster-quality snapshot counterfactual

- status: `diagnostic_complete`（CLI exit 0）；release_eligible: false
- 输入 SHA：frozen `7d574983` / snapshot `c852d2c3` / sampling `3a87ac3f` / labels `a3755d99`；snapshot 运行后未变：true
- 场景：corpus 139 簇（scan cap 2500），live endpoints 48（counterfactual_reviewed_endpoints_live）；vector disabled_not_measured；itemsSourceFilter enforced_production_exists_filter

## 覆盖

- total 24（dev 16 / holdout 8），eligible 24（dev 16 / holdout 8）
- 排除：无
- 快照字段比对：实际比对 24/24，未比对 0（snapshot field comparison only ran for cases passing cluster-presence and window checks; earlier-excluded cases are not compared and no no-drift claim is made for them）
- CSV checksum 与冻结 inputSha256 校验：24/24 通过

## Stage 准入指标（candidate-selector，非 final merging）

- dev：same 1/1 admitted（recall 1），diff 12/15 admitted（rate 0.8）
- holdout：same 1/1 admitted（recall 1），diff 6/7 admitted（rate 0.8571428571428571）

## Dev 未准入原因（逐字来自报告，无推测）

- CQ-6D17E63300D9: safety_rejected:unrelated_subjects
- CQ-9B55E619D9E1: safety_rejected:no_event_anchor
- CQ-F48B5AA6A86F: safety_rejected:unrelated_subjects

stableDecisionDigest: `4b5c5a795ca87581f95fa9e086ac3e8cebbccb6b070c4ccf610dd826572ba3df`（git HEAD `2f38e04e77c3`；排除时间戳/timing）

局限：sampling strata are 18 high_bm25_near_neighbor + 4 low_similarity_coverage + 2 safety_rejected_related hard cases; rates are biased-sample diagnostics, not a global error rate
