import { resolveFeedRequest } from "@/lib/feed/request";
import { getCachedFeedItems } from "@/lib/feed/service";

const PUBLIC_FEED_CACHE_CONTROL = "public, s-maxage=30, stale-while-revalidate=300";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const { filters, pagination } = resolveFeedRequest(searchParams);
  const result = await getCachedFeedItems(filters, pagination);

  return Response.json(
    {
      ...result,
      range: filters.range,
      sort: filters.sort,
      start: filters.start,
      end: filters.end,
      publishedStart: filters.publishedStart,
      publishedEnd: filters.publishedEnd,
      groupId: filters.groupId,
      sourceId: filters.sourceId,
      title: filters.title,
      entryId: filters.entryId,
      entryType: filters.entryType,
      entryKeys: filters.entryKeys,
    },
    {
      headers: {
        "cache-control": PUBLIC_FEED_CACHE_CONTROL,
      },
    },
  );
}
