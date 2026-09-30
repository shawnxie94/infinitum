import { describe, expect, it } from "vitest";

import type { ClusterAssignmentCandidate } from "@/lib/clusters/repository";
import {
  buildEmbeddingText,
  cosineSimilarity,
  createEmbedTexts,
} from "@/lib/ai/embeddings";
import {
  fuseOrdersByRrf,
  resolveMergePairAdmission,
  selectAiCandidatesWithEmbeddingRecall,
  type ScoredClusterCandidate,
} from "@/lib/clusters/embedding-recall";

function buildCandidate(overrides: Partial<ClusterAssignmentCandidate> = {}): ClusterAssignmentCandidate {
  return {
    id: "cluster-1",
    title: "测试标题",
    summary: "测试摘要",
    fingerprint: "fp",
    eventFingerprint: null,
    eventBucket: null,
    eventType: null,
    eventSubject: null,
    eventAction: null,
    eventObject: null,
    eventDate: null,
    latestPublishedAt: new Date("2026-09-01T00:00:00Z"),
    itemCount: 1,
    ...overrides,
  };
}

function buildScored(
  candidate: ClusterAssignmentCandidate,
  overrides: Partial<Omit<ScoredClusterCandidate, "candidate">> = {},
): ScoredClusterCandidate {
  return {
    candidate,
    score: 50,
    dateCompatible: true,
    preciseDateDrift: false,
    hardConflict: false,
    ...overrides,
  };
}

