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

export type EventDatePrecision = "year" | "month" | "day";

type EventDateParts = {
  year: number;
  month?: number;
  day?: number;
};

function parseEventDateParts(value: string): EventDateParts | null {
  const fullDateMatch = value.match(
    /^(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?(?:$|[T\s].*)/u,
  );
  if (fullDateMatch) {
    return {
      year: Number(fullDateMatch[1]),
      month: Number(fullDateMatch[2]),
      day: Number(fullDateMatch[3]),
    };
  }

  const monthMatch = value.match(/^(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*月?$/u);
  if (monthMatch) {
    return {
      year: Number(monthMatch[1]),
      month: Number(monthMatch[2]),
    };
  }

  const yearMatch = value.match(/^(\d{4})\s*年?$/u);
  if (yearMatch) {
    return { year: Number(yearMatch[1]) };
  }

  return null;
}

function isValidEventDateParts(parts: EventDateParts) {
  if (parts.year < 1 || parts.year > 9999) {
    return false;
  }

  if (parts.month === undefined) {
    return true;
  }

  if (parts.month < 1 || parts.month > 12) {
    return false;
  }

  if (parts.day === undefined) {
    return true;
  }

  const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  return parts.day >= 1 && parts.day <= daysInMonth;
}

function formatEventDateParts(parts: EventDateParts) {
  if (!isValidEventDateParts(parts)) {
    return null;
  }

  const year = String(parts.year).padStart(4, "0");
  if (parts.month === undefined) {
    return year;
  }

  const month = String(parts.month).padStart(2, "0");
  if (parts.day === undefined) {
    return `${year}-${month}`;
  }

  return `${year}-${month}-${String(parts.day).padStart(2, "0")}`;
}

export function normalizeEventDateForStorage(value: string | null | undefined) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }

  const parsed = parseEventDateParts(normalized);
  return parsed ? formatEventDateParts(parsed) ?? normalized : normalized;
}

export function getEventDatePrecision(value: string | null | undefined): EventDatePrecision | null {
  const normalized = normalizeEventDateForStorage(value);
  if (!normalized) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    return "day";
  }
  if (/^\d{4}-\d{2}$/u.test(normalized)) {
    return "month";
  }
  if (/^\d{4}$/u.test(normalized)) {
    return "year";
  }

  return null;
}

export function areEventDatesExactlyEqual(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  const normalizedLeft = normalizeEventDateForStorage(left);
  const normalizedRight = normalizeEventDateForStorage(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function areEventDatesCompatible(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  const normalizedLeft = normalizeEventDateForStorage(left);
  const normalizedRight = normalizeEventDateForStorage(right);

  if (!normalizedLeft || !normalizedRight || normalizedLeft === normalizedRight) {
    return true;
  }

  const leftPrecision = getEventDatePrecision(normalizedLeft);
  const rightPrecision = getEventDatePrecision(normalizedRight);
  if (!leftPrecision || !rightPrecision) {
    return false;
  }

  const isWithinCoarserDate = (coarse: string, precision: EventDatePrecision, precise: string) => {
    if (precision === "year") {
      return precise.startsWith(`${coarse}-`);
    }
    if (precision === "month") {
      return precise.startsWith(`${coarse}-`);
    }
    return false;
  };

  return (
    isWithinCoarserDate(normalizedLeft, leftPrecision, normalizedRight) ||
    isWithinCoarserDate(normalizedRight, rightPrecision, normalizedLeft)
  );
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
