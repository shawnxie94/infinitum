import { jsonrepair } from "jsonrepair";

import { normalizeModelResponseText } from "@/lib/ai/response-format";
import { resolveRubricQualityScore, type QualityRubric } from "@/lib/ai/quality-rubric";
import { requireUsableGeneratedSummary } from "@/lib/ai/summary-quality";
import { normalizeOptionalText } from "@/lib/utils/text";
import { getJsonParseErrorMessage } from "@/lib/ai/provider-client";
import { InvalidJsonModelResponseError } from "@/lib/ai/provider-types";
import type {
  AiEnrichment,
  AiEventSignature,
  ItemUnderstandingResult,
  ParsedEvent,
  ParsedEventSignature,
} from "@/lib/ai/provider-types";

const DEFAULT_PARSED_AGGREGATION_MAX_EVENTS = 20;

function getFallbackEnrichment(
  metadata: { title: string; translateTitle: boolean },
): AiEnrichment {
  return {
    translatedTitle: metadata.translateTitle ? metadata.title : null,
    moderationStatus: "allowed",
    moderationReason: null,
    moderationDetail: null,
    qualityScore: 50,
    qualityRationale: "AI analysis unavailable",
    eventSignature: {
      eventType: null,
      eventSubject: null,
      eventAction: null,
      eventObject: null,
      eventDate: null,
    },
  };
}

export function getFallbackUnderstanding(
  metadata: { title: string; translateTitle: boolean },
): ItemUnderstandingResult {
  return {
    ...getFallbackEnrichment(metadata),
    summary: "",
    aggregation: { isAggregation: false, mainEvent: null, events: [] },
    diagnostics: {
      summaryValid: false,
      analysisValid: false,
      aggregationValid: false,
    },
  };
}

function isValidQualityScore(value: unknown) {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;

  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100;
}

function hasCompleteParsedEvent(event: ParsedEvent) {
  return Boolean(
    event.title &&
    event.oneLiner &&
    event.eventSubject &&
    event.eventAction &&
    event.eventObject &&
    isValidQualityScore(event.qualityScore),
  );
}

export function parseItemUnderstandingOutput(
  rawContent: string,
  inputText: string,
  fallback: ItemUnderstandingResult,
  translateTitle: boolean,
  maxEvents: number,
  qualityRubric: QualityRubric | null = null,
): ItemUnderstandingResult {
  const normalized = normalizeModelResponseText(rawContent);
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(normalized) as Record<string, unknown>;
  } catch (initialError) {
    try {
      parsed = JSON.parse(jsonrepair(normalized)) as Record<string, unknown>;
      console.warn(
        `[AI Provider] Repaired invalid item understanding JSON (length=${normalized.length}, initialError=${getJsonParseErrorMessage(initialError)})`,
      );
    } catch (repairError) {
      throw new InvalidJsonModelResponseError(
        `统一条目理解模型返回了无法解析的 JSON（长度 ${normalized.length}）：${getJsonParseErrorMessage(initialError)}；本地修复失败：${getJsonParseErrorMessage(repairError)}`,
      );
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidJsonModelResponseError("统一条目理解 JSON 顶层必须是对象。");
  }

  let summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  let summaryValid = false;
  if (summary) {
    try {
      summary = requireUsableGeneratedSummary(summary, inputText);
      summaryValid = true;
    } catch {
      summary = "";
    }
  }

  const analysisValid =
    (parsed.moderationStatus === "allowed" || parsed.moderationStatus === "filtered") &&
    isValidQualityScore(parsed.qualityScore) &&
    typeof parsed.qualityRationale === "string" &&
    parsed.qualityRationale.trim().length > 0;
  const enrichment = buildEnrichmentFromParsed(
    parsed as Parameters<typeof buildEnrichmentFromParsed>[0],
    fallback,
    translateTitle,
    qualityRubric,
  );
  const rawAggregation = parsed.aggregation && typeof parsed.aggregation === "object"
    ? parsed.aggregation as Record<string, unknown>
    : null;
  const isAggregation = rawAggregation?.isAggregation === true;
  const events = Array.isArray(rawAggregation?.events)
    ? rawAggregation.events
        .map((event) => normalizeParsedEvent(event as Partial<ParsedEvent>))
        .filter((event): event is ParsedEvent => event !== null)
        .filter(hasCompleteParsedEvent)
        .slice(0, maxEvents)
    : [];
  const mainEvent = normalizeParsedEventSignature(
    rawAggregation?.mainEvent as Partial<ParsedEventSignature> | null | undefined,
  );
  const aggregationValid = Boolean(
    rawAggregation &&
    typeof rawAggregation.isAggregation === "boolean" &&
    (!isAggregation || events.length > 0),
  );
  return {
    ...enrichment,
    summary,
    aggregation: aggregationValid
      ? { isAggregation, mainEvent, events: isAggregation ? events : [] }
      : fallback.aggregation,
    diagnostics: {
      summaryValid,
      analysisValid,
      aggregationValid,
    },
  };
}

export function normalizeAggregationSplitMaxEvents(value: number | null | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_PARSED_AGGREGATION_MAX_EVENTS;
}

