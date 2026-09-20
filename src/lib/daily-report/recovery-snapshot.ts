

import { getDailyReportSectionBlocks } from "@/lib/daily-report/content";
import { type RecentDailyReportSourceSnapshot } from "@/lib/daily-report/repository";
import { type DailyReportCandidate, type DailyReportCandidateSnapshotEntry, type DailyReportCandidateAssessment, type DailyReportAssessDuplicateSnapshotEntry, type DailyReportPlan, type DailyReportContent, type RecentDailyReportTopic } from "@/lib/daily-report/types";
import { buildDailyReportCandidateBriefs } from "@/lib/daily-report/planning";
import { normalizeDailyReportTemplateConfig } from "@/lib/daily-report/template";
import { matchesRecentDailyReportSource } from "@/lib/daily-report/recent-duplicates";
import { DAILY_REPORT_RECENT_TOPIC_CONTEXT_LIMIT } from "@/lib/daily-report/report-input";
import { normalizeDailyReportComparableText } from "@/lib/daily-report/recent-duplicates";


export function toCandidateSnapshotEntry(candidate: DailyReportCandidate): DailyReportCandidateSnapshotEntry {
  return {
    id: candidate.id,
    sourceKey: candidate.sourceKey,
    itemId: candidate.itemId,
    clusterId: candidate.clusterId,
    title: candidate.title,
    itemTitle: candidate.itemTitle,
    sourceName: candidate.sourceName,
    url: candidate.url,
    candidateScore: candidate.candidateScore,
    sourceCount: candidate.sourceCount,
    itemCount: candidate.itemCount,
    eventType: candidate.eventType,
    eventSubject: candidate.eventSubject,
    eventAction: candidate.eventAction,
    eventObject: candidate.eventObject,
    eventDate: candidate.eventDate,
    publishedAtKnown: candidate.publishedAtKnown ?? true,
    isFollowUp: candidate.isFollowUp ?? false,
    newItemCountOnDate: candidate.newItemCountOnDate ?? 0,
    newSourceCountOnDate: candidate.newSourceCountOnDate ?? 0,
  };
}

export function parseDailyReportCandidateSnapshot(value: unknown): DailyReportCandidateSnapshotEntry[] {
  const candidates = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { candidates?: unknown }).candidates
    : value;
  if (!Array.isArray(candidates)) return [];

  return candidates.filter((candidate): candidate is DailyReportCandidateSnapshotEntry => {
    if (!candidate || typeof candidate !== "object") return false;
    const entry = candidate as Partial<DailyReportCandidateSnapshotEntry>;
    return Number.isInteger(entry.id)
      && typeof entry.sourceKey === "string"
      && typeof entry.title === "string"
      && typeof entry.sourceName === "string"
      && typeof entry.url === "string"
      && typeof entry.candidateScore === "number"
      && typeof entry.sourceCount === "number"
      && typeof entry.itemCount === "number";
  });
}

export function buildDailyReportRecoveryPlan(
  content: DailyReportContent,
  template: ReturnType<typeof normalizeDailyReportTemplateConfig>,
): DailyReportPlan {
  let fallbackTopicSequence = 0;
  const templateSections = template.blocks.filter((block) => block.type === "section");
  return {
    schemaVersion: 2,
    sections: getDailyReportSectionBlocks(content).map((section) => {
      const templateSection = templateSections.find((block) => (
        (section.blockKey && block.key === section.blockKey) || block.title === section.title
      ));
      return {
        blockKey: templateSection?.key ?? section.blockKey ?? section.title,
        topics: section.items.map((item) => ({
          topicId: item.topicId ?? `recovery-topic-${++fallbackTopicSequence}`,
          candidateIds: [...item.sourceIds],
        })),
      };
    }),
  };
}

