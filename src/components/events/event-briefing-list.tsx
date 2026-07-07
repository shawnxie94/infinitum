"use client";

import Link from "next/link";
import { useState } from "react";

import { recordCuratorBehaviorClient } from "@/components/curator-behavior/record";
import { EventBriefingCard } from "@/components/events/event-briefing-card";
import { EventBriefingDetailModal } from "@/components/events/event-briefing-detail-modal";
import { EventBriefingPagination } from "@/components/events/event-briefing-pagination";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { useClientAdminSession } from "@/components/ui/use-client-admin-session";
import { EVENT_BRIEFING_DEFAULT_PAGE_SIZE } from "@/lib/events/pagination";
import type { EventBriefingDTO, EventBriefingEntryDTO } from "@/lib/events/types";
import { cx } from "@/lib/ui/cx";

type EventBriefingListProps = {
  briefing: EventBriefingDTO;
  initialIsAdmin?: boolean;
  hydrateAdminClient?: boolean;
};

function buildEventsHref(input: { date: string; pageSize: number; channelId: string }) {
  const params = new URLSearchParams();
  params.set("date", input.date);
  params.set("channel", input.channelId);

  if (input.pageSize !== EVENT_BRIEFING_DEFAULT_PAGE_SIZE) {
    params.set("size", String(input.pageSize));
  }

  return `/events?${params.toString()}`;
}

export function EventBriefingList({
  briefing,
  initialIsAdmin = false,
  hydrateAdminClient = false,
}: EventBriefingListProps) {
  const isAdmin = useClientAdminSession(initialIsAdmin, hydrateAdminClient);
  const { showToast } = useToast();
  const [selectedEntry, setSelectedEntry] = useState<EventBriefingEntryDTO | null>(null);
  const [manualFeedbackState, setManualFeedbackState] = useState<{
    key: string;
    eventType: "manual_boost" | "manual_penalty";
  } | null>(null);
  const hasEntries = briefing.entries.length > 0;
  const { page, pageSize, totalPages, total } = briefing.pagination;
  const firstRank = (page - 1) * pageSize + 1;
  const shouldShowPagination = total > EVENT_BRIEFING_DEFAULT_PAGE_SIZE || totalPages > 1;
  const openEntry = (entry: EventBriefingEntryDTO) => {
    setSelectedEntry(entry);
    recordCuratorBehaviorClient({
      eventType: "event_detail_opened",
      targetType: "event",
      targetId: entry.id,
      entryType: entry.type,
      entryId: entry.id,
      clusterId: entry.type === "cluster" ? entry.id : null,
      itemId: entry.type === "single" ? entry.id : null,
    });
  };
  const recordManualFeedback = (
    entry: EventBriefingEntryDTO,
    eventType: "manual_boost" | "manual_penalty",
  ) => {
    const key = `${entry.type}:${entry.id}`;

    setManualFeedbackState({ key, eventType });
    window.setTimeout(() => {
      setManualFeedbackState((current) => (
        current?.key === key && current.eventType === eventType ? null : current
      ));
    }, 1500);
    showToast(
      eventType === "manual_boost"
        ? "已记录为更关注的事件。"
        : "已记录为降低关注的事件。",
      "info",
    );
    recordCuratorBehaviorClient({
      eventType,
      targetType: "event",
      targetId: entry.id,
      entryType: entry.type,
      entryId: entry.id,
      clusterId: entry.type === "cluster" ? entry.id : null,
      itemId: entry.type === "single" ? entry.id : null,
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header className="panel-raised rounded-sm border border-[color:var(--line)] px-3 py-3 sm:px-4">
        <h1 className="sr-only">事件速览</h1>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col">
            <nav aria-label="速览频道" className="flex flex-wrap items-center gap-1.5">
              {briefing.channels.map((channel) => {
                const isActive = briefing.channel.id === channel.id;

                return (
                  <Link
                    key={channel.id}
                    aria-current={isActive ? "page" : undefined}
                    className={cx(
                      "inline-flex h-7 items-center rounded-sm border px-2 text-xs font-medium transition",
                      isActive
                        ? "border-[var(--accent)] bg-[rgba(59,130,246,0.10)] text-[var(--accent)]"
                        : "border-[color:var(--line)] bg-[var(--surface)] text-[var(--text-3)] hover:border-[var(--accent)] hover:text-[var(--accent)]",
                    )}
                    href={buildEventsHref({
                      date: briefing.date,
                      pageSize,
                      channelId: channel.id,
                    })}
                  >
                    {channel.name} {channel.count}
                  </Link>
                );
              })}
            </nav>
          </div>
          <form action="/events" className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
            <input
              aria-label="选择日期"
              className="h-8 rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-2.5 text-sm text-[var(--text-1)] outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(59,130,246,0.18)]"
              name="date"
              type="date"
              defaultValue={briefing.date}
            />
            <input name="size" type="hidden" value={pageSize} />
            <input name="channel" type="hidden" value={briefing.channel.id} />
            <button
              className="lumina-home-action-button lumina-home-action-button--primary inline-flex h-8 items-center justify-center rounded-sm bg-[var(--accent)] px-3 text-sm font-medium text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
              type="submit"
            >
              查看
            </button>
          </form>
        </div>
      </header>

      <section
        aria-label={`速览列表，共 ${total} 条`}
        className={cx(
          "overflow-hidden rounded-sm border border-[color:var(--line)] bg-[var(--surface)]",
          hasEntries ? "divide-y divide-[color:var(--line)]" : "px-4 py-8",
        )}
      >
        {hasEntries ? (
          briefing.entries.map((entry, index) => (
            <EventBriefingCard
              key={`${entry.type}:${entry.id}`}
              entry={entry}
              rank={firstRank + index}
              isAdmin={isAdmin}
              activeManualFeedback={
                manualFeedbackState?.key === `${entry.type}:${entry.id}` ? manualFeedbackState.eventType : null
              }
              onOpen={openEntry}
              onManualFeedback={recordManualFeedback}
            />
          ))
        ) : (
          <EmptyState
            action={
              <Link className="rounded-sm bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white" href="/">
                查看主页
              </Link>
            }
          >
            当天暂无可展示的速览内容。
          </EmptyState>
        )}
      </section>

      {shouldShowPagination ? (
        <EventBriefingPagination
          date={briefing.date}
          page={page}
          pageSize={pageSize}
          channelId={briefing.channel.id}
          total={total}
          totalPages={totalPages}
        />
      ) : null}

      <EventBriefingDetailModal
        key={selectedEntry ? `${selectedEntry.type}:${selectedEntry.id}` : "empty"}
        entry={selectedEntry}
        onClose={() => setSelectedEntry(null)}
      />
    </div>
  );
}
