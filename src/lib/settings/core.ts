import { JSDOM } from "jsdom";
import { PromptConfigType } from "@prisma/client";

import {
  DEFAULT_CLUSTER_MERGE_PROMPT,
  DEFAULT_ITEM_UNDERSTANDING_PROMPT,
  LEGACY_DEFAULT_CLUSTER_MERGE_PROMPT,
  LEGACY_DEFAULT_ITEM_UNDERSTANDING_PROMPT,
  PREVIOUS_DEFAULT_CLUSTER_MERGE_PROMPT,
  PREVIOUS_DEFAULT_ITEM_UNDERSTANDING_PROMPT,
} from "@/config/prompts";
import { getRuntimeConfig } from "@/config/runtime";
import type { RuntimeConfig } from "@/config/runtime";
import { prisma } from "@/lib/db";
import {
  compileDailyReportTemplatePrompt,
  classifyDailyReportTemplateMigration,
  DEFAULT_DAILY_REPORT_TEMPLATE_JSON,
  parseDailyReportTemplateJson,
  stringifyDailyReportTemplate,
  upgradeDefaultDailyReportTemplate,
} from "@/lib/daily-report/template";
import type { SourceConfig } from "@/lib/feed/types";
import { getDefaultPromptConfigName, getDefaultPromptSampling, getDefaultPromptTemplate } from "@/lib/settings/ai-config";
import type {
  AdminModelApiConfig,
  AdminPromptConfig,
  PromptConfigType as PromptConfigTypeValue,
  ResolvedSourceMetadata,
} from "@/lib/settings/types";
import { normalizeKeyword, normalizeText, normalizeUrl } from "@/lib/utils/text";

export const DEFAULT_MODEL_CONFIG_NAME = "默认模型配置";
const LEGACY_DAILY_REPORT_PROMPT_MARKER = '"openingSummary":"...","sections":{"今日大事"';

export type SourceInput = SourceConfig & {
  groupId?: string | null;
};

export type SourceMetadataOptions = {
  parser?: {
    parseURL: (url: string) => Promise<{
      link?: string | null;
      title?: string | null;
      items?: Array<{
        content?: string | null;
        "content:encoded"?: string | null;
        contentSnippet?: string | null;
      }>;
    }>;
  };
};

export type ImportSourcesFromOpmlOptions = {
  parser?: SourceMetadataOptions["parser"];
  resolveMetadata?: (rssUrl: string) => Promise<ResolvedSourceMetadata>;
};

type ParsedOpmlSource = {
  name: string | null;
  rssUrl: string;
  siteUrl: string | null;
  groupName: string | null;
  enabled: boolean | null;
  aiParsingEnabled: boolean | null;
  aggregationEnabled: boolean | null;
  aggregationDetectionEnabled: boolean | null;
};

function parseOptionalBoolean(value: string | null): boolean | null {
  if (value === null) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "enabled"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "disabled"].includes(normalized)) {
    return false;
  }

  return null;
}

export type SaveModelApiConfigInput = {
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeyMode?: "replace" | "clear" | "keep";
  modelName: string;
  ingestionItemConcurrency: number;
  customHeaders?: Record<string, string>;
  isEnabled: boolean;
  isDefault: boolean;
};

export type FetchModelApiModelsInput = {
  baseUrl: string;
  apiKey?: string;
  configId?: string;
  apiKeyMode?: "replace" | "clear" | "keep";
  customHeaders?: Record<string, string>;
};

export type SavePromptConfigInput = {
  name: string;
  type: PromptConfigTypeValue;
  prompt: string;
  systemPrompt?: string | null;
  templateJson?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  modelApiConfigId?: string | null;
  isEnabled: boolean;
  isDefault: boolean;
};

export function toIsoString(value: Date): string {
  return value.toISOString();
}

export function buildSiteUrlFromRssUrl(rssUrl: string): string {
  const parsed = new URL(rssUrl);
  return new URL("/", parsed).toString();
}

