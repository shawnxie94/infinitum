import { vi } from "vitest";

import type { AiProvider } from "@/lib/ai/provider";

export function buildEventSignature(
  overrides: Partial<{
    eventType: "release" | "launch" | "update" | "funding" | "acquisition" | "partnership" | "policy" | "research" | "security" | "other" | null;
    eventSubject: string | null;
    eventAction: string | null;
    eventObject: string | null;
    eventDate: string | null;
  }> = {},
) {
  return {
    eventType: null,
    eventSubject: null,
    eventAction: null,
    eventObject: null,
    eventDate: null,
    ...overrides,
  };
}

export function buildAiProviderMock(
  overrides?: Partial<{
    understandItem: ReturnType<typeof vi.fn>;
    summaryFixture: ReturnType<typeof vi.fn>;
    aggregationFixture: ReturnType<typeof vi.fn>;
    analysisFixture: ReturnType<typeof vi.fn>;
    summarizeCluster: ReturnType<typeof vi.fn>;
    matchClusterCandidate: ReturnType<typeof vi.fn>;
    assessClusterMergePairs: ReturnType<typeof vi.fn>;
    assessDailyReportCandidates: ReturnType<typeof vi.fn>;
    planDailyReport: ReturnType<typeof vi.fn>;
    writeDailyReport: ReturnType<typeof vi.fn>;
    repairDailyReportDraft: ReturnType<typeof vi.fn>;
  }>,
): AiProvider {
  const summaryFixture = overrides?.summaryFixture ?? vi.fn().mockResolvedValue({ summary: "默认条目摘要", isAggregation: false });
  const aggregationFixture = overrides?.aggregationFixture ?? vi.fn().mockResolvedValue({ mainEvent: null, events: [] });
  const analysisFixture = overrides?.analysisFixture ?? vi.fn().mockResolvedValue({
    translatedTitle: "默认中文标题",
    moderationStatus: "allowed",
    moderationReason: null,
    moderationDetail: null,
    qualityScore: 80,
    qualityRationale: "高质量",
    eventSignature: buildEventSignature(),
  });
  const callSummary = summaryFixture as unknown as (
    inputText: string,
    metadata: { title: string; sourceName?: string; translateTitle: boolean },
  ) => Promise<{ summary: string; isAggregation: boolean }>;
  const callAnalysis = analysisFixture as unknown as (
    inputText: string,
    metadata: { title: string; sourceName?: string; translateTitle: boolean },
  ) => Promise<{
    translatedTitle: string | null;
    moderationStatus: "allowed" | "filtered" | "restored";
    moderationReason: "marketing" | "low_quality" | "duplicate_noise" | "rule_filter" | "rule_blacklist" | "other" | null;
    moderationDetail: string | null;
    qualityScore: number;
    qualityRationale: string;
    eventSignature: ReturnType<typeof buildEventSignature>;
  }>;
  const callAggregation = aggregationFixture as unknown as (
    inputText: string,
    metadata: { title: string; sourceName?: string; translateTitle: boolean },
  ) => Promise<{ mainEvent: ReturnType<typeof buildEventSignature> | null; events: Array<Record<string, unknown>> }>;
  const base = {
    understandItem: overrides?.understandItem ?? vi.fn().mockImplementation(
      async (inputText: string, metadata: { title: string; sourceName?: string; translateTitle: boolean }) => {
        const [summary, analysis] = await Promise.all([
          callSummary(inputText, metadata),
          callAnalysis(inputText, metadata),
        ]);
        let aggregation: {
          isAggregation: boolean;
          mainEvent: ReturnType<typeof buildEventSignature> | null;
          events: Array<Record<string, unknown>>;
        } = { isAggregation: false, mainEvent: null, events: [] };
        let aggregationValid = true;
        if (summary.isAggregation || overrides?.aggregationFixture) {
          try {
            const parsed = await callAggregation(inputText, metadata);
            aggregation = {
              isAggregation: parsed.events.length > 0,
              mainEvent: parsed.mainEvent,
              events: parsed.events,
            };
            aggregationValid = summary.isAggregation ? parsed.events.length > 0 : true;
          } catch {
            aggregationValid = false;
          }
        }
        return {
          ...analysis,
          summary: summary.summary,
          aggregation,
          diagnostics: {
            summaryValid: true,
            analysisValid: true,
            aggregationValid,
          },
        };
      },
    ),
    summarizeCluster: vi.fn().mockResolvedValue(JSON.stringify({ title: "默认聚合标题", summary: "默认聚合摘要" })),
    matchClusterCandidate: vi.fn().mockResolvedValue(null),
    assessClusterMergePairs: vi.fn().mockResolvedValue([]),
    assessDailyReportCandidates: vi.fn().mockResolvedValue([]),
    planDailyReport: vi.fn().mockResolvedValue({ schemaVersion: 2, sections: [] }),
    writeDailyReport: vi.fn().mockResolvedValue({ blocks: [] }),
    repairDailyReportDraft: vi.fn().mockResolvedValue({ blocks: [] }),
  };

  return {
    ...base,
    ...(overrides as unknown as Pick<AiProvider, "understandItem" | "summarizeCluster" | "matchClusterCandidate">),
  } as unknown as AiProvider;
}