describe("fuseOrdersByRrf", () => {
  it("merges both lists with reciprocal rank fusion", () => {
    // sparse: a(1/61) b(1/62)；vec: b(1/61) c(1/62)
    // b = 1/62 + 1/61 ≈ 0.03225 > a = c ≈ 0.01639
    const fused = fuseOrdersByRrf(["a", "b"], ["b", "c"], 60);
    expect(fused[0]).toBe("b");
    expect(fused.slice(1).sort()).toEqual(["a", "c"]);
  });

  it("keeps sparse order when the vector list is empty", () => {
    expect(fuseOrdersByRrf(["a", "b", "c"], [], 60)).toEqual(["a", "b", "c"]);
  });

  it("breaks score ties by sparse position", () => {
    // vec#1 与 sparse#1 同分（1/61），并列时保留 sparse 优先
    const fused = fuseOrdersByRrf(["a", "b"], ["x", "y"], 60);
    expect(fused).toEqual(["a", "x", "b", "y"]);
  });

  it("handles ids appearing in both lists only once", () => {
    const fused = fuseOrdersByRrf(["a"], ["a"], 60);
    expect(fused).toEqual(["a"]);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for mismatched lengths or zero vectors", () => {
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("buildEmbeddingText", () => {
  it("joins title and summary with newline and trims summary", () => {
    expect(buildEmbeddingText("标题", " 摘要 ")).toBe("标题\n摘要");
    expect(buildEmbeddingText("标题", null)).toBe("标题\n");
  });

  it("includes event identity fields when provided", () => {
    expect(buildEmbeddingText("标题", "摘要", {
      eventType: "release",
      eventSubject: "主体",
      eventAction: "发布",
      eventObject: "产品",
      eventDate: "2026-09-20",
    })).toContain("主体：主体");
  });
});

describe("resolveMergePairAdmission", () => {
  const GRAY = 55;
  const VEC = 0.72;
  const OVERRIDE = 0.9;

  it("admits by rule when score reaches the gray zone", () => {
    const admission = resolveMergePairAdmission(
      { rejected: false, rejectedReason: null, score: 60 },
      null,
      GRAY,
      VEC,
      OVERRIDE,
    );
    expect(admission).toEqual({ admitted: true, priorityScore: 60, source: "rule" });
  });

  it("admits by vector when rule is blind to no_event_anchor pairs", () => {
    const admission = resolveMergePairAdmission(
      { rejected: true, rejectedReason: "no_event_anchor", score: 8 },
      0.95,
      GRAY,
      VEC,
      OVERRIDE,
    );
    expect(admission).toEqual({ admitted: true, priorityScore: 95, source: "vector" });
  });

  it("admits by vector when rule score is below the gray zone", () => {
    const admission = resolveMergePairAdmission(
      { rejected: false, rejectedReason: null, score: 30 },
      0.8,
      GRAY,
      VEC,
      OVERRIDE,
    );
    expect(admission).toEqual({ admitted: true, priorityScore: 80, source: "vector" });
  });

  it("admits object_conflict pairs when vector similarity reaches its own threshold", () => {
    const admission = resolveMergePairAdmission(
      { rejected: true, rejectedReason: "object_conflict", score: 0 },
      0.85,
      GRAY,
      VEC,
      OVERRIDE,
    );
    expect(admission).toEqual({ admitted: true, priorityScore: 85, source: "vector" });
  });

  it("admits unrelated structured subjects through the independent vector lane", () => {
    const admission = resolveMergePairAdmission(
      { rejected: true, rejectedReason: "unrelated_subjects", score: 0 },
      1,
      GRAY,
      VEC,
      OVERRIDE,
    );
    expect(admission).toEqual({ admitted: true, priorityScore: 100, source: "vector" });
  });

  it("admits high-similarity object_conflict pairs through the vector lane", () => {
    const admission = resolveMergePairAdmission(
      { rejected: true, rejectedReason: "object_conflict", score: 0 },
      0.95,
      GRAY,
      VEC,
      OVERRIDE,
    );
    expect(admission).toEqual({ admitted: true, priorityScore: 95, source: "vector" });
  });

  it("rejects pairs below both gates", () => {
    expect(
      resolveMergePairAdmission({ rejected: true, rejectedReason: "no_event_anchor", score: 8 }, 0.5, GRAY, VEC, OVERRIDE).admitted,
    ).toBe(false);
    expect(
      resolveMergePairAdmission({ rejected: false, rejectedReason: null, score: 30 }, null, GRAY, VEC, OVERRIDE).admitted,
    ).toBe(false);
  });
});

describe("selectAiCandidatesWithEmbeddingRecall", () => {
  const makeEntry = (id: string, score: number, flags: Partial<ScoredClusterCandidate> = {}) =>
    buildScored(buildCandidate({ id }), { score, ...flags });

  it("keeps zero-overlap candidates available to the independent vector lane", async () => {
    const sparseTop = makeEntry("sparse-top", 900);
    const vectorOnly = makeEntry("vector-only", 0);
    const eligibleCandidates = [sparseTop, vectorOnly];
    const sparseCandidates = [sparseTop];
    const embedTexts = async (texts: string[]) =>
      texts.map((_, index) => (index === 0 || index === 2 ? [1, 0] : [0, 1]));

    const slice = await selectAiCandidatesWithEmbeddingRecall({
      embedTexts,
      itemTitle: "item",
      itemSummary: "vector-only",
      eligibleCandidates,
      sparseCandidates,
      rrfK: 60,
      limit: 10,
    });

    expect(slice.map((entry) => entry.candidate.id)).toContain("vector-only");
  });

  it("falls back to positive BM25 sparse matches when embeddings are unavailable", async () => {
    const sparseTop = makeEntry("sparse-top", 900);
    const zeroOverlap = makeEntry("zero-overlap", 0);
    const embedTexts = async () => null;

    const slice = await selectAiCandidatesWithEmbeddingRecall({
      embedTexts,
      itemTitle: "item",
      itemSummary: "zero-overlap",
      eligibleCandidates: [sparseTop, zeroOverlap],
      sparseCandidates: [sparseTop],
      rrfK: 60,
      limit: 10,
    });

    expect(slice.map((entry) => entry.candidate.id)).toEqual(["sparse-top"]);
  });

  it("never sends date-incompatible or hard-conflict candidates through vector recall", async () => {
    const conflict = makeEntry("conflict", 0, { hardConflict: true });
    const dateMismatch = makeEntry("date-mismatch", 0, { dateCompatible: false });
    const sparseTop = makeEntry("sparse-top", 900);
    const embedTexts = async (texts: string[]) => texts.map(() => [1, 0]);

    const slice = await selectAiCandidatesWithEmbeddingRecall({
      embedTexts,
      itemTitle: "item",
      itemSummary: "conflict",
      eligibleCandidates: [sparseTop, conflict, dateMismatch],
      sparseCandidates: [sparseTop],
      rrfK: 60,
      limit: 10,
    });

    expect(slice.map((entry) => entry.candidate.id)).toEqual(["sparse-top"]);
  });

  it("fuses sparse and vector orders before applying the candidate limit", async () => {
    const entries = Array.from({ length: 20 }, (_, index) => makeEntry(`c${String(index).padStart(2, "0")}`, 2_000 - index));
    const embedTexts = async (texts: string[]) => texts.map((_, index) => (index === 0 ? [0, 1] : [Math.exp(-index), 1]));

    const slice = await selectAiCandidatesWithEmbeddingRecall({
      embedTexts,
      itemTitle: "item",
      itemSummary: "c00",
      eligibleCandidates: entries,
      sparseCandidates: entries,
      rrfK: 60,
      limit: 5,
    });

    expect(slice).toHaveLength(5);
    expect(slice[0]!.candidate.id).toBe("c00");
  });

  it("returns no candidates when all candidates fail the safety guards", async () => {
    const conflict = makeEntry("conflict", 0, { hardConflict: true, dateCompatible: false });
    const embedTexts = async () => {
      throw new Error("should not be called");
    };

    const slice = await selectAiCandidatesWithEmbeddingRecall({
      embedTexts,
      itemTitle: "item",
      itemSummary: "conflict",
      eligibleCandidates: [conflict],
      sparseCandidates: [],
      rrfK: 60,
      limit: 10,
    });

    expect(slice).toEqual([]);
  });
});

describe("createEmbedTexts", () => {
  const config = {
    enabled: true,
    baseUrl: "http://localhost:3000/v1",
    apiKey: "test-key",
    modelName: "test-embed",
    dimensions: null,
    batchSize: 2,
    timeoutMs: 5000,
  };

  it("returns null for unconfigured or disabled config", async () => {
    const disabled = createEmbedTexts({ ...config, enabled: false }, { transport: null });
    expect(await disabled(["文本"])).toBeNull();

    const missing = createEmbedTexts(null, { transport: null });
    expect(await missing(["文本"])).toBeNull();
  });

  it("returns empty array for empty input", async () => {
    const embed = createEmbedTexts(config, { transport: async () => { throw new Error("no"); } });
    expect(await embed([])).toEqual([]);
  });
});
