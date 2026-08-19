"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { PaginationControls } from "@/components/ui/pagination-controls";
import { EVENT_BRIEFING_DEFAULT_PAGE_SIZE, EVENT_BRIEFING_PAGE_SIZE_OPTIONS } from "@/lib/events/pagination";
import type { EventBriefingTag } from "@/lib/events/types";

type EventBriefingPaginationProps = {
  date: string;
  page: number;
  pageSize: number;
  channelId: string;
  tag: EventBriefingTag;
  total: number;
  totalPages: number;
};

function buildEventsHref(input: {
  date: string;
  page?: number;
  pageSize?: number;
  channelId: string;
  tag: EventBriefingTag;
}) {
  const params = new URLSearchParams();
  params.set("date", input.date);
  params.set("channel", input.channelId);

  if (input.tag !== "all") {
    params.set("tag", input.tag);
  }

  if (input.page && input.page > 1) {
    params.set("page", String(input.page));
  }

  if (input.pageSize && input.pageSize !== EVENT_BRIEFING_DEFAULT_PAGE_SIZE) {
    params.set("size", String(input.pageSize));
  }

  return `/events?${params.toString()}`;
}

export function EventBriefingPagination({
  date,
  page,
  pageSize,
  channelId,
  tag,
  total,
  totalPages,
}: EventBriefingPaginationProps) {
  const router = useRouter();
  const [jumpToPage, setJumpToPage] = useState(String(page));

  useEffect(() => {
    setJumpToPage(String(page));
  }, [page]);

  function handleJumpToPage() {
    const parsed = Number.parseInt(jumpToPage, 10);
    const nextPage = Number.isInteger(parsed)
      ? Math.max(1, Math.min(totalPages, parsed))
      : page;

    setJumpToPage(String(nextPage));
    router.push(buildEventsHref({ date, page: nextPage, pageSize, channelId, tag }));
  }

  return (
    <PaginationControls
      className="mt-2"
      totalItems={total}
      page={page}
      totalPages={totalPages}
      pageSize={pageSize}
      pageSizeOptions={EVENT_BRIEFING_PAGE_SIZE_OPTIONS}
      onPageChange={(nextPage) => {
        router.push(buildEventsHref({ date, page: nextPage, pageSize, channelId, tag }));
      }}
      onPageSizeChange={(nextPageSize) => {
        router.push(buildEventsHref({ date, pageSize: nextPageSize, channelId, tag }));
      }}
      itemLabel="条"
      jumpValue={jumpToPage}
      onJumpValueChange={setJumpToPage}
      onJump={handleJumpToPage}
    />
  );
}