function normalizeParsedEventSignature(
  raw: Partial<ParsedEventSignature> | null | undefined,
): ParsedEventSignature | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  return {
    eventType: normalizeEventType(raw.eventType ?? null),
    eventSubject: typeof raw.eventSubject === "string" ? raw.eventSubject.trim() || null : null,
    eventAction: typeof raw.eventAction === "string" ? raw.eventAction.trim() || null : null,
    eventObject: typeof raw.eventObject === "string" ? raw.eventObject.trim() || null : null,
    eventDate: normalizeEventDate(raw.eventDate ?? null),
  };
}

function normalizeParsedEvent(raw: Partial<ParsedEvent>): ParsedEvent | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const signature = normalizeParsedEventSignature(raw);
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 120) || null : null;
  const oneLiner = typeof raw.oneLiner === "string" ? raw.oneLiner.trim() : "";

  if (!title || !oneLiner || !isValidQualityScore(raw.qualityScore)) {
    return null;
  }

  if (!signature) {
    return {
      eventType: null,
      eventSubject: null,
      eventAction: null,
      eventObject: null,
      eventDate: null,
      title,
      oneLiner,
      qualityScore: normalizeScore(raw.qualityScore, 50),
      sourceUrl: normalizeSourceUrl(raw.sourceUrl ?? null),
    };
  }

  return {
    eventType: signature.eventType,
    eventSubject: signature.eventSubject,
    eventAction: signature.eventAction,
    eventObject: signature.eventObject,
    eventDate: signature.eventDate,
    title,
    oneLiner,
    qualityScore: normalizeScore(raw.qualityScore, 50),
    sourceUrl: normalizeSourceUrl(raw.sourceUrl ?? null),
  };
}

function normalizeModerationStatus(value: string | null | undefined): AiEnrichment["moderationStatus"] {
  return value === "filtered" || value === "restored" ? value : "allowed";
}

function normalizeModerationReason(value: string | null | undefined): AiEnrichment["moderationReason"] {
  return value === "marketing" ||
    value === "low_quality" ||
    value === "duplicate_noise" ||
    value === "rule_filter" ||
    value === "rule_blacklist" ||
    value === "other"
    ? value
    : null;
}

function normalizeScore(value: number | string | null | undefined, fallback: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeEventType(value: string | null | undefined): AiEventSignature["eventType"] {
  return value === "release" ||
    value === "launch" ||
    value === "update" ||
    value === "funding" ||
    value === "acquisition" ||
    value === "partnership" ||
    value === "policy" ||
    value === "research" ||
    value === "security" ||
    value === "other"
    ? value
    : null;
}

function normalizeEventDate(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function normalizeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function buildEventSignatureFromParsed(
  parsed: {
    eventType?: string | null;
    eventSubject?: string | null;
    eventAction?: string | null;
    eventObject?: string | null;
    eventDate?: string | null;
    eventSignature?: {
      eventType?: string | null;
      eventSubject?: string | null;
      eventAction?: string | null;
      eventObject?: string | null;
      eventDate?: string | null;
    } | null;
  },
  fallback: AiEventSignature,
): AiEventSignature {
  const parsedSignature = parsed.eventSignature ?? {};

  return {
    eventType: normalizeEventType(parsed.eventType ?? parsedSignature.eventType) ?? fallback.eventType,
    eventSubject: normalizeOptionalText(parsed.eventSubject ?? parsedSignature.eventSubject, fallback.eventSubject),
    eventAction: normalizeOptionalText(parsed.eventAction ?? parsedSignature.eventAction, fallback.eventAction),
    eventObject: normalizeOptionalText(parsed.eventObject ?? parsedSignature.eventObject, fallback.eventObject),
    eventDate: normalizeEventDate(parsed.eventDate ?? parsedSignature.eventDate) ?? fallback.eventDate,
  };
}

function buildEnrichmentFromParsed(
  parsed: {
    translatedTitle?: string | null;
    moderationStatus?: string | null;
    moderationReason?: string | null;
    moderationDetail?: string | null;
    qualityScore?: number | string | null;
    qualityBreakdown?: unknown;
    qualityRationale?: string | null;
    eventType?: string | null;
    eventSubject?: string | null;
    eventAction?: string | null;
    eventObject?: string | null;
    eventDate?: string | null;
    eventSignature?: {
      eventType?: string | null;
      eventSubject?: string | null;
      eventAction?: string | null;
      eventObject?: string | null;
      eventDate?: string | null;
    } | null;
  },
  fallback: AiEnrichment,
  translateTitle: boolean,
  qualityRubric: QualityRubric | null = null,
): AiEnrichment {
  // 总分以代码计算为准：qualityBreakdown 逐维度校验通过时做档位吸附求和；
  // 子分缺失或非法时回退到模型输出的单字段 qualityScore（兼容旧提示词与
  // 自定义提示词）；两者都不可用才是 fallback。
  const rubricScore = resolveRubricQualityScore(qualityRubric, parsed.qualityBreakdown);
  return {
    translatedTitle: translateTitle ? parsed.translatedTitle?.trim() || fallback.translatedTitle : null,
    moderationStatus: normalizeModerationStatus(parsed.moderationStatus),
    moderationReason: normalizeModerationReason(parsed.moderationReason),
    moderationDetail: parsed.moderationDetail?.trim() || fallback.moderationDetail,
    qualityScore: rubricScore.matched
      ? rubricScore.score
      : normalizeScore(parsed.qualityScore, fallback.qualityScore),
    qualityRationale: parsed.qualityRationale?.trim() || fallback.qualityRationale,
    eventSignature: buildEventSignatureFromParsed(parsed, fallback.eventSignature),
  };
}
