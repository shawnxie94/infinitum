import { DEFAULT_BLACKLIST_KEYWORDS } from "@/config/blacklist";
import {
  DEFAULT_CLUSTER_MATCH_PROMPT,
  DEFAULT_CLUSTER_MERGE_PROMPT,
  DEFAULT_CLUSTER_SUMMARY_PROMPT,
  DEFAULT_DAILY_REPORT_PROMPT,
  DEFAULT_ITEM_UNDERSTANDING_PROMPT,
} from "@/config/prompts";
import { DEFAULT_SOURCE_CONFIGS } from "@/config/sources";
import type { SourceConfig } from "@/lib/feed/types";
import {
  DEFAULT_FULL_TEXT_FETCH_THRESHOLD,
  DEFAULT_AGGREGATION_SPLIT_MAX_EVENTS,
  DEFAULT_PER_SOURCE_ITEM_LIMIT,
} from "@/lib/tasks/scheduler";

export type RuntimeConfig = {
  rssSources: SourceConfig[];
  blacklistKeywords: string[];
  ingestion: {
    itemConcurrency: number;
    sourceConcurrency: number;
    fullTextFetchThreshold: number;
    perSourceItemLimit: number;
    aggregationSplitMaxEvents: number;
    processingStartAt: Date | null;
  };
  contentExtraction: {
    jinaEnabled: boolean;
    jinaBaseUrl: string;
    jinaApiKey: string | null;
    timeoutMs: number;
    concurrency: number;
    rpmLimit: number;
    maxPerRun: number;
    minChars: number;
    maxChars: number;
  };
  modelApi: {
    apiKey: string;
    baseURL: string;
    model: string;
    customHeaders?: Record<string, string>;
  };
  prompts: {
    itemUnderstanding: string;
    clusterSummary: string;
    clusterMatch: string;
    clusterMerge: string;
    dailyReport: string;
  };
  selectedPromptConfigs?: {
    itemUnderstanding: {
      name: string;
      systemPrompt: string;
      promptTemplate: string;
      temperature?: number | null;
      maxTokens?: number | null;
      topP?: number | null;
      modelApi?: RuntimeConfig["modelApi"] | null;
    };
    clusterSummary: {
      name: string;
      systemPrompt: string;
      promptTemplate: string;
      temperature?: number | null;
      maxTokens?: number | null;
      topP?: number | null;
      modelApi?: RuntimeConfig["modelApi"] | null;
    };
    clusterMatch: {
      name: string;
      systemPrompt: string;
      promptTemplate: string;
      temperature?: number | null;
      maxTokens?: number | null;
      topP?: number | null;
      modelApi?: RuntimeConfig["modelApi"] | null;
    };
    clusterMerge: {
      name: string;
      systemPrompt: string;
      promptTemplate: string;
      temperature?: number | null;
      maxTokens?: number | null;
      topP?: number | null;
      modelApi?: RuntimeConfig["modelApi"] | null;
    };
    dailyReport: {
      name: string;
      systemPrompt: string;
      promptTemplate: string;
      temperature?: number | null;
      maxTokens?: number | null;
      topP?: number | null;
      modelApi?: RuntimeConfig["modelApi"] | null;
    };
  };
};

export function getRuntimeConfig(): RuntimeConfig {
  return {
    rssSources: DEFAULT_SOURCE_CONFIGS.map((source) => ({ ...source })),
    blacklistKeywords: [...DEFAULT_BLACKLIST_KEYWORDS],
    ingestion: {
      itemConcurrency: 3,
      sourceConcurrency: 2,
      fullTextFetchThreshold: DEFAULT_FULL_TEXT_FETCH_THRESHOLD,
      perSourceItemLimit: DEFAULT_PER_SOURCE_ITEM_LIMIT,
      aggregationSplitMaxEvents: DEFAULT_AGGREGATION_SPLIT_MAX_EVENTS,
      processingStartAt: null,
    },
    contentExtraction: {
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
    modelApi: {
      apiKey: "",
      baseURL: "",
      model: "gpt-4.1-mini",
      customHeaders: {},
    },
    prompts: {
      itemUnderstanding: DEFAULT_ITEM_UNDERSTANDING_PROMPT,
      clusterSummary: DEFAULT_CLUSTER_SUMMARY_PROMPT,
      clusterMatch: DEFAULT_CLUSTER_MATCH_PROMPT,
      clusterMerge: DEFAULT_CLUSTER_MERGE_PROMPT,
      dailyReport: DEFAULT_DAILY_REPORT_PROMPT,
    },
  };
}