export function getFallbackSourceName(rssUrl: string): string {
  return new URL(rssUrl).hostname;
}

function getOutlineLabel(node: Element): string | null {
  const label = normalizeText(node.getAttribute("title")) || normalizeText(node.getAttribute("text"));
  return label || null;
}

export function parseOpmlSources(opmlText: string): ParsedOpmlSource[] {
  const trimmed = opmlText.trim();

  if (!trimmed) {
    throw new Error("OPML content is empty.");
  }

  const dom = new JSDOM(trimmed, { contentType: "text/xml" });
  const parserError = dom.window.document.querySelector("parsererror");

  if (parserError) {
    throw new Error("Invalid OPML document.");
  }

  const outlines = Array.from(dom.window.document.querySelectorAll("body > outline"));
  const sources: ParsedOpmlSource[] = [];

  function walk(nodes: Element[], currentGroupName: string | null) {
    for (const node of nodes) {
      const rssUrl = normalizeUrl(node.getAttribute("xmlUrl"));
      const siteUrl = normalizeUrl(node.getAttribute("htmlUrl"));
      const name = getOutlineLabel(node);

      if (rssUrl) {
        sources.push({
          name,
          rssUrl,
          siteUrl,
          groupName: currentGroupName,
          enabled: parseOptionalBoolean(node.getAttribute("infinitum:enabled") ?? node.getAttribute("enabled")),
          aiParsingEnabled: parseOptionalBoolean(
            node.getAttribute("infinitum:aiParsingEnabled") ?? node.getAttribute("aiParsingEnabled"),
          ),
          aggregationEnabled: parseOptionalBoolean(
            node.getAttribute("infinitum:aggregationEnabled") ?? node.getAttribute("aggregationEnabled"),
          ),
          aggregationDetectionEnabled: parseOptionalBoolean(
            node.getAttribute("infinitum:aggregationDetectionEnabled") ?? node.getAttribute("aggregationDetectionEnabled"),
          ),
        });
        continue;
      }

      const nextGroupName = name ?? currentGroupName;
      const children = Array.from(node.children).filter((child): child is Element => child.tagName === "outline");
      walk(children, nextGroupName);
    }
  }

  walk(outlines, null);

  if (sources.length === 0) {
    throw new Error("No valid RSS subscriptions found in OPML.");
  }

  return sources;
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey) {
    return "";
  }

  return "•".repeat(Math.min(Math.max(apiKey.length, 8), 24));
}

export function toSourceConfig(source: {
  name: string;
  rssUrl: string;
  siteUrl: string;
  enabled: boolean;
  aiParsingEnabled: boolean;
  aggregationEnabled?: boolean;
  aggregationDetectionEnabled?: boolean;
}): SourceConfig {
  return {
    name: source.name,
    rssUrl: source.rssUrl,
    siteUrl: source.siteUrl,
    enabled: source.enabled,
    aiParsingEnabled: source.aiParsingEnabled,
    aggregationEnabled: source.aggregationEnabled,
    aggregationDetectionEnabled: source.aggregationDetectionEnabled,
  };
}

export function normalizeCustomHeaders(input?: Record<string, string> | null): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {})
      .map(([key, value]) => [normalizeText(key), value] as const)
      .filter(([key, value]) => key && typeof value === "string"),
  );
}

export function parseCustomHeaders(raw?: string | null): Record<string, string> {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return normalizeCustomHeaders(parsed as Record<string, string>);
    }
  } catch {
    // fall through
  }
  return {};
}

