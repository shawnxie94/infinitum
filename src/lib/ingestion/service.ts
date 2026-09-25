import crypto from "node:crypto";

import type { Item, Source } from "@prisma/client";
import type { RuntimeConfig } from "@/config/runtime";
import { createAiProvider } from "@/lib/ai/provider-next";
import { prisma } from "@/lib/db";
import { createConfiguredArticleFetcher, fetchArticleContent } from "@/lib/ingestion/article";
import { deriveSourceConcurrency, type PreparedFeedItemLookup } from "@/lib/ingestion/item-processor";
import { createRssParser } from "@/lib/ingestion/parser";
import { createIngestionTimelineModelNames, type IngestionTimelineModelNames } from "@/lib/ingestion/task-timeline";
import type { ProcessedItemRecord, RunIngestionOptions } from "@/lib/ingestion/types";
import { getIngestionRuntimeConfig } from "@/lib/settings/service";
import { DEFAULT_FULL_TEXT_FETCH_THRESHOLD } from "@/lib/tasks/scheduler";
import { DEFAULT_INGESTION_TASK_LABEL } from "@/lib/tasks/types";
import { enqueueTaskRun } from "@/lib/tasks/service";
import { createTaskAiUsageTracker } from "@/lib/tasks/ai-usage";

export const DEFAULT_MAX_FEED_ITEMS_TO_SCAN = 500;

export type ResolvedRunOptions = RunIngestionOptions & {
  now: Date;
  taskTimelineModelNames: IngestionTimelineModelNames;
  aiUsage: ReturnType<typeof createTaskAiUsageTracker>;
};

type RuntimePromptConfigs = NonNullable<RuntimeConfig["selectedPromptConfigs"]>;
type RuntimePromptConfig =
  | RuntimePromptConfigs["itemUnderstanding"]
  | RuntimePromptConfigs["clusterSummary"]
  | RuntimePromptConfigs["clusterMatch"]
  | RuntimePromptConfigs["clusterMerge"];

function resolvePromptModelName(
  promptConfig: RuntimePromptConfig | undefined,
  defaultModelName: string | null,
): string | null {
  return promptConfig?.modelApi?.model ?? defaultModelName;
}


export async function resolveRunOptions(options?: Partial<RunIngestionOptions>): Promise<ResolvedRunOptions> {
  const now = options?.now ?? new Date();
  const aiUsage = createTaskAiUsageTracker();
  const runtimeConfig =
    !options?.aiProvider || !options?.sourceConfigs || !options?.blacklist ? await getIngestionRuntimeConfig() : null;
  const defaultModelName = runtimeConfig?.modelApi.model ?? null;

  return {
    trigger: options?.trigger ?? "manual",
    parser: options?.parser ?? createRssParser(),
    articleFetcher:
      options?.articleFetcher ??
      createConfiguredArticleFetcher(runtimeConfig?.contentExtraction ?? {
        jinaEnabled: false,
        jinaBaseUrl: "https://r.jina.ai/",
        jinaApiKey: null,
        timeoutMs: 15_000,
        concurrency: 1,
        rpmLimit: 10,
        maxPerRun: 20,
        minChars: 500,
        maxChars: 32_000,
      }, fetchArticleContent),
    aiProvider:
      options?.aiProvider ??
      createAiProvider(
        runtimeConfig?.modelApi ?? { apiKey: "", baseURL: "", model: "gpt-4.1-mini", customHeaders: {} },
        runtimeConfig?.selectedPromptConfigs
          ? {
              itemUnderstanding: runtimeConfig.selectedPromptConfigs.itemUnderstanding,
              clusterSummary: runtimeConfig.selectedPromptConfigs.clusterSummary,
              clusterMatch: runtimeConfig.selectedPromptConfigs.clusterMatch,
              clusterMerge: runtimeConfig.selectedPromptConfigs.clusterMerge,
          }
          : undefined,
        undefined,
        {
          aggregationSplitMaxEvents: runtimeConfig?.ingestion.aggregationSplitMaxEvents,
          embedding: runtimeConfig?.embedding ?? null,
          onUsage: (usage, usageKey) => aiUsage.addUsageByKey(usageKey, usage),
        },
      ),
    sourceConfigs: options?.sourceConfigs ?? runtimeConfig?.rssSources ?? [],
    blacklist: options?.blacklist ?? runtimeConfig?.blacklistKeywords ?? [],
    itemConcurrency: options?.itemConcurrency ?? runtimeConfig?.ingestion.itemConcurrency ?? 3,
    sourceConcurrency:
      options?.sourceConcurrency ??
      runtimeConfig?.ingestion.sourceConcurrency ??
      deriveSourceConcurrency(options?.itemConcurrency ?? runtimeConfig?.ingestion.itemConcurrency ?? 3),
    fullTextFetchThreshold:
      options?.fullTextFetchThreshold ??
      runtimeConfig?.ingestion.fullTextFetchThreshold ??
      DEFAULT_FULL_TEXT_FETCH_THRESHOLD,
    contentExtraction:
      options?.contentExtraction ??
      runtimeConfig?.contentExtraction ?? {
        jinaEnabled: false,
        jinaBaseUrl: "https://r.jina.ai/",
        jinaApiKey: null,
        timeoutMs: 15_000,
        concurrency: 1,
        rpmLimit: 10,
        maxPerRun: 20,
        minChars: 500,
        maxChars: 32_000,
      },
    perSourceItemLimit:
      options?.perSourceItemLimit ?? runtimeConfig?.ingestion.perSourceItemLimit ?? 20,
    maxFeedItemsToScan: options?.maxFeedItemsToScan ?? DEFAULT_MAX_FEED_ITEMS_TO_SCAN,
    processingStartAt:
      options?.processingStartAt ?? runtimeConfig?.ingestion.processingStartAt ?? null,
    now,
    signal: options?.signal,
    taskTimelineModelNames: runtimeConfig?.selectedPromptConfigs
      ? {
          itemUnderstanding: resolvePromptModelName(runtimeConfig.selectedPromptConfigs.itemUnderstanding, defaultModelName),
          clusterSummary: resolvePromptModelName(runtimeConfig.selectedPromptConfigs.clusterSummary, defaultModelName),
          clusterMatch: resolvePromptModelName(runtimeConfig.selectedPromptConfigs.clusterMatch, defaultModelName),
          clusterMerge: resolvePromptModelName(runtimeConfig.selectedPromptConfigs.clusterMerge, defaultModelName),
        }
      : createIngestionTimelineModelNames(),
    aiUsage,
  };
}

