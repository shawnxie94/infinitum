# Baseline report — cluster-quality snapshot counterfactual

- status: `diagnostic_incomplete`（CLI exit 2）；release_eligible: false
- 输入 SHA：frozen `36fa4b92` / snapshot `72c7049a` / sampling `769d3fd1` / labels `560649b6`；snapshot 运行后未变：true
- 场景：corpus 1920 簇（scan cap 2500），live endpoints 14（counterfactual_reviewed_endpoints_live）；vector disabled_not_measured；itemsSourceFilter unavailable_missing_tables:items,sources

## 覆盖

- total 36（dev 24 / holdout 12），eligible 7（dev 7 / holdout 0）
- 排除：out_of_lookback_window 29
- 快照字段比对：实际比对 7/36，未比对 29（snapshot field comparison only ran for cases passing cluster-presence and window checks; earlier-excluded cases are not compared and no no-drift claim is made for them）
- CSV checksum 与冻结 inputSha256 校验：36/36 通过

## Stage 准入指标（candidate-selector，非 final merging）

- dev：same 1/1 admitted（recall 1），diff 3/6 admitted（rate 0.5）
- holdout：same 0/0 admitted（recall null），diff 0/0 admitted（rate null）

## Dev 未准入原因（逐字来自报告，无推测）

- HC-00473323E101: safety_rejected:unrelated_subjects
- HC-0413ECFDBB0D: not_selected_with_available_diagnostics
- HC-0A393FE95C21: not_selected_with_available_diagnostics

stableDecisionDigest: `74ccc8660df07990a2ee76b97b8fd81a3d6665fc32a81e8c8d937c9d0e6ed82d`（git HEAD `35b8d4174807`；排除时间戳/timing）

局限：sampling strata are 12 same-event-fingerprint + 24 high-lexical-score declined hard cases; rates are biased-sample diagnostics, not a global error rate
