import { expect, it } from "vitest";
import { buildDailyReportRecoveryCandidates } from "@/lib/daily-report/recovery-snapshot";
import type { DailyReportCandidate, DailyReportCandidateSnapshotEntry, DailyReportPlanningCandidateBrief } from "@/lib/daily-report/types";

it("does not pull changed current article data into published report recovery", () => {
  const snapshot: DailyReportCandidateSnapshotEntry = { id: 1, sourceKey: "item:1", itemId: "1", clusterId: null, title: "原题", itemTitle: "原题", sourceName: "原来源", url: "https://example.com/old", candidateScore: 90, sourceCount: 1, itemCount: 1, eventType: null, eventSubject: null, eventAction: null, eventObject: null, eventDate: null };
  const brief: DailyReportPlanningCandidateBrief = { candidateId: 1, title: "原题", summaryExcerpt: "原摘要", candidateScore: 90, relevanceScore: 90, sourceCount: 1, itemCount: 1, publishedAt: "2026-01-01T00:00:00Z" };
  const current: DailyReportCandidate = { ...snapshot, summary: "新摘要", title: "新题", itemTitle: "新题", qualityScore: 99, createdAt: "2026-10-01T00:00:00Z", publishedAt: "2026-10-01T00:00:00Z", evidenceItems: [{ title: "新证据", sourceName: "新来源", summary: "新摘要", url: "https://example.com/new", createdAt: "2026-10-01T00:00:00Z", publishedAt: "2026-10-01T00:00:00Z", qualityScore: 99 }] };
  const [result] = buildDailyReportRecoveryCandidates({ snapshot: [snapshot], planningCandidateBriefs: [brief], currentCandidates: [current], persistedSources: [], allowCurrentFallback: false });
  expect(result.title).toBe("原题");
  expect(result.summary).toBe("原摘要");
  expect(result.publishedAt).toBe("2026-01-01T00:00:00Z");
  expect(result.evidenceItems).toEqual([]);
});
