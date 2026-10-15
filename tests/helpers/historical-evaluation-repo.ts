import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Isolated historical inputs, never a way to re-sign a frozen packet against current source. */
export function createHistoricalEvaluationRepo(repo: string, parent: string): string {
  const out = join(parent, "historical-repo");
  const files = new Set<string>();
  for (const name of ["offline-contract", "production-bridge", "admission-state", "production-blind-pack"]) {
    const packet = `docs/eval/reviews/cluster-relation-${name}-2026-10-14/packet`;
    const manifest = JSON.parse(readFileSync(join(repo, packet, "manifest.json"), "utf8")) as {
      references?: Record<string, string>; codeHashes?: Record<string, string>; fileHashes: Record<string, string>;
    };
    files.add(`${packet}/manifest.json`);
    files.add(`${packet}/manifest.sha256`);
    for (const path of Object.keys(manifest.fileHashes)) files.add(`${packet}/${path}`);
    for (const path of Object.keys(manifest.references ?? manifest.codeHashes ?? {})) files.add(path);
  }
  for (const path of files) {
    assert(!path.startsWith("/") && !path.split("/").includes(".."), path);
    mkdirSync(dirname(join(out, path)), { recursive: true });
    copyFileSync(join(repo, path), join(out, path));
  }
  const archive = join(repo, "docs/eval/reviews/cluster-relation-archive-2026-10-15");
  const map = JSON.parse(readFileSync(join(archive, "source-map.json"), "utf8")) as {
    sources: Record<string, { snapshot: string; sha256: string }>;
  };
  const paths = ["src/lib/clusters/normalization.ts", "src/lib/ai/provider-next.ts", "scripts/replay-cluster-relation-source-v2.ts", "src/lib/ai/protocols/item-understanding.ts"];
  assert.deepEqual(Object.keys(map.sources), paths);
  for (const path of paths) {
    const entry = map.sources[path];
    assert(/^sources\/[a-z0-9.-]+\.snapshot$/.test(entry.snapshot), entry.snapshot);
    const bytes = readFileSync(join(archive, entry.snapshot));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, path);
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), bytes);
  }
  return out;
}