export function serializeAdminModelApiConfig(config: {
  id: string;
  name: string;
  baseUrl: string;
  modelName: string;
  ingestionItemConcurrency: number;
  customHeaders: string;
  apiKey: string;
  isEnabled: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AdminModelApiConfig {
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    ingestionItemConcurrency: config.ingestionItemConcurrency,
    customHeaders: parseCustomHeaders(config.customHeaders),
    apiKeyMasked: maskApiKey(config.apiKey),
    hasApiKey: Boolean(config.apiKey),
    isEnabled: config.isEnabled,
    isDefault: config.isDefault,
    createdAt: toIsoString(config.createdAt),
    updatedAt: toIsoString(config.updatedAt),
  };
}

export function serializeRuntimeModelApi(config: {
  apiKey: string;
  baseUrl: string;
  modelName: string;
  customHeaders?: string;
}): RuntimeConfig["modelApi"] {
  return {
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    model: config.modelName,
    customHeaders: parseCustomHeaders(config.customHeaders ?? ""),
  };
}

export function serializeAdminPromptConfig(
  config: {
    id: string;
    name: string;
    type: PromptConfigType;
    prompt: string;
    systemPrompt: string | null;
    templateJson: string | null;
    temperature: number | null;
    maxTokens: number | null;
    topP: number | null;
    modelApiConfigId: string | null;
    isEnabled: boolean;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
    modelApiConfig?: {
      name: string;
    } | null;
  },
  defaultModelConfig?: {
    id: string;
    name: string;
  } | null,
): AdminPromptConfig {
  const isUsingDefaultModel = config.modelApiConfigId === null;
  const effectiveModelConfigName = isUsingDefaultModel ? defaultModelConfig?.name : config.modelApiConfig?.name;

  return {
    id: config.id,
    name: config.name,
    type: config.type,
    prompt: config.prompt,
    systemPrompt: config.systemPrompt,
    templateJson: config.templateJson,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    topP: config.topP,
    modelApiConfigId: config.modelApiConfigId,
    modelApiConfigName: effectiveModelConfigName ?? null,
    isUsingDefaultModel,
    isEnabled: config.isEnabled,
    isDefault: config.isDefault,
    createdAt: toIsoString(config.createdAt),
    updatedAt: toIsoString(config.updatedAt),
  };
}

export function coerceNullableNumber(value: number | null | undefined) {
  return value == null ? null : value;
}

export function resolvePromptSystemPrompt(config: {
  type: PromptConfigType;
  systemPrompt: string | null;
  prompt: string;
  templateJson?: string | null;
}) {
  if (config.type === PromptConfigType.daily_report && config.templateJson) {
    try {
      const template = parseDailyReportTemplateJson(config.templateJson);
      if (template) {
        return compileDailyReportTemplatePrompt(template);
      }
    } catch {
      // Legacy or invalid templates are surfaced by the daily-report pipeline.
      // They must not prevent ingestion and unrelated task runtime config from loading.
    }
  }

  return config.systemPrompt || config.prompt;
}

export function resolveTemplateJsonForSave(input: SavePromptConfigInput) {
  if (input.type !== PromptConfigType.daily_report) {
    return null;
  }

  const templateJson = normalizeText(input.templateJson ?? "");
  if (!templateJson) {
    return null;
  }

  const template = parseDailyReportTemplateJson(templateJson);
  return {
    templateJson: template ? stringifyDailyReportTemplate(template) : templateJson,
    systemPrompt: template ? compileDailyReportTemplatePrompt(template) : input.systemPrompt?.trim() || null,
  };
}

function validateIngestionConcurrency(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error("并发数必须是 1 到 10 之间的整数。");
  }
}