export async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  concurrency: number,
  options?: {
    shouldStop?: () => Promise<boolean>;
  },
) {
  let nextTaskIndex = 0;

  async function worker() {
    while (true) {
      if (await options?.shouldStop?.()) {
        return;
      }

      const currentIndex = nextTaskIndex;
      nextTaskIndex += 1;

      if (currentIndex >= tasks.length) {
        return;
      }

      await tasks[currentIndex]?.();
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

export function buildFeedRequestHeaders(source: Source): Record<string, string> {
  return {
    ...(source.feedEtag ? { "If-None-Match": source.feedEtag } : {}),
    ...(source.feedLastModified ? { "If-Modified-Since": source.feedLastModified } : {}),
  };
}

export function buildFeedContentHash(items: Array<{ title?: string | null; link?: string | null; isoDate?: string | null; pubDate?: string | null; content?: string | null; "content:encoded"?: string | null; contentSnippet?: string | null }>) {
  const payload = items.map((item) => ({
    title: item.title?.trim() ?? null,
    link: item.link?.trim() ?? null,
    isoDate: item.isoDate ?? null,
    pubDate: item.pubDate ?? null,
    content: item.content ?? null,
    contentEncoded: item["content:encoded"] ?? null,
    contentSnippet: item.contentSnippet ?? null,
  }));

  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function getExistingItemForLookup(
  lookup: PreparedFeedItemLookup | null,
  existingByUrlHash: Map<string, Item>,
) {
  if (!lookup) {
    return null;
  }

  return existingByUrlHash.get(lookup.dedupeKeys.urlHash) ?? null;
}

export function hasItemProcessingFailure(result: ProcessedItemRecord | null) {
  return Boolean(
    result?.metrics?.summaryFailed ||
    result?.metrics?.aggregationParseFailed ||
    result?.metrics?.analysisFailed,
  );
}

export function buildItemProcessingFailureMessage(result: ProcessedItemRecord) {
  return result.errorMessage
    ? `Item ${result.id}: ${result.errorMessage}`
    : `Item ${result.id}: AI processing failed`;
}

export function dedupePreparedLookupsByDedupeKey<T extends { lookup: PreparedFeedItemLookup | null }>(entries: T[]) {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (!entry.lookup) {
      deduped.unshift(entry);
      continue;
    }

    const dedupeKey = entry.lookup.dedupeKeys.urlHash;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    deduped.unshift(entry);
  }

  return deduped;
}

export function shouldEnqueueProcessingRecoveryFromIngestion(input: {
  summaryFailed: number;
  analysisFailed: number;
  aggregationParseFailed: number;
  skippedIncompleteSignature: number;
}) {
  return (
    input.summaryFailed > 0 ||
    input.analysisFailed > 0 ||
    input.aggregationParseFailed > 0 ||
    input.skippedIncompleteSignature > 0
  );
}

export async function startIngestionTask(input?: { triggerType?: "scheduled" | "manual" }) {
  const activeTaskCount = await prisma.backgroundTaskRun.count({
    where: {
      kind: "ingestion",
      status: {
        in: ["queued", "running"],
      },
    },
  });

  if (activeTaskCount > 0) {
    throw new Error("An ingestion run is already in progress.");
  }

  return enqueueTaskRun({
    kind: "ingestion",
    triggerType: input?.triggerType ?? "manual",
    label: DEFAULT_INGESTION_TASK_LABEL,
  });
}
