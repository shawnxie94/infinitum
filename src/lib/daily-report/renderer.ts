import {
  type DailyReportCandidate,
  type DailyReportContent,
} from "@/lib/daily-report/types";
import { normalizeDailyReportContent } from "@/lib/daily-report/content";
import { renderDailyReportItemBody } from "@/lib/daily-report/item-renderer";

export const DAILY_REPORT_AI_NOTICE = "声明：完全使用AI生成，可能存在错误，需谨慎甄别。";

export type DailyReportMarkdownSource = {
  sourceNumber: number;
  title: string;
  url: string;
  sourceName: string;
  publishedAt?: string | null;
  capturedAt?: string | null;
  publishedAtKnown?: boolean | null;
};

function escapeMarkdown(value: string) {
  return value.replace(/\r/g, "").trim();
}

function escapeMarkdownLinkLabel(value: string) {
  return escapeMarkdown(value).replace(/([\\`*_\[\]()])/g, "\\$1");
}

function formatSources(sourceIds: number[], sourcesByNumber: Map<number, DailyReportMarkdownSource[]>) {
  return sourceIds
    .flatMap((id) => sourcesByNumber.get(id) ?? [])
    .map((source) => `- [${escapeMarkdownLinkLabel(source.title)}](${escapeMarkdown(source.url)})（${escapeMarkdown(source.sourceName)}）`);
}

export function normalizeDailyReportSourceDateCitations(
  markdown: string,
  sources: Array<Pick<DailyReportMarkdownSource, "url" | "sourceName" | "publishedAt" | "capturedAt" | "publishedAtKnown">> = [],
) {
  let inSources = false;
  return markdown.split("\n").map((line) => {
    if (/^(?:\*\*)?来源[：:](?:\*\*)?\s*$/.test(line.trim())) {
      inSources = true;
      return line;
    }
    if (!/^\s*[-*]\s+\[/.test(line)) inSources = false;
    const matchesSource = sources.some((entry) =>
      line.includes(`](${entry.url})`) && line.includes(`（${entry.sourceName}`),
    );
    if (!inSources && !matchesSource) return line;
    return line.replace(/ · (?:发表|收录) \d{4}-\d{2}-\d{2}(?=）\s*$)/, "");
  }).join("\n");
}

export function renderDailyReportMarkdown(
  content: DailyReportContent,
  candidates: DailyReportCandidate[],
  title: string,
  sources: DailyReportMarkdownSource[] = candidates.map((candidate) => ({
    sourceNumber: candidate.id,
    title: candidate.title,
    url: candidate.url,
    sourceName: candidate.sourceName,
    publishedAt: candidate.publishedAt,
    capturedAt: candidate.createdAt,
    publishedAtKnown: candidate.publishedAtKnown ?? null,
  })),
) {
  content = normalizeDailyReportContent(content);
  const sourcesByNumber = new Map<number, DailyReportMarkdownSource[]>();
  for (const source of sources) {
    const existing = sourcesByNumber.get(source.sourceNumber) ?? [];
    if (!existing.some((entry) => entry.url === source.url)) {
      existing.push(source);
    }
    sourcesByNumber.set(source.sourceNumber, existing);
  }
  const lines: string[] = [
    `# ${escapeMarkdown(title)}`,
    "",
    `> ${DAILY_REPORT_AI_NOTICE}`,
    "",
  ];

  for (const block of content.blocks) {
    if (block.type === "text") {
      lines.push(`## ${escapeMarkdown(block.title)}`, "", block.body, "");
      continue;
    }
    if (block.items.length === 0) {
      continue;
    }
    lines.push(`## ${escapeMarkdown(block.title)}`, "");
    for (const item of block.items) {
      lines.push(`### ${escapeMarkdown(item.title)}`);
      const body = renderDailyReportItemBody(item, { formatText: escapeMarkdown });
      if (body.length > 0) {
        lines.push(...body);
      }
      const sourceLines = formatSources(item.sourceIds, sourcesByNumber);
      if (sourceLines.length > 0) {
        lines.push("", "**来源：**", ...sourceLines);
      }
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
