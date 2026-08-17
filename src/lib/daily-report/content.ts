import {
  DEFAULT_CLOSING_LABEL,
  DEFAULT_OPENING_LABEL,
  type DailyReportBlock,
  type DailyReportContent,
  type DailyReportItem,
  type DailyReportItemNote,
  type DailyReportSectionBlock,
  type DailyReportTextBlock,
} from "@/lib/daily-report/types";
import { stripDailyReportGeneratedLabel } from "@/lib/daily-report/validator";
import { normalizeDailyReportHeadline } from "@/lib/daily-report/title";

function asText(value: unknown): string {
  if (typeof value === "string") return stripDailyReportGeneratedLabel(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) => asText(entry))
      .filter(Boolean)
      .join("、");
  }
  return "";
}

function makeNote(label: string, value: unknown): DailyReportItemNote | null {
  const text = asText(value);
  return text ? { label, text } : null;
}

function normalizeNotes(value: unknown): DailyReportItemNote[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const label = asText(record.label);
      const text = asText(record.text);
      return label && text ? { label, text } : null;
    })
    .filter((entry): entry is DailyReportItemNote => Boolean(entry));
}

function normalizeSourceIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((entry): entry is number => Number.isInteger(entry) && entry >= 1)));
}

function normalizeStructuredItem(value: unknown): DailyReportItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const title = asText(item.title);
  const body = asText(item.body);
  const notes = normalizeNotes(item.notes);
  const sourceIds = normalizeSourceIds(item.sourceIds);

  if (!title) return null;
  return {
    title,
    body,
    notes: notes.length > 0 ? notes : undefined,
    sourceIds,
  };
}

function normalizeLegacyItem(value: unknown, sectionTitle: string): DailyReportItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const title = asText(item.title ?? item.topic);
  const notes = normalizeNotes(item.notes);
  const body = sectionTitle === "安全与风险"
    ? asText(item.body) || asText(item.summary) || asText(item.reason) || asText(item.affected) || asText(item.action)
    : asText(item.body) || asText(item.summary) || asText(item.action) || asText(item.reason) || asText(item.keyNumbers);
  const sourceIds = normalizeSourceIds(item.sourceIds);

  for (const note of [
    makeNote("重点", item.whyImportant),
    sectionTitle === "安全与风险" ? makeNote("影响", item.affected) : null,
    sectionTitle === "安全与风险" ? makeNote("建议", item.action) : null,
    sectionTitle === "数据与洞察" ? makeNote("数据", item.keyNumbers) : null,
  ]) {
    if (note && !notes.some((entry) => entry.label === note.label && entry.text === note.text)) {
      notes.push(note);
    }
  }

  const knownKeys = new Set([
    "title",
    "topic",
    "body",
    "summary",
    "whyImportant",
    "action",
    "affected",
    "reason",
    "keyNumbers",
    "notes",
    "sourceIds",
  ]);
  for (const [key, rawValue] of Object.entries(item)) {
    if (knownKeys.has(key) || rawValue == null) continue;
    const note = makeNote(key, rawValue);
    if (note) notes.push(note);
  }

  if (!title || !body) return null;
  return {
    title,
    body,
    notes: notes.length > 0 ? notes : undefined,
    sourceIds,
  };
}

function normalizeBlock(value: unknown): DailyReportBlock | null {
  if (!value || typeof value !== "object") return null;
  const block = value as Record<string, unknown>;
  if (block.type === "text") {
    const title = asText(block.title);
    const body = asText(block.body);
    if (!title || !body) return null;
    const normalized: DailyReportTextBlock = {
      type: "text",
      title,
      body,
    };
    return normalized;
  }
  if (block.type === "section") {
    const title = asText(block.title);
    const items = Array.isArray(block.items)
      ? block.items.map(normalizeStructuredItem).filter((entry): entry is DailyReportItem => Boolean(entry))
      : [];
    if (!title) return null;
    return {
      type: "section",
      ...(typeof block.blockKey === "string" && block.blockKey.trim() ? { blockKey: block.blockKey.trim() } : {}),
      title,
      items,
    };
  }
  return null;
}

function legacyToBlocks(value: Record<string, unknown>): DailyReportBlock[] {
  const blocks: DailyReportBlock[] = [];
  const openingBody = asText(value.openingSummary);
  if (openingBody) {
    blocks.push({
      type: "text",
      title: asText(value.openingLabel) || DEFAULT_OPENING_LABEL,
      body: openingBody,
    });
  }

  const sections = value.sections && typeof value.sections === "object"
    ? value.sections as Record<string, unknown>
    : {};
  for (const [sectionTitle, rawItems] of Object.entries(sections)) {
    const items = Array.isArray(rawItems)
      ? rawItems.map((item) => normalizeLegacyItem(item, sectionTitle)).filter((entry): entry is DailyReportItem => Boolean(entry))
      : [];
    blocks.push({
      type: "section",
      title: sectionTitle,
      items,
    });
  }

  const closingBody = asText(value.closingThought);
  if (closingBody) {
    blocks.push({
      type: "text",
      title: asText(value.closingLabel) || DEFAULT_CLOSING_LABEL,
      body: closingBody,
    });
  }

  return blocks;
}

export function normalizeDailyReportContent(value: unknown): DailyReportContent {
  if (!value || typeof value !== "object") {
    return { blocks: [] };
  }
  const input = value as Record<string, unknown>;
  if (Array.isArray(input.blocks)) {
    const headline = normalizeDailyReportHeadline(input.headline);
    return {
      ...(headline ? { headline } : {}),
      blocks: input.blocks.map(normalizeBlock).filter((entry): entry is DailyReportBlock => Boolean(entry)),
    };
  }
  const headline = normalizeDailyReportHeadline(input.headline);
  return {
    ...(headline ? { headline } : {}),
    blocks: legacyToBlocks(input),
  };
}

function getDailyReportTextBlocks(content: DailyReportContent): DailyReportTextBlock[] {
  return content.blocks.filter((block): block is DailyReportTextBlock => block.type === "text");
}

export function getDailyReportSectionBlocks(content: DailyReportContent): DailyReportSectionBlock[] {
  return content.blocks.filter((block): block is DailyReportSectionBlock => block.type === "section");
}

export function getDailyReportOpeningSummary(content: DailyReportContent): string {
  return getDailyReportTextBlocks(content)[0]?.body ?? "";
}

export function getDailyReportClosingThought(content: DailyReportContent): string {
  const textBlocks = getDailyReportTextBlocks(content);
  return textBlocks.length > 1 ? textBlocks[textBlocks.length - 1].body : "";
}
