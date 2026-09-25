import { listPublishedDailyReportsForLlmsFull } from "@/lib/daily-report/repository";
import { resolvePublicOrigin } from "@/lib/http/public-origin";
import {
  LLMS_FULL_ENTRY_LIMIT,
  LLMS_SUMMARY,
  SITE_NAME,
} from "@/lib/seo/metadata";

export const revalidate = 300;
export const dynamic = "force-dynamic";

function stripMarkdown(value: string) {
  return value
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_`>#]/g, "")
    .replace(/\r/g, "")
    .trim();
}

function urlFor(origin: string, path: string) {
  return new URL(path, origin).toString();
}

function buildScaffold(origin: string) {
  return [
    `# ${SITE_NAME} - AI 资讯聚合平台`,
    "",
    LLMS_SUMMARY,
    "",
    "## 入口",
    "",
    `- 首页资讯流: ${urlFor(origin, "/")}`,
    `- AI 日报归档: ${urlFor(origin, "/daily")}`,
    `- 资讯聚合 RSS: ${urlFor(origin, "/api/feed/rss")}`,
    `- AI 日报 RSS: ${urlFor(origin, "/api/daily/rss")}`,
    "",
    "## 站点说明",
    "",
    "- 内容更新频率: 每 30 分钟刷新资讯流；每日生成 AI 日报。",
    "- 主要语种: 简体中文（zh-CN）。",
    "- 数据源: 多源 RSS 抓取 + AI 摘要、聚类、去重。",
    "- 许可: 请阅读原始来源链接，版权归属各源。",
    "",
    `## AI 日报（最近 ${LLMS_FULL_ENTRY_LIMIT} 期）`,
    "",
  ].join("\n");
}

function buildReportBlock(origin: string, report: {
  date: string;
  title: string;
  openingSummary: string;
  generatedAt: Date;
  publishedAt: Date | null;
  renderedMarkdown: string;
  sourceCount: number;
}) {
  const lines: string[] = [
    `### ${report.date} - ${report.title}`,
    "",
    `- 发布: ${(report.publishedAt ?? report.generatedAt).toISOString()}`,
    `- 来源数: ${report.sourceCount}`,
    `- 详情页: ${urlFor(origin, `/daily/${report.date}`)}`,
    "",
  ];

  const opening = stripMarkdown(report.openingSummary);
  if (opening) {
    lines.push(opening, "");
  }

  const markdown = report.renderedMarkdown?.trim();
  if (markdown) {
    lines.push(markdown, "");
  }

  return lines.join("\n");
}

export async function GET(request: Request): Promise<Response> {
  const origin = resolvePublicOrigin(request);

  const reports = await listPublishedDailyReportsForLlmsFull(LLMS_FULL_ENTRY_LIMIT);

  const sections: string[] =
    reports.length === 0
      ? ["（暂无可用的已发布 AI 日报）", ""]
      : reports.map((report) =>
          buildReportBlock(origin, {
            date: report.date,
            title: report.title,
            openingSummary: report.openingSummary,
            generatedAt: report.generatedAt,
            publishedAt: report.publishedAt,
            renderedMarkdown: report.renderedMarkdown,
            sourceCount: report._count.sources,
          }),
        );

  const body =
    buildScaffold(origin) +
    sections.join("\n") +
    [
      "",
      "---",
      "",
      `站点: ${SITE_NAME}`,
      `URL: ${origin}`,
      `生成时间: ${new Date().toISOString()}`,
      "",
    ].join("\n");

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
