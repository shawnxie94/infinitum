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
