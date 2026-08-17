import type { DailyReportItem } from "@/lib/daily-report/types";

export function renderDailyReportItemBody(
  item: DailyReportItem,
  options: {
    formatText?: (value: string) => string;
  } = {},
): string[] {
  const formatText = options.formatText ?? ((value: string) => value);
  const lines: string[] = [];
  const body = typeof item.body === "string" ? item.body : "";

  if (body.trim()) {
    lines.push(formatText(body));
  }

  for (const note of item.notes ?? []) {
    if (!note.label.trim() || !note.text.trim()) continue;
    lines.push("", `**${formatText(note.label)}：** ${formatText(note.text)}`);
  }

  return lines;
}
