import type { DailyReportDetailDTO } from "@/lib/daily-report/types";
import { normalizeDailyReportContent } from "@/lib/daily-report/content";
import { renderDailyReportItemBody } from "@/lib/daily-report/item-renderer";
import { DAILY_REPORT_AI_NOTICE, normalizeDailyReportSourceDateCitations } from "@/lib/daily-report/renderer";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasLevelTwoHeading(markdown: string, heading: string) {
  return new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m").test(markdown);
}

function buildFallbackMarkdown(report: DailyReportDetailDTO) {
  const content = normalizeDailyReportContent(report.content);
  const lines: string[] = [`> ${DAILY_REPORT_AI_NOTICE}`, ""];

  for (const block of content.blocks) {
    if (block.type === "text") {
      lines.push(`## ${block.title}`, "", block.body, "");
      continue;
    }
    if (block.items.length === 0) {
      continue;
    }
    lines.push(`## ${block.title}`, "");
    for (const item of block.items) {
      lines.push(`### ${item.title}`);
      const body = renderDailyReportItemBody(item);
      if (body.length > 0) lines.push(...body);
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function buildDailyReportDetailMarkdown(report: DailyReportDetailDTO) {
  const markdown = normalizeDailyReportSourceDateCitations(report.renderedMarkdown, report.sources).trim();
  if (!markdown) {
    return buildFallbackMarkdown(report);
  }

  const withoutTitle = markdown.replace(/^#\s+.*(?:\n|$)/, "").trimStart();
  const normalizedHeadings = withoutTitle
    .replace(/^##\s+开场摘要\s*$/m, "## 摘要")
    .replace(/^##\s+收尾观察\s*$/m, "## 趋势观察")
    .replace(/^(\s*)风险级别：[^；\n]*(?:；\s*)?/gm, "$1")
    .replace(/^(\s*)(?:摘要|开场摘要|今日观察|趋势观察|收尾观察|受影响|影响对象|建议|建议动作|行动建议)\s*[：:]\s*/gm, "$1")
    .replace(/^重点：\s*/gm, "**重点：** ")
    .replace(/^来源：\s*$/gm, "**来源：**");
  const withNotice = /^>\s*声明：完全使用AI生成，可能存在错误，需谨慎甄别。/m.test(normalizedHeadings)
    ? normalizedHeadings
    : `> ${DAILY_REPORT_AI_NOTICE}\n\n${normalizedHeadings}`;
  const content = normalizeDailyReportContent(report.content);
  const firstTitle = content.blocks[0]?.title;
  if (firstTitle && hasLevelTwoHeading(normalizedHeadings, firstTitle)) {
    return withNotice;
  }
  return withNotice;
}

export function buildDailyReportExportMarkdown(report: DailyReportDetailDTO) {
  return `# ${report.title}\n\n${buildDailyReportDetailMarkdown(report).trim()}\n`;
}
