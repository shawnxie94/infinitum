import { describe, expect, it } from "vitest";

import {
  buildClusterMergeBm25Index,
  scoreClusterMergeBm25Pair,
  type Bm25ClusterDocument,
} from "@/lib/clusters/bm25";
import type { AiEventSignature } from "@/lib/ai/provider-types";
import {
  rankItemAssignmentCandidatesWithBm25,
  type ItemWithSource,
} from "@/lib/clusters/helpers";
import type { ClusterAssignmentCandidate } from "@/lib/clusters/repository";

function doc(id: string, text: string): Bm25ClusterDocument {
  return {
    id,
    title: text,
    summary: "",
    eventSubject: null,
    eventObject: null,
  };
}

describe("cluster merge BM25", () => {
  it("scores pairs symmetrically from the same in-window corpus index", () => {
    const clusters = [
      doc("a", "OpenAI 发布 GPT-6 Astra 模型"),
      doc("b", "GPT-6 Astra 模型正式发布"),
      doc("c", "苹果发布 iPhone 新品"),
    ];
    const index = buildClusterMergeBm25Index(clusters);

    expect(scoreClusterMergeBm25Pair(index, "a", "b")).toBeGreaterThan(0);
    expect(scoreClusterMergeBm25Pair(index, "a", "b")).toBe(scoreClusterMergeBm25Pair(index, "b", "a"));
    expect(index.docCount).toBe(3);
  });

  it("weights rare shared terms above corpus-wide common terms", () => {
    const index = buildClusterMergeBm25Index([
      doc("common-a", "common alpha token"),
      doc("common-b", "common beta token"),
      doc("rare-a", "common rareUnique123 alpha token"),
      doc("rare-b", "common rareUnique123 beta token"),
    ]);

    expect(scoreClusterMergeBm25Pair(index, "rare-a", "rare-b")).toBeGreaterThan(
      scoreClusterMergeBm25Pair(index, "common-a", "common-b"),
    );
  });

  it("returns zero when a pair has no shared tokens or the corpus is empty", () => {
    const index = buildClusterMergeBm25Index([doc("a", "alpha"), doc("b", "omega")]);
    expect(scoreClusterMergeBm25Pair(index, "a", "b")).toBe(0);
    expect(scoreClusterMergeBm25Pair(buildClusterMergeBm25Index([]), "a", "b")).toBe(0);
  });

  it("uses summary and event subject/object as part of the searchable document", () => {
    const index = buildClusterMergeBm25Index([
      { ...doc("a", "标题甲"), summary: "稀有摘要词", eventSubject: "主体实体", eventObject: "目标产品" },
      { ...doc("b", "标题乙"), summary: "稀有摘要词", eventSubject: "主体实体", eventObject: "目标产品" },
      doc("c", "无关新闻内容"),
    ]);

    expect(scoreClusterMergeBm25Pair(index, "a", "b")).toBeGreaterThan(0);
  });

  it("normalizes for document length", () => {
    const index = buildClusterMergeBm25Index([
      doc("short-a", "shared term"),
      doc("short-b", "shared term"),
      doc("long-b", "shared term extra one two three four five six"),
      doc("other", "unrelated corpus document"),
    ]);

    expect(scoreClusterMergeBm25Pair(index, "short-a", "short-b")).toBeGreaterThan(
      scoreClusterMergeBm25Pair(index, "short-a", "long-b"),
    );
  });

  it("ranks item-assignment sparse candidates by BM25 and omits zero-overlap matches", () => {
    const publishedAt = new Date("2026-04-20T10:00:00.000Z");
    const item = {
      id: "assignment-item",
      originalTitle: "Acme Labs launches Neptune developer platform",
      translatedTitle: "Acme Labs launches Neptune developer platform",
      summaryText: "Acme Labs announces Neptune for developers.",
      rssExcerpt: null,
      fullText: null,
      rssContent: null,
      publishedAt,
      publishedAtKnown: true,
      createdAt: publishedAt,
      source: { name: "test" },
    } as unknown as ItemWithSource;
    const eventSignature: AiEventSignature = {
      eventType: "launch",
      eventSubject: "Acme Labs",
      eventAction: "launches",
      eventObject: "Neptune",
      eventDate: "2026-04-20",
    };
    const candidate = (
      id: string,
      title: string,
      summary: string,
      eventFields: Partial<ClusterAssignmentCandidate> = {},
    ): ClusterAssignmentCandidate => ({
      id,
      title,
      summary,
      fingerprint: id,
      eventFingerprint: null,
      eventBucket: null,
      eventType: "launch",
      eventSubject: "Acme Labs",
      eventAction: "launches",
      eventObject: "Neptune",
      eventDate: "2026-04-20",
      latestPublishedAt: publishedAt,
      itemCount: 1,
      ...eventFields,
    });

    const noEventFields = {
      eventType: null,
      eventSubject: null,
      eventAction: null,
      eventObject: null,
      eventDate: null,
    };
    const ranked = rankItemAssignmentCandidatesWithBm25(item, eventSignature, [
      candidate("less-overlap", "Acme Labs launch", "Acme Labs reports a launch."),
      candidate("best-overlap", "Acme Labs launches Neptune developer platform", "Acme Labs announces Neptune for developers."),
      candidate("object-conflict", "Acme Labs launches Mars probe", "Acme Labs announces a Mars probe.", {
        eventObject: "Mars",
      }),
      candidate("date-mismatch", "Acme Labs launches Neptune platform", "Acme Labs announces Neptune.", {
        eventDate: "2026-03-20",
      }),
      candidate("zero-overlap-z", "Unrelated astronomy report", "A distant star was observed.", noEventFields),
      candidate("zero-overlap-a", "Unrelated ocean report", "A deep ocean was observed.", noEventFields),
    ]);

    expect(ranked.eligibleCandidates.map((entry) => entry.candidate.id)).toEqual([
      "best-overlap",
      "less-overlap",
      "zero-overlap-a",
      "zero-overlap-z",
    ]);
    expect(ranked.sparseCandidates.map((entry) => entry.candidate.id)).toEqual([
      "best-overlap",
      "less-overlap",
    ]);
    expect(ranked.eligibleCandidates.slice(-2).map((entry) => entry.score)).toEqual([0, 0]);
  });
});
