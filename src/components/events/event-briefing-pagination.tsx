"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { PaginationControls } from "@/components/ui/pagination-controls";
import { EVENT_BRIEFING_DEFAULT_PAGE_SIZE, EVENT_BRIEFING_PAGE_SIZE_OPTIONS } from "@/lib/events/pagination";

type EventBriefingPaginationProps = {
  date: string;
  page: number;
  pageSize: number;
  channelId: string;
  total: number;
  totalPages: number;
};

function buildEventsHref(input: {
  date: string;
  page?: number;
  pageSize?: number;
  channelId: string;
}) {
  const params = new URLSearchParams();
  params.set("date", input.date);
  params.set("channel", input.channelId);

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
    router.push(buildEventsHref({ date, page: nextPage, pageSize, channelId }));
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
        router.push(buildEventsHref({ date, page: nextPage, pageSize, channelId }));
      }}
      onPageSizeChange={(nextPageSize) => {
        router.push(buildEventsHref({ date, pageSize: nextPageSize, channelId }));
      }}
      itemLabel="条"
      jumpValue={jumpToPage}
      onJumpValueChange={setJumpToPage}
      onJump={handleJumpToPage}
    />
  );
}
