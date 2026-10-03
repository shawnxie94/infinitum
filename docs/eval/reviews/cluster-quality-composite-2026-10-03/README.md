# Cluster quality composite evaluation set (2026-10-03)

This is an **additive, cohort-separated development set**, not a replacement for either frozen source packet and not a release-pass artifact.

## Composition

- `dev.csv`: all 24 already-reviewed **dev** cases from the 2026-10-01 packet (10 same / 14 diff) plus all 16 dev cases from the 2026-10-02 fresh packet (0 same / 16 diff). Total: 40 (10 same / 30 diff).
- `holdout.csv`: the 8 cases from the 2026-10-02 packet (1 same / 7 diff), unchanged in source membership. The 2026-10-01 holdout (12 cases) stays in its original packet and is not moved into this set.
- `diagnostic-only/unrelated-subjects-1420-reviewed.csv`: model-assisted review of the 1,420-pair sparse-veto audit. It is **not human gold** and is not counted in the label totals.
- `manifest.json`: source paths, SHA-256 anchors, cohort/as-of/method provenance, split composition, and output checksums.

## Interpretation

The two development cohorts have different snapshots, `asOf` values, and method versions. Keep metrics stratified by cohort and snapshot; do not present the combined counts as an estimate for one common production population. The older dev cases are useful labeled challenge cases, but many are outside the later cohort's 7-day window. The 2026-10-02 holdout stays sealed from development use.

The 1,420-pair diagnostic found no likely same-event recall case after one source-checked topical-but-distinct pair was resolved. Its labels were model-assisted; it is a diagnostic negative challenge set, not gold truth.

No source freeze, original reviewed CSV, algorithm, threshold, or production database is modified by this composite export. Quality remains `diagnostic_incomplete` until current-candidate replay and the remaining acceptance evidence are complete.

## Verify

```bash
python3 docs/eval/reviews/cluster-quality-composite-2026-10-03/verify_set.py
```