export function validateModelApiInput(
  input: SaveModelApiConfigInput,
  options?: {
    isUpdate?: boolean;
    currentHasApiKey?: boolean;
  },
) {
  if (!normalizeText(input.name)) {
    throw new Error("请填写配置名称。");
  }
  if (!normalizeText(input.baseUrl)) {
    throw new Error("请填写 API 地址。");
  }
  if (!normalizeText(input.modelName)) {
    throw new Error("请填写模型名称。");
  }
  validateIngestionConcurrency(input.ingestionItemConcurrency);
  if (!options?.isUpdate && !normalizeText(input.apiKey)) {
    throw new Error("请填写 API Key。");
  }
  if (options?.isUpdate && input.apiKeyMode === "replace" && !normalizeText(input.apiKey)) {
    throw new Error("替换 API Key 时不能为空。");
  }
  if (options?.isUpdate && input.apiKeyMode === "keep" && !options.currentHasApiKey && !normalizeText(input.apiKey)) {
    throw new Error("当前配置没有可保留的 API Key，请填写新的 API Key。");
  }
}

export async function validatePromptConfigInput(
  input: SavePromptConfigInput,
  currentPromptId?: string,
) {
  if (!normalizeText(input.name)) {
    throw new Error("请填写提示词配置名称。");
  }
  const savedTemplate = resolveTemplateJsonForSave(input);

  if (!savedTemplate && !normalizeText(input.systemPrompt)) {
    throw new Error("请填写系统提示词。");
  }
  if (!normalizeText(input.prompt)) {
    throw new Error("请填写提示词模板。");
  }
  validateClusterMergePromptProtocol(input);
  if (input.temperature != null && (input.temperature < 0 || input.temperature > 2)) {
    throw new Error("温度必须在 0 到 2 之间。");
  }
  if (input.maxTokens != null && input.maxTokens <= 0) {
    throw new Error("最大 Tokens 必须大于 0。");
  }
  if (input.topP != null && (input.topP < 0 || input.topP > 1)) {
    throw new Error("Top P 必须在 0 到 1 之间。");
  }

  if (input.modelApiConfigId) {
    const modelConfig = await prisma.modelApiConfig.findUnique({
      where: { id: input.modelApiConfigId },
    });

    if (!modelConfig) {
      throw new Error("关联的模型配置不存在。");
    }
  }

  if (input.isDefault) {
    const existingDefault = await prisma.promptConfig.findFirst({
      where: {
        type: input.type,
        isDefault: true,
        ...(currentPromptId ? { id: { not: currentPromptId } } : {}),
      },
    });

    if (existingDefault && !input.isEnabled) {
      throw new Error("默认提示词配置不能被保存为禁用状态。");
    }
  }
}

function validateClusterMergePromptProtocol(input: SavePromptConfigInput) {
  if (input.type !== PromptConfigType.cluster_merge) {
    return;
  }

  const content = `${input.systemPrompt ?? ""}\n${input.prompt}`;
  const usesLegacyOutput = ["approvedPairs", "mergeGroups"].some((marker) => content.includes(marker));
  const declaresDecisionProtocol = content.includes("decisions") && content.includes("verdict");

  if (usesLegacyOutput && !declaresDecisionProtocol) {
    throw new Error("聚合合并提示词必须使用 decisions/verdict 协议，不能继续输出 approvedPairs 或 mergeGroups。");
  }
}

const ALL_PROMPT_TYPES = [
  PromptConfigType.item_understanding,
  PromptConfigType.cluster_summary,
  PromptConfigType.cluster_match,
  PromptConfigType.cluster_merge,
  PromptConfigType.daily_report,
] as const;

const REMOVED_PROMPT_CONFIG_TYPES = [
  "daily_report_refinement_chat",
  "daily_report_refinement_generate",
  "item_summary",
  "item_analysis",
  "item_aggregation",
] as const;

const LEGACY_ITEM_UNDERSTANDING_TAG_MARKER = '"tags":';
const LEGACY_ITEM_UNDERSTANDING_TAG_RULE_MARKER = "tags 返回 0-5 个具体";

