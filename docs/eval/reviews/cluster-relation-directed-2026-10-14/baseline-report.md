# Baseline report — cluster-quality snapshot counterfactual

- status: `diagnostic_incomplete`（CLI exit 2）；release_eligible: false
- 输入 SHA：frozen `ec21fe1b` / snapshot `c852d2c3` / sampling `1888a4b3` / labels `2af89d22`；snapshot 运行后未变：true
- 场景：corpus 139 簇（scan cap 2500），live endpoints 0（counterfactual_reviewed_endpoints_live）；vector disabled_not_measured；itemsSourceFilter enforced_production_exists_filter

## 覆盖

- total 12（dev 8 / holdout 4），eligible 0（dev 0 / holdout 0）
- 排除：out_of_lookback_window 12
- 快照字段比对：实际比对 0/12，未比对 12（snapshot field comparison only ran for cases passing cluster-presence and window checks; earlier-excluded cases are not compared and no no-drift claim is made for them）
- CSV checksum 与冻结 inputSha256 校验：12/12 通过

## Stage 准入指标（candidate-selector，非 final merging）

- dev：same 0/0 admitted（recall null），diff 0/0 admitted（rate null）
- holdout：same 0/0 admitted（recall null），diff 0/0 admitted（rate null）

## Dev 未准入原因（逐字来自报告，无推测）

- 无

stableDecisionDigest: `5f5e463178f41041d04e98674f712b6a43de484faf40675af9fd9bc6980fd81d`（git HEAD `0cacd8a8f816`；排除时间戳/timing）

局限：sampling strata are 2 identity_boundary + 4 multi_event_overlap + 4 progress_boundary + 2 shared_subject_control hard cases; rates are biased-sample diagnostics, not a global error rate
