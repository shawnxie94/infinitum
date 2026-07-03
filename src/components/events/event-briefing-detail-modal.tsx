"use client";

import { useState, type KeyboardEvent, type MouseEvent } from "react";

import { renderInlineMarkdown } from "@/components/ui/inline-markdown";
import { ChevronIcon } from "@/components/ui/chevron-icon";
import { ModalShell } from "@/components/ui/modal-shell";
import type { EventBriefingEntryDTO, EventBriefingItemDTO } from "@/lib/events/types";

type EventBriefingDetailModalProps = {
  entry: EventBriefingEntryDTO | null;
  onClose: () => void;
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

const cardTitleClassName = "text-xl font-semibold leading-7 text-[var(--foreground)]";
const itemTitleClassName = "text-base font-medium leading-6 text-[var(--foreground)]";
const metaRowClassName = "flex flex-wrap items-center gap-x-3 gap-y-1 overflow-hidden text-sm text-[var(--muted)]";
const neutralBadgeClassName =
  "inline-flex items-center rounded-sm border border-[color:var(--line)] bg-[var(--surface-muted)] px-2 py-1 text-xs text-[var(--muted)]";
const accentBadgeClassName =
  "inline-flex items-center rounded-sm bg-[var(--accent-soft)] px-2 py-1 text-xs text-[var(--accent-strong)]";
const metaTextClassName = "inline-flex items-center";
const summaryClassName = "text-sm leading-6 text-[var(--muted)]";

function formatMetaLabel(label: string, value: string | number) {
  return `${label}: ${value}`;
}

function buildDomId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function EventSourceItem({ item }: { item: EventBriefingItemDTO }) {
  return (
    <article className="rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-3 py-3">
      <div className="space-y-3">
        <h3 className={itemTitleClassName}>
          <a
            className="underline decoration-transparent underline-offset-4 transition hover:decoration-[var(--accent)]"
            href={item.originalUrl}
            target="_blank"
            rel="noreferrer"
          >
            {item.title}
          </a>
        </h3>
        <div className={metaRowClassName}>
          <span className={neutralBadgeClassName}>{item.qualityScore}</span>
          <span className={metaTextClassName}>{formatMetaLabel("来源", item.sourceName)}</span>
          <span className={metaTextClassName}>{formatMetaLabel("发表", formatDateTime(item.publishedAt))}</span>
        </div>
        <div className={summaryClassName}>
          {renderInlineMarkdown(item.summary)}
        </div>
      </div>
    </article>
  );
}

export function EventBriefingDetailModal({ entry, onClose }: EventBriefingDetailModalProps) {
  const [expanded, setExpanded] = useState(false);

  if (!entry) {
    return null;
  }

  const isCluster = entry.type === "cluster";
  const statusLabel = entry.isFollowUp ? "新进展" : "新事件";
  const primaryOriginalUrl = !isCluster ? entry.items[0]?.originalUrl : null;
  const sourceListId = `event-briefing-items-${buildDomId(entry.type)}-${buildDomId(entry.id)}`;
  const toggleExpanded = () => setExpanded((current) => !current);
  const handleContentClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;

    if (!isCluster || !(target instanceof Element) || target.closest("a,button")) {
      return;
    }

    toggleExpanded();
  };
  const handleContentKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isCluster || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }

    event.preventDefault();
    toggleExpanded();
  };

  return (
    <ModalShell
      isOpen={Boolean(entry)}
      onClose={onClose}
      title="事件详情"
      widthClassName="max-w-5xl"
      bodyClassName="max-h-[78vh] overflow-y-auto bg-[var(--surface)] px-4 py-5 sm:px-5 sm:py-6"
      headerClassName="border-b border-[color:var(--line)] px-4 py-3 sm:px-5"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] px-4 py-3 sm:px-5"
      footer={
        <div className="flex items-center justify-end">
          <button
            className="rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--text-2)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--text-1)]"
            type="button"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      }
    >
      <section>
        <div className="space-y-4">
          <div
            aria-controls={isCluster ? sourceListId : undefined}
            aria-expanded={isCluster ? expanded : undefined}
            aria-label={isCluster ? `${expanded ? "收起" : "展开"}聚合条目` : undefined}
            className={isCluster ? "cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.28)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]" : undefined}
            role={isCluster ? "button" : undefined}
            tabIndex={isCluster ? 0 : undefined}
            onClick={handleContentClick}
            onKeyDown={handleContentKeyDown}
          >
            <div className="space-y-4">
              <h2 className={cardTitleClassName}>
                {primaryOriginalUrl ? (
                  <a
                    className="underline decoration-transparent underline-offset-4 transition hover:text-[var(--accent)] hover:decoration-[var(--accent)]"
                    href={primaryOriginalUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {entry.title}
                  </a>
                ) : (
                  entry.title
                )}
              </h2>
              <div className={metaRowClassName}>
                <span className={accentBadgeClassName}>{entry.type === "cluster" ? "聚合" : "单篇"}</span>
                <span className={accentBadgeClassName}>{statusLabel}</span>
                <span className={neutralBadgeClassName}>{entry.rankScore}</span>
                <span className={metaTextClassName}>{formatMetaLabel("来源", `${entry.sourceCount} 个`)}</span>
                <span className={metaTextClassName}>{formatMetaLabel("条目", `${entry.itemCount} 条`)}</span>
                <span className={metaTextClassName}>{formatMetaLabel("更新", formatDateTime(entry.latestCreatedAt))}</span>
              </div>
              <div className={summaryClassName}>
                {renderInlineMarkdown(entry.summary)}
              </div>
            </div>
          </div>

          {isCluster ? (
            <div className="pt-1">
              <div className="flex items-center gap-3">
                <button
                  aria-expanded={expanded}
                  className="inline-flex shrink-0 items-center gap-1 bg-transparent px-0 py-0 text-left text-[11px] leading-none text-[var(--muted)] transition hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.28)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
                  type="button"
                  onClick={toggleExpanded}
                >
                  <ChevronIcon expanded={expanded} className="h-3.5 w-3.5" />
                  <span>{entry.items.length} 条</span>
                </button>
                <div aria-hidden="true" className="h-px flex-1 bg-[color:var(--line)]" />
              </div>
            </div>
          ) : null}

          {isCluster && expanded ? (
            <div id={sourceListId} className="space-y-2">
              {entry.items.map((item) => (
                <EventSourceItem key={item.id} item={item} />
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </ModalShell>
  );
}
