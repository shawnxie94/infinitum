import type { AiEventSignature } from "@/lib/ai/provider";
import { collapseWhitespace, trimBoundaryPunctuation } from "@/lib/utils/text";

const EVENT_TYPES = new Set<NonNullable<AiEventSignature["eventType"]>>([
  "release",
  "launch",
  "update",
  "funding",
  "acquisition",
  "partnership",
  "policy",
  "research",
  "security",
  "other",
]);

const ACTION_ALIASES = new Map<string, string>([
  ["正式发布", "发布"],
  ["宣布发布", "发布"],
  ["宣布推出", "发布"],
  ["推出", "发布"],
  ["上线", "上线"],
  ["正式上线", "上线"],
  ["发布更新", "更新"],
  ["更新", "更新"],
  ["完成融资", "融资"],
  ["获得融资", "融资"],
  ["融资", "融资"],
  ["收购", "收购"],
  ["完成收购", "收购"],
  ["达成合作", "合作"],
  ["合作", "合作"],
  ["披露漏洞", "披露漏洞"],
  ["发布论文", "发布论文"],
  ["出台政策", "出台政策"],
]);

function normalizeOptionalText(value: string | null | undefined) {
  const normalized = trimBoundaryPunctuation(collapseWhitespace(value ?? ""));
  return normalized || null;
}

export function normalizeStoredEventType(value: string | null | undefined): AiEventSignature["eventType"] {
  return value && EVENT_TYPES.has(value as NonNullable<AiEventSignature["eventType"]>)
    ? (value as NonNullable<AiEventSignature["eventType"]>)
    : null;
}

export function normalizeEventSubjectForStorage(value: string | null | undefined) {
  let normalized = normalizeOptionalText(value);

  if (!normalized) {
    return null;
  }

  const suffixPatterns = [
    /\s*(公司|官方)$/u,
    /\s*,?\s*(inc\.?|corp\.?|co\.?|ltd\.?)$/i,
  ];

  for (const pattern of suffixPatterns) {
    let next = normalized.replace(pattern, "").trim();
    while (next && next !== normalized) {
      normalized = next;
      next = normalized.replace(pattern, "").trim();
    }
  }

  return normalized || null;
}

export function normalizeEventActionForStorage(value: string | null | undefined) {
  const normalized = normalizeOptionalText(value);

  if (!normalized) {
    return null;
  }

  return ACTION_ALIASES.get(normalized) ?? normalized;
}

export function normalizeEventObjectForStorage(value: string | null | undefined) {
  const rawValue = collapseWhitespace(value ?? "").trim();
  let normalized = normalizeOptionalText(value);

  if (!normalized) {
    return null;
  }

  if (rawValue.endsWith(")") && rawValue.includes("(") && !normalized.endsWith(")")) {
    normalized += ")";
  }
  if (rawValue.endsWith("）") && rawValue.includes("（") && !normalized.endsWith("）")) {
    normalized += "）";
  }

  normalized = normalized.replace(/^(新版|全新|新款)\s*/u, "").trim();

  const strippedSuffix = normalized.replace(/\s*(服务|平台|方案|能力|功能)$/u, "").trim();
  if (strippedSuffix) {
    normalized = strippedSuffix;
  }

  return normalized || null;
}

function normalizeEventDateForStorage(value: string | null | undefined) {
  const normalized = normalizeOptionalText(value);
  return normalized || null;
}

export function normalizeEventSignatureForStorage(signature?: AiEventSignature | null): AiEventSignature | null {
  if (!signature) {
    return null;
  }

  const normalized: AiEventSignature = {
    eventType: normalizeStoredEventType(signature.eventType),
    eventSubject: normalizeEventSubjectForStorage(signature.eventSubject),
    eventAction: normalizeEventActionForStorage(signature.eventAction),
    eventObject: normalizeEventObjectForStorage(signature.eventObject),
    eventDate: normalizeEventDateForStorage(signature.eventDate),
  };

  return normalized.eventType ||
    normalized.eventSubject ||
    normalized.eventAction ||
    normalized.eventObject ||
    normalized.eventDate
    ? normalized
    : null;
}

export function normalizeEventSignatureForMatch(signature?: AiEventSignature | null) {
  const normalized = normalizeEventSignatureForStorage(signature);

  if (!normalized) {
    return {
      eventType: null,
      eventSubject: null,
      eventAction: null,
      eventObject: null,
      eventDate: null,
    };
  }

  return {
    eventType: normalized.eventType,
    eventSubject: normalized.eventSubject?.toLowerCase() ?? null,
    eventAction: normalized.eventAction?.toLowerCase() ?? null,
    eventObject: normalized.eventObject?.toLowerCase() ?? null,
    eventDate: normalized.eventDate?.toLowerCase() ?? null,
  };
}