async function deleteRemovedPromptConfigTypes() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM "prompt_configs" WHERE "type" IN (${REMOVED_PROMPT_CONFIG_TYPES.map(() => "?").join(", ")})`,
    ...REMOVED_PROMPT_CONFIG_TYPES,
  );
}

function resolveSystemPromptByType(type: PromptConfigType, fileConfig: RuntimeConfig): string {
  switch (type) {
    case PromptConfigType.item_understanding:
      return fileConfig.prompts.itemUnderstanding;
    case PromptConfigType.cluster_summary:
      return fileConfig.prompts.clusterSummary;
    case PromptConfigType.cluster_match:
      return fileConfig.prompts.clusterMatch;
    case PromptConfigType.cluster_merge:
      return fileConfig.prompts.clusterMerge;
    case PromptConfigType.daily_report:
      return fileConfig.prompts.dailyReport;
  }
}

export type RuntimeConfigSeedOptions = {
  migrateDailyReportTemplates?: boolean;
};

async function ensureModelAndPromptConfigsSeeded(options: RuntimeConfigSeedOptions = {}) {
  await deleteRemovedPromptConfigTypes();

  const fileConfig = getRuntimeConfig();
  const [modelConfigCount, promptConfigCount, sourceCount, blacklistCount] = await Promise.all([
    prisma.modelApiConfig.count(),
    prisma.promptConfig.count(),
    prisma.source.count(),
    prisma.blacklistKeyword.count(),
  ]);

  await upgradeLegacyItemUnderstandingPrompt();
  await upgradePreviousDefaultItemUnderstandingPrompt();
  await upgradeLegacyClusterMergePrompt();
  await upgradePreviousDefaultClusterMergePrompt();
  if (options.migrateDailyReportTemplates !== false) {
    await upgradeLegacyDailyReportPrompt(fileConfig);
  }
  await upgradeLegacyClusterSummaryTokenBudget();

  if (
    modelConfigCount > 0 &&
    promptConfigCount > 0 &&
    (sourceCount > 0 || fileConfig.rssSources.length === 0) &&
    (blacklistCount > 0 || fileConfig.blacklistKeywords.length === 0)
  ) {
    const existingTypes = await prisma.promptConfig.findMany({
      where: { type: { in: ALL_PROMPT_TYPES as unknown as PromptConfigType[] } },
      select: { type: true },
    });

    if (ALL_PROMPT_TYPES.every((type) => existingTypes.some((row) => row.type === type))) {
      return;
    }
  }

  await prisma.$transaction(async (tx) => {
    const shouldSeedDefaultSources = sourceCount === 0 && modelConfigCount === 0 && promptConfigCount === 0;

    if (modelConfigCount === 0) {
      await tx.modelApiConfig.create({
        data: {
          name: DEFAULT_MODEL_CONFIG_NAME,
          baseUrl: fileConfig.modelApi.baseURL,
          apiKey: fileConfig.modelApi.apiKey,
          modelName: fileConfig.modelApi.model,
          ingestionItemConcurrency: fileConfig.ingestion.itemConcurrency,
          isEnabled: true,
          isDefault: true,
        },
      });
    }

    if (promptConfigCount === 0) {
      await tx.promptConfig.createMany({
        data: ALL_PROMPT_TYPES.map((type) => {
          const sampling = getDefaultPromptSampling(type);
          return {
            name: getDefaultPromptConfigName(type),
            type,
            prompt: getDefaultPromptTemplate(type),
            systemPrompt: resolveSystemPromptByType(type, fileConfig),
            templateJson: type === PromptConfigType.daily_report ? DEFAULT_DAILY_REPORT_TEMPLATE_JSON : null,
            temperature: sampling.temperature,
            maxTokens: sampling.maxTokens,
            topP: sampling.topP,
            modelApiConfigId: null,
            isEnabled: true,
            isDefault: true,
          };
        }),
      });
    }

    // Backfill any missing prompt config types (e.g. added in a newer version)
    const existingTypes = (
      await tx.promptConfig.findMany({
        where: { type: { in: ALL_PROMPT_TYPES as unknown as PromptConfigType[] } },
        select: { type: true },
      })
    ).map((row) => row.type);
    const missingTypes = ALL_PROMPT_TYPES.filter((type) => !existingTypes.includes(type));

    for (const type of missingTypes) {
      const sampling = getDefaultPromptSampling(type);
      await tx.promptConfig.create({
        data: {
          name: getDefaultPromptConfigName(type),
          type,
          prompt: getDefaultPromptTemplate(type),
          systemPrompt: resolveSystemPromptByType(type, fileConfig),
          templateJson: type === PromptConfigType.daily_report ? DEFAULT_DAILY_REPORT_TEMPLATE_JSON : null,
          temperature: sampling.temperature,
          maxTokens: sampling.maxTokens,
          topP: sampling.topP,
          modelApiConfigId: null,
          isEnabled: true,
          isDefault: true,
        },
      });
    }

    if (shouldSeedDefaultSources && fileConfig.rssSources.length > 0) {
      await tx.source.createMany({
        data: fileConfig.rssSources.map((source) => ({
          name: source.name,
          rssUrl: source.rssUrl,
          siteUrl: source.siteUrl,
          enabled: source.enabled,
          aiParsingEnabled: source.aiParsingEnabled,
          aggregationEnabled: source.aggregationEnabled ?? true,
          aggregationDetectionEnabled: source.aggregationDetectionEnabled ?? false,
        })),
      });
    }

    if (blacklistCount === 0 && fileConfig.blacklistKeywords.length > 0) {
      await tx.blacklistKeyword.createMany({
        data: fileConfig.blacklistKeywords
          .map(normalizeKeyword)
          .filter(Boolean)
          .map((keyword) => ({ keyword })),
      });
    }
  });
}

async function upgradeLegacyClusterSummaryTokenBudget() {
  await prisma.promptConfig.updateMany({
    where: {
      type: PromptConfigType.cluster_summary,
      isDefault: true,
      maxTokens: 450,
    },
    data: {
      maxTokens: getDefaultPromptSampling("cluster_summary").maxTokens,
    },
  });
}

async function upgradeLegacyItemUnderstandingPrompt() {
  const configs = await prisma.promptConfig.findMany({
    where: {
      type: PromptConfigType.item_understanding,
      isDefault: true,
    },
    select: {
      id: true,
      systemPrompt: true,
    },
  });

  for (const config of configs) {
    const systemPrompt = config.systemPrompt ?? "";
    const isLegacyPrompt =
      systemPrompt === LEGACY_DEFAULT_ITEM_UNDERSTANDING_PROMPT ||
      (systemPrompt.includes(LEGACY_ITEM_UNDERSTANDING_TAG_MARKER) &&
        systemPrompt.includes(LEGACY_ITEM_UNDERSTANDING_TAG_RULE_MARKER) &&
        systemPrompt.includes('"eventSignature"') &&
        systemPrompt.includes('"aggregation"'));

    if (!isLegacyPrompt) continue;

    await prisma.promptConfig.update({
      where: { id: config.id },
      data: {
        systemPrompt: DEFAULT_ITEM_UNDERSTANDING_PROMPT,
      },
    });
  }
}

async function upgradePreviousDefaultItemUnderstandingPrompt() {
  // Environments initialized before the wording change keep the previous
  // default text in prompt_configs. Upgrade only untouched default rows
  // (exact match), so administrator-edited prompts are never overwritten.
  await prisma.promptConfig.updateMany({
    where: {
      type: PromptConfigType.item_understanding,
      isDefault: true,
      systemPrompt: PREVIOUS_DEFAULT_ITEM_UNDERSTANDING_PROMPT,
    },
    data: {
      systemPrompt: DEFAULT_ITEM_UNDERSTANDING_PROMPT,
    },
  });
}

async function upgradeLegacyClusterMergePrompt() {
  const configs = await prisma.promptConfig.findMany({
    where: {
      type: PromptConfigType.cluster_merge,
      isDefault: true,
      systemPrompt: LEGACY_DEFAULT_CLUSTER_MERGE_PROMPT,
    },
    select: { id: true },
  });

  if (configs.length === 0) {
    return;
  }

  await prisma.promptConfig.updateMany({
    where: { id: { in: configs.map((config) => config.id) } },
    data: { systemPrompt: DEFAULT_CLUSTER_MERGE_PROMPT },
  });
}

async function upgradePreviousDefaultClusterMergePrompt() {
  await prisma.promptConfig.updateMany({
    where: {
      type: PromptConfigType.cluster_merge,
      isDefault: true,
      systemPrompt: PREVIOUS_DEFAULT_CLUSTER_MERGE_PROMPT,
    },
    data: {
      systemPrompt: DEFAULT_CLUSTER_MERGE_PROMPT,
    },
  });
}

async function upgradeLegacyDailyReportPrompt(fileConfig: RuntimeConfig) {
  const hasMigrationAudit = (
    auditJson: string | null,
    expected: { from: string; mode: string },
  ) => {
    if (!auditJson) return false;
    try {
      const audit = JSON.parse(auditJson) as Record<string, unknown>;
      return audit.from === expected.from && audit.to === 2 && audit.mode === expected.mode;
    } catch {
      return false;
    }
  };

  const defaultDailyReportPrompts = await prisma.promptConfig.findMany({
    where: {
      type: PromptConfigType.daily_report,
      isDefault: true,
    },
    select: {
      id: true,
      systemPrompt: true,
      templateJson: true,
      templateMigrationAuditJson: true,
    },
  });

  for (const config of defaultDailyReportPrompts) {
    if (!config.templateJson) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(config.templateJson) as unknown;
    } catch {
      // Invalid JSON remains untouched and is surfaced when the daily report pipeline runs.
      continue;
    }

    const migrationStatus = classifyDailyReportTemplateMigration(parsed, config.systemPrompt);
    if (migrationStatus === "v2") {
      let normalizedTemplate;
      try {
        normalizedTemplate = upgradeDefaultDailyReportTemplate(parseDailyReportTemplateJson(config.templateJson)!);
      } catch {
        // Invalid v2 templates remain untouched and must be fixed in Admin.
        continue;
      }
      const normalizedJson = stringifyDailyReportTemplate(normalizedTemplate);
      if (normalizedJson !== config.templateJson) {
        try {
          await prisma.promptConfig.update({
            where: { id: config.id },
            data: {
              templateJson: normalizedJson,
              systemPrompt: compileDailyReportTemplatePrompt(normalizedTemplate),
              templateMigrationAuditJson: JSON.stringify({
                from: "v2-default-wording",
                to: 2,
                mode: "silent",
                migratedAt: new Date().toISOString(),
              }),
            },
          });
        } catch (error) {
          console.error("[settings] 日报模板静默迁移写入失败", { configId: config.id, migrationStatus, error });
          throw error;
        }
      }
    } else if (migrationStatus === "official_default_legacy") {
      try {
        await prisma.promptConfig.update({
          where: { id: config.id },
          data: {
            systemPrompt: resolveSystemPromptByType(PromptConfigType.daily_report, fileConfig),
            templateJson: DEFAULT_DAILY_REPORT_TEMPLATE_JSON,
            templateMigrationAuditJson: JSON.stringify({
              from: "legacy-opening-sections-closing",
              to: 2,
              mode: "silent",
              migratedAt: new Date().toISOString(),
            }),
          },
        });
      } catch (error) {
        console.error("[settings] 日报旧模板静默迁移写入失败", { configId: config.id, migrationStatus, error });
        throw error;
      }
    } else if (migrationStatus === "custom_legacy_requires_migration") {
      if (hasMigrationAudit(config.templateMigrationAuditJson, {
        from: "legacy-opening-sections-closing",
        mode: "admin_required",
      })) continue;
      await prisma.promptConfig.update({
        where: { id: config.id },
        data: {
          templateMigrationAuditJson: JSON.stringify({
            from: "legacy-opening-sections-closing",
            to: 2,
            mode: "admin_required",
            migratedAt: new Date().toISOString(),
          }),
        },
      });
    } else if (migrationStatus === "invalid") {
      if (hasMigrationAudit(config.templateMigrationAuditJson, {
        from: "unknown",
        mode: "invalid_requires_admin",
      })) continue;
      await prisma.promptConfig.update({
        where: { id: config.id },
        data: {
          templateMigrationAuditJson: JSON.stringify({
            from: "unknown",
            to: 2,
            mode: "invalid_requires_admin",
            migratedAt: new Date().toISOString(),
          }),
        },
      });
    }
  }

  await prisma.promptConfig.updateMany({
    where: {
      type: PromptConfigType.daily_report,
      isDefault: true,
      templateJson: null,
      systemPrompt: {
        contains: LEGACY_DAILY_REPORT_PROMPT_MARKER,
      },
    },
    data: {
      systemPrompt: resolveSystemPromptByType(PromptConfigType.daily_report, fileConfig),
      templateJson: DEFAULT_DAILY_REPORT_TEMPLATE_JSON,
      templateMigrationAuditJson: JSON.stringify({
        from: "legacy-daily-report-prompt-marker",
        to: 2,
        mode: "silent",
        migratedAt: new Date().toISOString(),
      }),
    },
  });
}

export async function ensureRuntimeConfigSeeded(options: RuntimeConfigSeedOptions = {}) {
  await ensureModelAndPromptConfigsSeeded(options);
}

export function serializeSelectedPromptConfig(
  config: {
    type: PromptConfigType;
    name: string;
    systemPrompt: string | null;
    templateJson?: string | null;
    prompt: string;
    temperature: number | null;
    maxTokens: number | null;
    topP: number | null;
    modelApiConfig: {
      apiKey: string;
      baseUrl: string;
      modelName: string;
      customHeaders?: string;
      isEnabled: boolean;
    } | null;
  },
) {
  return {
    name: config.name,
    systemPrompt: resolvePromptSystemPrompt(config),
    promptTemplate: config.prompt,
    templateJson: config.templateJson ?? null,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    topP: config.topP,
    modelApi:
      config.modelApiConfig && config.modelApiConfig.isEnabled
        ? serializeRuntimeModelApi(config.modelApiConfig)
        : null,
  };
}

export function pickPromptConfigByType(
  promptConfigs: Array<{
    type: PromptConfigType;
    name: string;
    systemPrompt: string | null;
    templateJson?: string | null;
    prompt: string;
    temperature: number | null;
    maxTokens: number | null;
    topP: number | null;
    modelApiConfig: {
      apiKey: string;
      baseUrl: string;
      modelName: string;
      isEnabled: boolean;
    } | null;
  }>,
  type: PromptConfigType,
) {
  const config = promptConfigs.find((entry) => entry.type === type);

  if (!config) {
    throw new Error(`缺少启用中的默认提示词配置：${type}`);
  }

  return config;
}

export function shouldEnableAiParsing(
  items: Array<{ content?: string | null; "content:encoded"?: string | null; contentSnippet?: string | null }>,
): boolean {
  if (items.length === 0) {
    return true;
  }

  let wellFormattedCount = 0;
  const sampleSize = Math.min(items.length, 5);

  for (let index = 0; index < sampleSize; index += 1) {
    const item = items[index];
    const hasFullContent = Boolean(item?.["content:encoded"]?.trim() || item?.content?.trim());
    const contentLength = (item?.contentSnippet ?? "").length;
    const hasGoodSnippet = contentLength >= 100;

    if (hasFullContent || hasGoodSnippet) {
      wellFormattedCount += 1;
    }
  }

  return wellFormattedCount / sampleSize < 0.6;
}
