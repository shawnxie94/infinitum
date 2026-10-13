# Cluster quality composite evaluation set (2026-10-12)

Additive, cohort-separated suite: the full 2026-10-03 composite (2026-10-01 dev + 2026-10-02 dev/holdout) plus the new 2026-10-12 relation-semantics cohort. Not a release-pass artifact. `verify_set.py` verifies it (`status: verified`).

## Composition

- `dev.csv`: 56 cases — 2026-10-01 dev 24 (10 same / 14 diff) + 2026-10-02 dev 16 (0 same / 16 diff) + 2026-10-12 dev 16 (1 same_event / 15 unrelated). Merged: 11 same / 45 diff.
- `holdout.csv`: 16 cases — 2026-10-02 holdout 8 (1 same / 7 diff) + 2026-10-12 holdout 8 (1 same_event / 1 follow_up / 6 unrelated). Merged: 2 same / 14 diff.
- `diagnostic-only/`: the 1,420-pair model-assisted negative diagnostic (not human gold), inherited from 2026-10-03.

## 2026-10-12 cohort notes

- Labels use relation semantics (`same_event` / `follow_up` / `unrelated`); legacy cohorts keep `same` / `diff`. Replay tooling maps same_event→same, follow_up/synthesis/unrelated→diff (`eval-cluster-quality-baseline.ts` + `eval-cluster-quality-review.ts`, both updated 2026-10-12).
- 7-day window capacity was 24 pairs (quota-full: 18 high-BM25 + 2 safety-rejected + 4 low-similarity controls); 30 requested was refused fail-closed.
- asOf `2026-10-12T05:17:31Z`, snapshot `local-qualification-snapshot-2026-10-12.db`, base commit `4f0eec2`.

## Replay finding (2026-10-12 cohort)

`baseline-report.json` (diagnostic_complete, 24/24 eligible): **sameEventCandidateAdmissionRecall 0/1 dev, 0/1 holdout** — both human-confirmed same-event pairs came from the `safety_rejected_related` stratum and were vetoed by the candidate-selector safety gate before AI review (Apple October event announce vs official; OpenAI GPT-6 push two near-identical reports). diff admission 12/15 dev, 6/7 holdout (vetoes correct on those). `releaseEligible: false`.

Interpretation caution: only 2 same positives in this cohort, both hard-case strata by design — the 0-recall is a safety-gate false-veto signal, not a population-level recall estimate. The merged dev set (11 same) is the basis for the next threshold/safety calibration round.

## Verify

```bash
python3 docs/eval/reviews/cluster-quality-composite-2026-10-12/verify_set.py
```

## AI judgment layer offline evaluation (2026-10-13)

`ai-judgment-report.json`: composite dev 56 pairs through the REAL cluster-merge AI path (relation protocol v2-era prompt + MiniMax-M3, one call, 29,962 tokens, 24s).

- Merged-label same recall 9/11 (81.8%), **0 false merges** on 45 diff/follow_up cases; relation×reasonCode binding 56/56 protocol-clean.
- Both disagreements are relation-semantics boundary cases, not errors: fal H3 Max release→Twitch integration judged `follow_up` (directionally correct progress semantics; human `same` is legacy binary labeling); Amami-Island travel series (same-author aggregation philosophy).

### Run-to-run noise finding

Three full-suite runs on 2026-10-13:

| run | prompt | sameRecall | follow_up | note |
|---|---|---|---|---|
| v1-run1 | relation v1 | 9/11 | 1 | committed report |
| v2-run | v1 + synthesis-priority sentence | 9/11 | 4 | +1 false merge on an unrelated pair (Claude quota pair) → **rolled back** |
| v1-run2 | relation v1 (identical bytes) | 8/11 | 1 | 2 verdict flips vs v1-run1 (both same_event↔follow_up/unrelated boundary) |

Temperature is locked to 0, yet the provider is not fully deterministic: **single-run metrics carry a ~±1-case noise band** on this suite, concentrated on same_event/follow_up boundaries. Consequences: (1) prompt tweaks must be evaluated against this noise band, not single runs — the synthesis-priority calibration was reverted because its +1 false merge exceeded it; (2) future evaluation tooling should report multi-run agreement, not a single pass; (3) follow_up/synthesis boundary calibration needs dedicated human `synthesis` positives before retry.
