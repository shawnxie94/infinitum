import type { Metadata } from "next";

import { EventBriefingList } from "@/components/events/event-briefing-list";
import { BackToTopButton } from "@/components/ui/back-to-top-button";
import { PageShell } from "@/components/ui/page-shell";
import { EVENT_BRIEFING_MAX_PAGE_SIZE } from "@/lib/events/pagination";
import { getEventBriefing } from "@/lib/events/service";
import { EVENT_BRIEFING_VIEW_VALUES, type EventBriefingView } from "@/lib/events/types";
import { listPublicHeaderLinks } from "@/lib/settings/service";
import {
  buildBreadcrumbListJsonLd,
  buildWebSiteJsonLd,
  getSiteOrigin,
  PUBLIC_ROBOTS,
  serializeJsonLd,
  SITE_NAME,
  toSeoDescription,
} from "@/lib/seo/metadata";

export const revalidate = 120;

type EventsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const EVENTS_TITLE = "事件速览";
const EVENTS_DESCRIPTION = "按日期整理 Infinitum 当天最值得优先了解的重点事件。";

function getSearchParamValue(searchParams: Record<string, string | string[] | undefined>, key: string) {
  const value = searchParams[key];
  return Array.isArray(value) ? value[0] : value;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInteger(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, EVENT_BRIEFING_MAX_PAGE_SIZE) : undefined;
}

function parseEventBriefingView(value: string | undefined): EventBriefingView {
  return EVENT_BRIEFING_VIEW_VALUES.includes(value as EventBriefingView)
    ? (value as EventBriefingView)
    : "important";
}

export async function generateMetadata({ searchParams }: EventsPageProps): Promise<Metadata> {
  const resolvedSearchParams = (await searchParams) ?? {};
  const selectedDate = getSearchParamValue(resolvedSearchParams, "date");
  const title = selectedDate ? `${EVENTS_TITLE} - ${selectedDate}` : EVENTS_TITLE;

  return {
    title,
    description: EVENTS_DESCRIPTION,
    robots: selectedDate ? { index: false, follow: true, googleBot: { index: false, follow: true } } : PUBLIC_ROBOTS,
    alternates: {
      canonical: "/events",
    },
    openGraph: {
      type: "website",
      locale: "zh_CN",
      siteName: SITE_NAME,
      title,
      description: EVENTS_DESCRIPTION,
      url: "/events",
    },
    twitter: {
      card: "summary",
      title,
      description: EVENTS_DESCRIPTION,
    },
  };
}

function buildEventsJsonLd(
  briefing: Awaited<ReturnType<typeof getEventBriefing>>,
  origin: string,
) {
  const pagePath = briefing.date ? `/events?date=${briefing.date}` : "/events";

  return {
    "@context": "https://schema.org",
    "@graph": [
      buildWebSiteJsonLd(),
      buildBreadcrumbListJsonLd([
        { name: SITE_NAME, path: "/" },
        { name: EVENTS_TITLE, path: "/events" },
      ]),
      {
        "@type": "CollectionPage",
        name: `${EVENTS_TITLE} - ${briefing.date}`,
        url: `${origin}${pagePath}`,
        inLanguage: "zh-CN",
        description: EVENTS_DESCRIPTION,
        mainEntity: {
          "@type": "ItemList",
          itemListElement: briefing.entries.map((entry, index) => ({
            "@type": "ListItem",
            position: index + 1,
            url: `${origin}${entry.detailHref}`,
            name: entry.title,
            description: toSeoDescription(entry.summary, EVENTS_DESCRIPTION),
            datePublished: entry.latestPublishedAt,
          })),
        },
      },
    ],
  };
}

export default async function EventsPage({ searchParams }: EventsPageProps) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const selectedDate = getSearchParamValue(resolvedSearchParams, "date") ?? null;
  const page = parsePositiveInteger(getSearchParamValue(resolvedSearchParams, "page"), 1);
  const pageSize = parseOptionalPositiveInteger(getSearchParamValue(resolvedSearchParams, "size"));
  const view = parseEventBriefingView(getSearchParamValue(resolvedSearchParams, "view"));
  const [briefing, headerLinks] = await Promise.all([
    getEventBriefing({ date: selectedDate, page, pageSize, view }),
    listPublicHeaderLinks(),
  ]);
  const origin = getSiteOrigin();
  const jsonLd = buildEventsJsonLd(briefing, origin);

  return (
    <PageShell
      header={{
        activeNav: "events",
        isAdmin: false,
        resolveAdminClient: true,
        customLinks: headerLinks,
      }}
      contentPaddingClassName="px-4 pt-3 pb-6 sm:px-6 sm:pt-4 sm:pb-8 lg:px-8 lg:pt-4 lg:pb-10"
      footerPath="/events"
    >
      <EventBriefingList briefing={briefing} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      <BackToTopButton />
    </PageShell>
  );
}
