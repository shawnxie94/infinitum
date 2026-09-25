import { getCachedNewsSitemapItems } from "@/lib/feed/service";
import { SITE_NAME } from "@/lib/seo/metadata";

export const dynamic = "force-dynamic";
export const revalidate = 600;

const NEWS_WINDOW_HOURS = 48;
const NEWS_MAX_ENTRIES = 1000;

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET(): Promise<Response> {
  const since = new Date(Date.now() - NEWS_WINDOW_HOURS * 60 * 60 * 1000);
  const items = await getCachedNewsSitemapItems(since, NEWS_MAX_ENTRIES);

  const publicationName = escapeXml(SITE_NAME);
  const language = "zh";

  const entries = items
    .map((item) => {
      const title = escapeXml(item.translatedTitle || item.originalTitle);
      const link = escapeXml(item.originalUrl);
      const pubDate = (item.publishedAt ?? item.createdAt).toISOString();
      const sourceName = escapeXml(item.source.name);
      return [
        "  <url>",
        "    <loc>" + link + "</loc>",
        "    <news:news>",
        "      <news:publication>",
        "        <news:name>" + publicationName + "</news:name>",
        "        <news:language>" + language + "</news:language>",
        "      </news:publication>",
        "      <news:publication_date>" + pubDate + "</news:publication_date>",
        "      <news:title>" + title + "</news:title>",
        "      <news:source>" + sourceName + "</news:source>",
        "    </news:news>",
        "  </url>",
      ].join("\n");
    })
    .join("\n");

  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n' +
    (entries ? entries + "\n" : "") +
    "</urlset>\n";

  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, s-maxage=600, stale-while-revalidate=1200",
    },
  });
}
