import { LLMS_SUMMARY, SITE_NAME, getSiteUrl } from "@/lib/seo/metadata";

export const revalidate = 300;

function renderLlmsTxt() {
  return [
    `# ${SITE_NAME}`,
    "",
    `> ${LLMS_SUMMARY}`,
    "",
    "## 主要入口",
    "",
    `- [首页资讯流](${getSiteUrl("/")}): 实时刷新的多源技术资讯流，支持按时间、分组、来源、实体、关键词筛选。`,
    `- [AI 日报](${getSiteUrl("/daily")}): 按日归档的 AI 日报，覆盖技术、变更、安全风险、开源工具、数据洞察等板块。`,
    `- [RSS - 资讯聚合](${getSiteUrl("/api/feed/rss")}): 实时资讯流的 RSS 输出。`,
    `- [RSS - AI 日报](${getSiteUrl("/api/daily/rss")}): AI 日报的 RSS 输出。`,
    "",
    "## 站点信息",
    "",
    "- 主要语种: 简体中文（zh-CN）",
    "- 内容更新频率: 每 30 分钟刷新资讯流；每日生成 AI 日报",
    `- 站点地址: ${getSiteUrl("/")}`,
    "- 许可说明: 内容版权归属各原始来源，请阅读来源链接",
    `- 详细全文: ${getSiteUrl("/llms-full.txt")}`,
    "",
  ].join("\n");
}

export function GET() {
  return new Response(renderLlmsTxt(), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
