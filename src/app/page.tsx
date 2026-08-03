import type { Metadata } from "next";
import { headers } from "next/headers";

import { FeedPanel } from "@/components/feed/feed-panel";
import {
  getCachedFeedFilterOptions,
  getCachedFeedItems,
  getCachedLatestFetchRunSnapshot,
} from "@/lib/feed/service";
import { resolveFeedRequest } from "@/lib/feed/request";
import type { FeedEntryDTO, FeedFilters, FeedRange } from "@/lib/feed/types";
import { listPublicHeaderLinks } from "@/lib/settings/service";
import {
  buildBreadcrumbListJsonLd,
  buildWebSiteJsonLd,
  getSiteOrigin,
  PUBLIC_ROBOTS,
  serializeJsonLd,
  SITE_DEFAULT_DESCRIPTION,
  SITE_NAME,
  toSeoDescription,
} from "@/lib/seo/metadata";

export const revalidate = 30;

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};


const RANGE_LABELS: Record<FeedRange, string> = {
  today: "今日",
  "3d": "近 3 天",
  "7d": "近 7 天",
  "1m": "近 1 月",
  "1y": "近 1 年",
  all: "全部",
};

const HOME_CREATED_TIME_FILTER_KEYS = ["range", "start", "end"] as const;

function getSearchParamValue(searchParams: Record<string, string | string[] | undefined>, key: string) {
  const value = searchParams[key];
  return Array.isArray(value) ? value[0] : value;
}

function hasExplicitHomeCreatedTimeFilter(searchParams: Record<string, string | string[] | undefined>) {
  return HOME_CREATED_TIME_FILTER_KEYS.some((key) => Boolean(getSearchParamValue(searchParams, key)?.trim()));
}

function hasNonDefaultFeedFilter(filters: FeedFilters, page: number) {
  return Boolean(
    page > 1 ||
      filters.range !== "today" ||
      filters.sort !== "time_desc" ||
      filters.start ||
      filters.end ||
      filters.publishedStart ||
      filters.publishedEnd ||
      filters.groupId ||
      filters.sourceId ||
      filters.title ||
      filters.entity ||
      filters.entryId ||
      filters.entryType ||
      filters.entryKeys.length > 0,
  );
}

function buildFeedMetadataText(filters: FeedFilters) {
  const titleParts = ["资讯聚合"];

  if (filters.title) {
    titleParts.unshift(`"${filters.title}" 搜索`);
  }

  if (filters.range !== "today" || filters.start || filters.end || filters.publishedStart || filters.publishedEnd) {
    titleParts.push(RANGE_LABELS[filters.range]);
  }

  const descriptionParts = ["聚合、分析与整理来自多个来源的技术资讯。"];

  if (filters.title) {
    descriptionParts.push(`当前筛选关键词为“${filters.title}”。`);
  }

  if (filters.entity) {
    descriptionParts.push(`当前筛选实体为“${filters.entity}”。`);
  }

  if (filters.groupId || filters.sourceId) {
    descriptionParts.push("当前页面包含来源或分组筛选结果。");
  }

  return {
    title: titleParts.join(" - "),
    description: toSeoDescription(descriptionParts.join(" "), SITE_DEFAULT_DESCRIPTION),
  };
}

function getEntryUrl(entry: FeedEntryDTO) {
  if (entry.type === "single") {
    return entry.originalUrl;
  }

  return entry.itemsPreview[0]?.originalUrl ?? getSiteOrigin();
}

function buildFeedPageJsonLd(items: FeedEntryDTO[], pageUrl: string, title: string, description: string) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      buildWebSiteJsonLd(),
      buildBreadcrumbListJsonLd([{ name: SITE_NAME, path: "/" }]),
      {
        "@type": "CollectionPage",
        name: title,
        url: pageUrl,
        inLanguage: "zh-CN",
        description,
        isPartOf: {
          "@type": "WebSite",
          name: SITE_NAME,
          url: getSiteOrigin(),
        },
        mainEntity: {
          "@type": "ItemList",
          itemListElement: items.slice(0, 20).map((entry, index) => ({
            "@type": "ListItem",
            position: index + 1,
            url: getEntryUrl(entry),
            name: entry.title,
            datePublished: entry.publishedAt,
          })),
        },
      },
    ],
  };
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const resolvedSearchParams = (await searchParams) ?? {};
  const { filters, pagination } = resolveFeedRequest(resolvedSearchParams);
  const { title, description } = buildFeedMetadataText(filters);
  const isFilteredPage = hasNonDefaultFeedFilter(filters, pagination.page);

  return {
    title,
    description,
    robots: isFilteredPage
      ? {
          index: false,
          follow: true,
          googleBot: {
            index: false,
            follow: true,
          },
        }
      : PUBLIC_ROBOTS,
    alternates: {
      canonical: "/",
      types: {
        "application/rss+xml": [{ title: "Infinitum 资讯聚合 RSS", url: "/api/feed/rss" }],
      },
    },
    openGraph: {
      type: "website",
      locale: "zh_CN",
      siteName: SITE_NAME,
      title,
      description,
      url: "/",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

export default async function Home({ searchParams }: PageProps) {
  const requestHeaders = await headers();
  const resolvedSearchParams = (await searchParams) ?? {};
  const { filters, pagination } = resolveFeedRequest(resolvedSearchParams);
  const initialCreatedRangeExplicit = hasExplicitHomeCreatedTimeFilter(resolvedSearchParams);
  const [feed, latestRunSnapshot, feedFilterOptions, headerLinks] = await Promise.all([
    getCachedFeedItems(filters, pagination),
    getCachedLatestFetchRunSnapshot(),
    getCachedFeedFilterOptions(),
    listPublicHeaderLinks(),
  ]);
  const { title, description } = buildFeedMetadataText(filters);
  const pageUrl = getSiteOrigin(requestHeaders);
  const jsonLd = buildFeedPageJsonLd(feed.items, pageUrl, title, description);

  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      <FeedPanel
        initialItems={feed.items}
        initialRange={filters.range}
        initialCreatedRangeExplicit={initialCreatedRangeExplicit}
        initialSort={filters.sort}
        initialStartDate={filters.start}
        initialEndDate={filters.end}
        initialPublishedStartDate={filters.publishedStart}
        initialPublishedEndDate={filters.publishedEnd}
        initialNextCursor={feed.nextCursor}
        initialPagination={feed.pagination}
        initialStatus={latestRunSnapshot}
        isAdmin={false}
        hydrateAdminClient
        initialGroupId={filters.groupId}
        initialSourceId={filters.sourceId}
        initialTitle={filters.title}
        initialEntity={filters.entity}
        initialEntryKeys={filters.entryKeys}
        availableGroups={feed.groups}
        initialGroupTotalCount={feed.groupTotalCount}
        availableSources={feedFilterOptions.sources}
        initialHeaderLinks={headerLinks}
      />
    </main>
  );
}
