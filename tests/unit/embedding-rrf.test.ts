import { describe, expect, it } from "vitest";

import type { ClusterAssignmentCandidate } from "@/lib/clusters/repository";
import {
  buildEmbeddingText,
  cosineSimilarity,
  createEmbedTexts,
} from "@/lib/ai/embeddings";
import {
  fuseOrdersByRrf,
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
    strongMatch: false,
    ...overrides,
  };
}

describe("fuseOrdersByRrf", () => {
  it("merges both lists with reciprocal rank fusion", () => {
    // rule: a(1/61) b(1/62)；vec: b(1/61) c(1/62)
    // b = 1/62 + 1/61 ≈ 0.03225 > a = c ≈ 0.01639
    const fused = fuseOrdersByRrf(["a", "b"], ["b", "c"], 60);
    expect(fused[0]).toBe("b");
    expect(fused.slice(1).sort()).toEqual(["a", "c"]);
  });

  it("keeps rule leader ahead when vec list is empty", () => {
    expect(fuseOrdersByRrf(["a", "b", "c"], [], 60)).toEqual(["a", "b", "c"]);
  });

  it("breaks score ties by rule position", () => {
    // vec#1 与 rule#1 同分（1/61），并列时 rule 优先
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
});

describe("selectAiCandidatesWithEmbeddingRecall", () => {
  const makeEntry = (id: string, score: number, flags: Partial<ScoredClusterCandidate> = {}) =>
    buildScored(buildCandidate({ id }), { score, ...flags });

  it("promotes a vec-strong candidate that fails the rule score gate", async () => {
    const ruleTop = makeEntry("rule-top", 90);
    const vecOnly = makeEntry("vec-only", 10); // 低于 35，规则不可见
    const noise = makeEntry("noise-1", 60);
    const ruleRanked = [ruleTop, noise, vecOnly];
    const ruleQualified = [ruleTop, noise];

    const embedTexts = async (texts: string[]) => {
      // texts = [item, rule-top, noise-1, vec-only]：item 与 vec-only 语义相同
      return texts.map((_, index) => (index === 0 || index === 3 ? [1, 0] : [0, 1]));
    };

    const slice = await selectAiCandidatesWithEmbeddingRecall({
      embedTexts,
      itemTitle: "item",
      itemSummary: "vec-only",
      ruleRanked,
      ruleQualified,
      rrfK: 60,
      limit: 10,
    });

    expect(slice[0]!.candidate.id).toBe("rule-top"); // 规则首位钉住
    expect(slice.map((entry) => entry.candidate.id)).toContain("vec-only");
  });

  it("falls back to rule slice when embeddings are unavailable", async () => {
    const ruleTop = makeEntry("rule-top", 90);
    const vecOnly = makeEntry("vec-only", 10);
    const embedTexts = async () => null;

    const slice = await selectAiCandidatesWithEmbeddingRecall({
      embedTexts,
      itemTitle: "item",
      itemSummary: "vec-only",
      ruleRanked: [ruleTop, vecOnly],
      ruleQualified: [ruleTop],
      rrfK: 60,
      limit: 10,
    });

    expect(slice.map((entry) => entry.candidate.id)).toEqual(["rule-top"]);
  });

  it("never admits hard-conflict candidates even when vec-similar", async () => {
    const conflict = makeEntry("conflict", 10, { hardConflict: true, dateCompatible: false });
    const ruleTop = makeEntry("rule-top", 90);
    const embedTexts = async (texts: string[]) => texts.map(() => [1, 0]);

    const slice = await selectAiCandidatesWithEmbeddingRecall({
      embedTexts,
      itemTitle: "item",
      itemSummary: "conflict",
      ruleRanked: [ruleTop, conflict],
      ruleQualified: [ruleTop],
      rrfK: 60,
      limit: 10,
    });

    expect(slice.map((entry) => entry.candidate.id)).toEqual(["rule-top"]);
  });

  it("caps the slice at limit and pins the rule leader", async () => {
    const entries = Array.from({ length: 20 }, (_, index) => makeEntry(`c${String(index).padStart(2, "0")}`, 100 - index));
    const embedTexts = async (texts: string[]) => texts.map((_, index) => (index === 0 ? [0, 1] : [Math.exp(-index), 1]));

    const slice = await selectAiCandidatesWithEmbeddingRecall({
      embedTexts,
      itemTitle: "item",
      itemSummary: "c00",
      ruleRanked: entries,
      ruleQualified: entries,
      rrfK: 60,
      limit: 5,
    });

    expect(slice).toHaveLength(5);
    expect(slice[0]!.candidate.id).toBe("c00");
  });

  it("returns rule slice when every candidate is vetoed", async () => {
    const conflict = makeEntry("conflict", 90, { hardConflict: true, dateCompatible: false });
    const embedTexts = async () => {
      throw new Error("should not be called");
    };

    const slice = await selectAiCandidatesWithEmbeddingRecall({
      embedTexts,
      itemTitle: "item",
      itemSummary: "conflict",
      ruleRanked: [conflict],
      ruleQualified: [],
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
    const disabled = createEmbedTexts({ ...config, enabled: false }, { client: null });
    expect(await disabled(["文本"])).toBeNull();

    const missing = createEmbedTexts(null, { client: null });
    expect(await missing(["文本"])).toBeNull();
  });

  it("returns empty array for empty input", async () => {
    const embed = createEmbedTexts(config, { client: { embeddings: { create: async () => { throw new Error("no"); } } } });
    expect(await embed([])).toEqual([]);
  });
});