export function buildDailyReportRecoveryCandidates(input: {
  snapshot: DailyReportCandidateSnapshotEntry[];
  planningCandidateBriefs: Awaited<ReturnType<typeof buildDailyReportCandidateBriefs>>;
  currentCandidates: DailyReportCandidate[];
  persistedSources: Array<{
    sourceNumber: number | null;
    sourceKey: string | null;
    itemId: string | null;
    clusterId: string | null;
    sourceName: string;
    title: string;
    url: string;
    sourceSummary: string | null;
    sourcePublishedAt: Date | null;
    sourceQualityScore: number | null;
    eventType: string | null;
    eventSubject: string | null;
    eventAction: string | null;
    eventObject: string | null;
    eventDate: string | null;
  }>,
}) {
  const currentById = new Map(input.currentCandidates.map((candidate) => [candidate.id, candidate]));
  const currentBySourceKey = new Map(input.currentCandidates.map((candidate) => [candidate.sourceKey, candidate]));
  const briefById = new Map(input.planningCandidateBriefs.map((brief) => [brief.candidateId, brief]));
  const sourceByNumber = new Map<number, (typeof input.persistedSources)[number]>();
  for (const source of input.persistedSources) {
    if (source.sourceNumber !== null && !sourceByNumber.has(source.sourceNumber)) {
      sourceByNumber.set(source.sourceNumber, source);
    }
  }

  return input.snapshot.map((entry) => {
    const source = sourceByNumber.get(entry.id);
    const brief = briefById.get(entry.id);
    const current = currentBySourceKey.get(entry.sourceKey) ?? currentById.get(entry.id);
    const publishedAt = source?.sourcePublishedAt?.toISOString() ?? brief?.publishedAt ?? current?.publishedAt ?? "";
    return {
      id: entry.id,
      sourceKey: source?.sourceKey ?? entry.sourceKey,
      itemId: source?.itemId ?? entry.itemId ?? current?.itemId ?? "",
      clusterId: source?.clusterId ?? entry.clusterId ?? current?.clusterId ?? null,
      title: source?.title ?? entry.title,
      itemTitle: entry.itemTitle ?? current?.itemTitle ?? source?.title ?? entry.title,
      sourceName: source?.sourceName ?? entry.sourceName,
      url: source?.url ?? entry.url,
      summary: source?.sourceSummary ?? current?.summary ?? brief?.summaryExcerpt ?? "",
      qualityScore: source?.sourceQualityScore ?? brief?.qualityScore ?? current?.qualityScore ?? 0,
      candidateScore: entry.candidateScore,
      sourceCount: entry.sourceCount,
      itemCount: entry.itemCount,
      createdAt: current?.createdAt ?? publishedAt,
      publishedAt,
      publishedAtKnown: entry.publishedAtKnown,
      eventType: source?.eventType ?? entry.eventType ?? current?.eventType ?? brief?.eventType ?? null,
      eventSubject: source?.eventSubject ?? entry.eventSubject ?? current?.eventSubject ?? brief?.eventSubject ?? null,
      eventAction: source?.eventAction ?? entry.eventAction ?? current?.eventAction ?? brief?.eventAction ?? null,
      eventObject: source?.eventObject ?? entry.eventObject ?? current?.eventObject ?? brief?.eventObject ?? null,
      eventDate: source?.eventDate ?? entry.eventDate ?? current?.eventDate ?? brief?.eventDate ?? null,
      isFollowUp: entry.isFollowUp ?? current?.isFollowUp ?? brief?.isFollowUp ?? false,
      newItemCountOnDate: entry.newItemCountOnDate ?? current?.newItemCountOnDate ?? brief?.newItemCountOnDate ?? 0,
      newSourceCountOnDate: entry.newSourceCountOnDate ?? current?.newSourceCountOnDate ?? brief?.newSourceCountOnDate ?? 0,
      evidenceItems: current?.evidenceItems ?? [],
    } satisfies DailyReportCandidate;
  });
}

export function buildDailyReportExcludedRecentDuplicateSnapshots(
  candidates: DailyReportCandidate[],
  recentSources: RecentDailyReportSourceSnapshot[],
) {
  return candidates.flatMap((candidate) => {
    const matchedRecentSource = recentSources.find((recentSource) => matchesRecentDailyReportSource(candidate, recentSource));
    if (!matchedRecentSource) {
      return [];
    }

    return [{
      ...toCandidateSnapshotEntry(candidate),
      excludedReason: "近 7 天日报已覆盖相同或高度相似事件",
      matchedRecentDate: matchedRecentSource.date,
      matchedRecentTitle: matchedRecentSource.topic ?? matchedRecentSource.title,
    }];
  });
}

export function buildDailyReportExcludedAssessDuplicateSnapshots(
  candidates: DailyReportCandidate[],
  assessments: DailyReportCandidateAssessment[],
): DailyReportAssessDuplicateSnapshotEntry[] {
  const assessmentById = new Map(
    assessments
      .filter((assessment) => assessment.historyDecision === "duplicate")
      .map((assessment) => [assessment.candidateId, assessment]),
  );

  return candidates.flatMap((candidate) => {
    const assessment = assessmentById.get(candidate.id);
    if (!assessment) {
      return [];
    }

    return [{
      ...toCandidateSnapshotEntry(candidate),
      relevanceScore: assessment.relevanceScore,
      suggestedBlockKey: assessment.suggestedBlockKey,
      historyDecision: "duplicate" as const,
      matchedRecentTopicTitle: assessment.matchedRecentTopicTitle,
      excludedReason: "ASSESS 判定为历史重复",
    }];
  });
}

export function buildRecentDailyReportTopics(recentSources: RecentDailyReportSourceSnapshot[]): RecentDailyReportTopic[] {
  const topics = new Map<string, RecentDailyReportTopic>();

  for (const source of recentSources) {
    const key = [
      source.date,
      source.sourceNumber ?? "",
      source.sectionName ?? "",
      source.topic ?? source.title,
      normalizeDailyReportComparableText(source.eventSubject) ?? "",
      normalizeDailyReportComparableText(source.eventObject) ?? "",
    ].join("\u0000");

    if (topics.has(key)) {
      continue;
    }

    topics.set(key, {
      date: source.date,
      sourceNumber: source.sourceNumber,
      sectionName: source.sectionName,
      topic: source.topic,
      title: source.title,
      eventType: source.eventType,
      eventSubject: source.eventSubject,
      eventAction: source.eventAction,
      eventObject: source.eventObject,
      eventDate: source.eventDate,
    });

    if (topics.size >= DAILY_REPORT_RECENT_TOPIC_CONTEXT_LIMIT) {
      break;
    }
  }

  return Array.from(topics.values());
}

