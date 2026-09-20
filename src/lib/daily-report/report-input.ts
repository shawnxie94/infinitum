import { createHash } from "node:crypto";


import type { RuntimeConfig } from "@/config/runtime";
import { getAiTaskContract } from "@/lib/ai/contracts";
import { getDailyReportSectionBlocks } from "@/lib/daily-report/content";
import { formatDailyReportTitle, normalizeDailyReportHeadline } from "@/lib/daily-report/title";
import { type DailyReportCandidate, type DailyReportContent, type DailyReportItem, type RecentDailyReportTopic } from "@/lib/daily-report/types";


export const MIN_CANDIDATE_COUNT = 2;
export const DAILY_REPORT_RECENT_TOPIC_CONTEXT_LIMIT = 120;
export const MAX_DAILY_REPORT_EXPANDED_SOURCES_PER_CANDIDATE = 5;
export const MAX_DAILY_REPORT_EVIDENCE_ITEMS_PER_CANDIDATE = 3;
export const DISPLAYABLE_DAILY_REPORT_SOURCE_STATUSES = ["allowed", "restored"] as const;
export const DAILY_REPORT_REVIEW_TOP_UNSELECTED_CANDIDATE_LIMIT = 20;
export const DAILY_REPORT_PIPELINE_VERSION = "daily-report-topic-first-review-v1";

export function getFallbackDailyReportHeadline(content: DailyReportContent) {
  const sectionTitles = getDailyReportSectionBlocks(content)
    .flatMap((section) => section.items.map((item) => item.title))
    .map((title) => normalizeDailyReportHeadline(title))
    .filter(Boolean);
  return normalizeDailyReportHeadline(sectionTitles.slice(0, 3).join("、"));
}

export function buildDailyReportTitle(date: string, content?: DailyReportContent) {
  const headline = content
    ? normalizeDailyReportHeadline(content.headline) || getFallbackDailyReportHeadline(content)
    : "";
  return formatDailyReportTitle(date, headline);
}

export function buildInputHash(
  date: string,
  candidates: DailyReportCandidate[],
  channelIds: string[] = [],
  recentTopics: RecentDailyReportTopic[] = [],
  generationSignature = "legacy",
) {
  const hash = createHash("sha256");
  hash.update(date);
  hash.update(JSON.stringify([...channelIds].sort()));
  hash.update(JSON.stringify(recentTopics));
  hash.update(generationSignature);
  for (const candidate of candidates) {
    hash.update(JSON.stringify({
      sourceKey: candidate.sourceKey,
      itemId: candidate.itemId,
      clusterId: candidate.clusterId,
      title: candidate.title,
      summary: candidate.summary,
      qualityScore: candidate.qualityScore,
      candidateScore: candidate.candidateScore,
      sourceCount: candidate.sourceCount,
      itemCount: candidate.itemCount,
      isFollowUp: candidate.isFollowUp ?? false,
      newItemCountOnDate: candidate.newItemCountOnDate ?? 0,
      newSourceCountOnDate: candidate.newSourceCountOnDate ?? 0,
      evidenceItems: candidate.evidenceItems ?? [],
    }));
  }
  return hash.digest("hex");
}

export function buildDailyReportGenerationSignature(input: {
  runtimeConfig: RuntimeConfig;
  templateSignature: string;
  planningBatchSize: number | null;
  recentTopicLookbackDays: number;
}) {
  const prompt = input.runtimeConfig.selectedPromptConfigs?.dailyReport;
  const modelApi = prompt?.modelApi ?? input.runtimeConfig.modelApi;
  const reviewPrompt = input.runtimeConfig.selectedPromptConfigs?.dailyReportReview;
  const reviewModelApi = reviewPrompt?.modelApi ?? input.runtimeConfig.modelApi;
  return createHash("sha256")
    .update(JSON.stringify({
      pipelineVersion: DAILY_REPORT_PIPELINE_VERSION,
      templateSignature: input.templateSignature,
      planningBatchSize: input.planningBatchSize,
      recentTopicLookbackDays: input.recentTopicLookbackDays,
      modelApi: {
        baseURL: modelApi.baseURL,
        model: modelApi.model,
        apiKeyConfigured: Boolean(modelApi.apiKey),
        customHeaderNames: Object.keys(modelApi.customHeaders ?? {}).sort(),
      },
      prompt: prompt
        ? {
            userPrompt: prompt.userPrompt,
            contractVersion: getAiTaskContract("daily_report").contractVersion,
            contractHash: getAiTaskContract("daily_report").contractHash,
            temperature: prompt.temperature ?? null,
            maxTokens: prompt.maxTokens ?? null,
            topP: prompt.topP ?? null,
          }
        : null,
      review: reviewPrompt
        ? {
            enabled: reviewPrompt.enabled,
            modelApi: {
              baseURL: reviewModelApi.baseURL,
              model: reviewModelApi.model,
              apiKeyConfigured: Boolean(reviewModelApi.apiKey),
              customHeaderNames: Object.keys(reviewModelApi.customHeaders ?? {}).sort(),
            },
            userPrompt: reviewPrompt.userPrompt,
            contractVersion: getAiTaskContract("daily_report_review").contractVersion,
            contractHash: getAiTaskContract("daily_report_review").contractHash,
            temperature: reviewPrompt.temperature ?? null,
            maxTokens: reviewPrompt.maxTokens ?? null,
            topP: reviewPrompt.topP ?? null,
          }
        : { enabled: false },
    }))
    .digest("hex");
}

export function getSectionSourceIds(content: DailyReportContent) {
  const rows: Array<{ sectionName: string; topic: string; sourceId: number }> = [];

  for (const section of getDailyReportSectionBlocks(content)) {
    for (const item of section.items as DailyReportItem[]) {
      for (const sourceId of item.sourceIds) {
        rows.push({ sectionName: section.title, topic: item.title, sourceId });
      }
    }
  }

  return rows;
}
