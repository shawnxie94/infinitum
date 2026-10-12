#!/usr/bin/env python3
"""Verify the additive cluster-quality cohort export without changing sources."""
from __future__ import annotations

import csv
import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        return list(reader.fieldnames or []), rows


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"FAIL: {message}")


manifest = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
require(manifest["schemaVersion"] == 1, "unsupported manifest schema")

source_data: dict[str, dict] = {}
for cohort in manifest["sourceCohorts"]:
    manifest_path = ROOT / cohort["manifestPath"]
    labels_path = ROOT / cohort["labelsPath"]
    snapshot_path = ROOT / cohort["sourceSnapshotPath"]
    require(sha256(manifest_path) == cohort["sourceManifestSha256"], f"source manifest drift: {cohort['cohortId']}")
    require(sha256(labels_path) == cohort["sourceLabelsSha256"], f"source labels drift: {cohort['cohortId']}")
    require(sha256(snapshot_path) == cohort["sourceSnapshotSha256"], f"source snapshot drift: {cohort['cohortId']}")
    frozen = json.loads(manifest_path.read_text(encoding="utf-8"))
    fields, rows = read_csv(labels_path)
    source_rows = {row["caseId"]: row for row in rows}
    case_meta = {case["caseId"]: case for case in frozen["cases"]}
    require(len(source_rows) == len(rows), f"duplicate source caseId: {cohort['cohortId']}")
    require(set(source_rows) == set(case_meta), f"source manifest/CSV case coverage drift: {cohort['cohortId']}")
    require(frozen["snapshot"]["sha256"] == cohort["sourceSnapshotSha256"], f"snapshot anchor mismatch: {cohort['cohortId']}")
    require(frozen["asOf"] == cohort["sourceAsOf"], f"asOf mismatch: {cohort['cohortId']}")
    require(frozen["methodVersion"] == cohort["sourceMethodVersion"], f"methodVersion mismatch: {cohort['cohortId']}")
    source_data[cohort["cohortId"]] = {
        "manifest": frozen,
        "fields": fields,
        "rows": source_rows,
        "caseMeta": case_meta,
        "cohort": cohort,
    }

for file_name, hash_key in (("dev.csv", "devCsvSha256"), ("holdout.csv", "holdoutCsvSha256")):
    path = HERE / file_name
    require(sha256(path) == manifest["outputs"][hash_key], f"output checksum mismatch: {file_name}")

suite_fields: dict[str, list[dict[str, str]]] = {}
for split in ("dev", "holdout"):
    fields, rows = read_csv(HERE / f"{split}.csv")
    require(rows, f"empty {split}.csv")
    require(len({row["caseId"] for row in rows}) == len(rows), f"duplicate suite caseId in {split}")
    suite_fields[split] = rows
    for row in rows:
        cohort = source_data.get(row["sourceCohort"])
        require(cohort is not None, f"unknown source cohort: {row['sourceCohort']}")
        require(row["suiteSplit"] == split, f"wrong suite split for {row['caseId']}")
        source_id = row["sourceCaseId"]
        require(source_id in cohort["rows"], f"unknown source case: {source_id}")
        original = cohort["rows"][source_id]
        meta = cohort["caseMeta"][source_id]
        source_spec = cohort["cohort"]
        require(row["sourceSplit"] == meta["split"], f"source split drift: {source_id}")
        require(row["sourceStratum"] == (meta.get("sourceStratum") or "unknown"), f"source stratum drift: {source_id}")
        require(row["sourceAsOf"] == source_spec["sourceAsOf"], f"source asOf drift: {source_id}")
        require(row["sourceManifestPath"] == source_spec["manifestPath"], f"manifest path drift: {source_id}")
        require(row["sourceLabelsPath"] == source_spec["labelsPath"], f"labels path drift: {source_id}")
        require(row["sourceSnapshotPath"] == source_spec["sourceSnapshotPath"], f"snapshot path drift: {source_id}")
        require(row["sourceManifestSha256"] == source_spec["sourceManifestSha256"], f"manifest provenance drift: {source_id}")
        require(row["sourceLabelsSha256"] == source_spec["sourceLabelsSha256"], f"label provenance drift: {source_id}")
        require(row["sourceSnapshotSha256"] == source_spec["sourceSnapshotSha256"], f"snapshot provenance drift: {source_id}")
        require(row["humanLabel"] == original["humanLabel"], f"label changed: {source_id}")
        for field in cohort["fields"]:
            if field == "caseId":
                continue
            require(row.get(field, "") == original.get(field, ""), f"source field changed ({field}): {source_id}")
        expected_suite_split = "dev" if source_spec["cohortId"] == "2026-10-01" else meta["split"]
        require(split == expected_suite_split, f"case moved across split: {source_id}")

expected_counts = manifest["expectedCounts"]
require(len(suite_fields["dev"]) == expected_counts["dev"]["total"], "dev row count mismatch")
require(len(suite_fields["holdout"]) == expected_counts["holdout"]["total"], "holdout row count mismatch")
for split in ("dev", "holdout"):
    counts = Counter(row["humanLabel"] for row in suite_fields[split])
    require(dict(counts) == expected_counts[split]["labels"], f"{split} label counts mismatch: {dict(counts)}")

# A cluster may not cross the composite dev/holdout boundary.
def cluster_ids(rows: list[dict[str, str]]) -> set[str]:
    result = set()
    for row in rows:
        meta = source_data[row["sourceCohort"]]["caseMeta"][row["sourceCaseId"]]
        result.update(meta["clusterIds"])
    return result

require(not cluster_ids(suite_fields["dev"]) & cluster_ids(suite_fields["holdout"]), "cluster ID crosses dev/holdout")

# The old cohort contributes dev only; neither its 12 holdout cases nor their labels
# may be imported into the composite suite.
old = source_data["2026-10-01"]
old_holdout = {case_id for case_id, meta in old["caseMeta"].items() if meta["split"] == "holdout"}
require(not old_holdout & {row["sourceCaseId"] for rows in suite_fields.values() for row in rows if row["sourceCohort"] == "2026-10-01"}, "old holdout moved into composite")

# The 1,420-pair output is diagnostic-only and must never be mixed into human labels.
diag_path = HERE / manifest["diagnosticOnly"]["path"]
require(sha256(diag_path) == manifest["diagnosticOnly"]["sha256"], "diagnostic checksum mismatch")
_, diag_rows = read_csv(diag_path)
require(len(diag_rows) == manifest["diagnosticOnly"]["rows"] == 1420, "diagnostic row count mismatch")
require(len({row["pairKey"] for row in diag_rows}) == len(diag_rows), "duplicate diagnostic pairKey")
require(all(row["recallReviewClassification"] == "not_same_event" for row in diag_rows), "unexpected final diagnostic classification")
require("humanLabel" not in (read_csv(diag_path)[0]), "diagnostic must not be presented as human labels")

print(json.dumps({
    "status": "verified",
    "dev": {"total": len(suite_fields["dev"]), "labels": dict(Counter(r["humanLabel"] for r in suite_fields["dev"]))},
    "holdout": {"total": len(suite_fields["holdout"]), "labels": dict(Counter(r["humanLabel"] for r in suite_fields["holdout"]))},
    "diagnosticOnlyPairs": len(diag_rows),
    "sourceCohorts": list(source_data),
}, ensure_ascii=False))
