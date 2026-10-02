# Baseline report — cluster-quality snapshot counterfactual

- status: `diagnostic_incomplete`（CLI exit 2）；release_eligible: false
- 输入 SHA：frozen `10fa0c8a` / snapshot `0d6e998b` / sampling `54866e23` / labels `da2bd8b7`；snapshot 运行后未变：true
- 场景：corpus 99 簇（scan cap 2500），live endpoints 48（counterfactual_reviewed_endpoints_live）；vector disabled_not_measured；itemsSourceFilter enforced_production_exists_filter

## 覆盖

- total 24（dev 16 / holdout 8），eligible 24（dev 16 / holdout 8）
- 排除：无
- 快照字段比对：实际比对 24/24，未比对 0（snapshot field comparison only ran for cases passing cluster-presence and window checks; earlier-excluded cases are not compared and no no-drift claim is made for them）
- CSV checksum 与冻结 inputSha256 校验：24/24 通过

## Stage 准入指标（candidate-selector，非 final merging）

- dev：same 0/0 admitted（recall null），diff 12/16 admitted（rate 0.75）
- holdout：same 1/1 admitted（recall 1），diff 5/7 admitted（rate 0.7142857142857143）

## Dev 未准入原因（逐字来自报告，无推测）

- CQ-023955463DF8: safety_rejected:unrelated_subjects
- CQ-8019A69C2EB5: safety_rejected:unrelated_subjects
- CQ-B29146173708: safety_rejected:unrelated_subjects
- CQ-DCC1EC4B97F8: safety_rejected:unrelated_subjects

stableDecisionDigest: `edb1fab7207bdf133d6835ffb25f69a1068a40800cdcb6661f66079faccb9797`（git HEAD `35b8d4174807`；排除时间戳/timing）

局限：sampling strata are 18 high_bm25_near_neighbor + 4 low_similarity_coverage + 2 safety_rejected_related hard cases; rates are biased-sample diagnostics, not a global error rate
