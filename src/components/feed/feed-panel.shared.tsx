
import { useEffect, useRef, useState, useCallback, type CSSProperties, type ReactNode } from "react";

import type { FeedQueryState } from "@/components/feed/feed-panel.types";
import type { FeedEntryDTO } from "@/lib/feed/types";
import type { GroupBadge as FeedGroupBadge } from "@/lib/groups/badge";


export function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4" />
      <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4" />
      <path d="M3 5v4h4" />
      <path d="M21 19v-4h-4" />
    </svg>
  );
}

export function openTaskDetailInNewWindow(taskRunId: string) {
  window.open(`/admin?tab=monitoring&section=tasks&task=${encodeURIComponent(taskRunId)}`, "_blank", "noopener,noreferrer");
}

export function scrollToPageTop(behavior: ScrollBehavior = "smooth") {
  window.scrollTo({ top: 0, behavior });
}

export function isInteractiveClickTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("a,button,input,select,textarea,label,[role='button']"));
}

export function getVisibleAuthorLabel(author: string | null | undefined) {
  const normalized = author?.trim();
  if (!normalized || normalized === "未知作者") return null;
  return normalized.length > 10 ? `${normalized.slice(0, 10)}...` : normalized;
}

export function GroupBadge({ group }: { group: FeedGroupBadge | null | undefined }) {
  if (!group) {
    return null;
  }

  const badgeStyle = {
    backgroundColor: `${group.color}14`,
    borderColor: `${group.color}66`,
    color: group.color,
  } satisfies CSSProperties;

  return (
    <span
      className="inline-flex items-center rounded-sm border px-2 py-1 text-[11px] font-medium"
      style={badgeStyle}
      title={`分组：${group.name}`}
    >
      <span>{group.name}</span>
    </span>
  );
}

export const READING_PROGRESS_STORAGE_KEY = "infinitum.feed.readingProgress.v1";

export type ReadingProgress = {
  filterKey: string;
  entryId: string;
  entryType: FeedEntryDTO["type"];
  page: number;
  size: number;
  updatedAt: string;
};

export function buildReadingProgressFilterKey(query: FeedQueryState) {
  return JSON.stringify({
    range: query.range,
    sort: query.sort,
    startDate: query.startDate ?? "",
    endDate: query.endDate ?? "",
    publishedStartDate: query.publishedStartDate ?? "",
    publishedEndDate: query.publishedEndDate ?? "",
    groupId: query.groupId ?? "",
    sourceId: query.sourceId ?? "",
    title: query.title ?? "",
    entryKeys: query.entryKeys,
  });
}

export function hasAdvancedQueryFilter(query: FeedQueryState) {
  return Boolean(
    query.sourceId ||
      query.title ||
      query.entryKeys.length > 0 ||
      query.publishedStartDate ||
      query.publishedEndDate,
  );
}

export function normalizeImplicitCreatedRange(query: FeedQueryState): FeedQueryState {
  if (query.createdRangeExplicit || query.startDate || query.endDate) {
    return query;
  }

  if (hasAdvancedQueryFilter(query)) {
    return query;
  }

  const nextRange = "today";

  return query.range === nextRange ? query : { ...query, range: nextRange };
}

export function buildHomeFeedQuery(): FeedQueryState {
  return {
    range: "today",
    sort: "time_desc",
    startDate: null,
    endDate: null,
    publishedStartDate: null,
    publishedEndDate: null,
    groupId: null,
    sourceId: null,
    title: null,
    entryKeys: [],
    createdRangeExplicit: false,
  };
}

export function readStoredReadingProgress(filterKey: string): ReadingProgress | null {
  try {
    const rawValue = window.localStorage.getItem(READING_PROGRESS_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue) as Partial<ReadingProgress>;
    if (
      parsed.filterKey !== filterKey ||
      typeof parsed.entryId !== "string" ||
      (parsed.entryType !== "cluster" && parsed.entryType !== "single") ||
      typeof parsed.page !== "number" ||
      typeof parsed.size !== "number" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }

    return parsed as ReadingProgress;
  } catch {
    return null;
  }
}

export function writeStoredReadingProgress(progress: ReadingProgress) {
  try {
    window.localStorage.setItem(READING_PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // localStorage may be unavailable in private or restricted browsing contexts.
  }
}

export type FullSummaryDialogState = {
  title: string;
  summary: string;
} | null;

export type SummaryTextProps = {
  title: string;
  summary: string;
  className: string;
  clickableClassName: string;
  onOpen: (state: Exclude<FullSummaryDialogState, null>) => void;
};

function renderMarkdownInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const markdownPattern = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\n]+?\*|_[^_\n]+?_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = markdownPattern.exec(text)) !== null) {
    const token = match[0];
    const start = match.index;

    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }

    if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={`${start}-strong`} className="font-semibold text-[var(--foreground)]">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <em key={`${start}-em`} className="italic text-[var(--foreground)]">
          {token.slice(1, -1)}
        </em>,
      );
    }

    lastIndex = start + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export function SummaryMarkdown({ text }: { text: string }) {
  return <>{renderMarkdownInline(text)}</>;
}

export function SummaryText({ title, summary, className, clickableClassName, onOpen }: SummaryTextProps) {
  const summaryRef = useRef<HTMLElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  const measureOverflow = useCallback(() => {
    const element = summaryRef.current;

    if (!element) {
      return;
    }

    setIsOverflowing(element.scrollHeight > element.clientHeight + 1);
  }, []);

  useEffect(() => {
    measureOverflow();

    const element = summaryRef.current;
    if (!element) {
      return;
    }

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureOverflow);
    resizeObserver?.observe(element);
    window.addEventListener("resize", measureOverflow);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureOverflow);
    };
  }, [measureOverflow, summary]);

  if (!isOverflowing) {
    return (
      <p ref={summaryRef as React.RefObject<HTMLParagraphElement>} className={className}>
        <SummaryMarkdown text={summary} />
      </p>
    );
  }

  return (
    <button
      ref={summaryRef as React.RefObject<HTMLButtonElement>}
      type="button"
      className={clickableClassName}
      onClick={() => onOpen({ title, summary })}
      title="点击查看完整摘要"
      aria-label={`查看完整摘要：${title}`}
    >
      <SummaryMarkdown text={summary} />
    </button>
  );
}
