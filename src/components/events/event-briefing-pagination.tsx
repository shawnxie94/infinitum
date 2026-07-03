"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { PaginationControls } from "@/components/ui/pagination-controls";
import { EVENT_BRIEFING_DEFAULT_PAGE_SIZE, EVENT_BRIEFING_PAGE_SIZE_OPTIONS } from "@/lib/events/pagination";
import type { EventBriefingView } from "@/lib/events/types";

type EventBriefingPaginationProps = {
  date: string;
  page: number;
  pageSize: number;
  view: EventBriefingView;
  total: number;
  totalPages: number;
};

function buildEventsHref(input: { date: string; page?: number; pageSize?: number; view: EventBriefingView }) {
  const params = new URLSearchParams();
  params.set("date", input.date);

  if (input.page && input.page > 1) {
    params.set("page", String(input.page));
  }

  if (input.pageSize && input.pageSize !== EVENT_BRIEFING_DEFAULT_PAGE_SIZE) {
    params.set("size", String(input.pageSize));
  }

  if (input.view !== "important") {
    params.set("view", input.view);
  }

  return `/events?${params.toString()}`;
}

export function EventBriefingPagination({
  date,
  page,
  pageSize,
  view,
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
    router.push(buildEventsHref({ date, page: nextPage, pageSize, view }));
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
        router.push(buildEventsHref({ date, page: nextPage, pageSize, view }));
      }}
      onPageSizeChange={(nextPageSize) => {
        router.push(buildEventsHref({ date, pageSize: nextPageSize, view }));
      }}
      itemLabel="条"
      jumpValue={jumpToPage}
      onJumpValueChange={setJumpToPage}
      onJump={handleJumpToPage}
    />
  );
}
