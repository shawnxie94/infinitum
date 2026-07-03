"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  useCallback,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";

import { ADMIN_CLUSTER_SEARCH_DEBOUNCE_MS, STATUS_POLL_INTERVAL_MS } from "@/config/constants";
import { recordCuratorBehaviorClient } from "@/components/curator-behavior/record";
import {
  deleteItem,
  filterItem,
  joinCluster,
  mergeSelectedItems,
  queueIngestionRun,
  regenerateClusterSummary,
  requestClusterItems,
  requestClusterOptions,
  requestFeed,
  requestIngestionStatus,
  requestReanalysis,
  requestRegeneration,
} from "@/components/feed/feed-panel.api";
import { GroupFilterSidebar } from "@/components/feed/feed-panel-sidebar";
import type {
  AssignClusterDialogState,
  BatchActionDialogState,
  DateRangeValue,
  DeleteItemDialogState,
  FeedFeedback,
  FeedPanelProps,
  FeedQueryState,
  ManualFilterDialogState,
  RegenerateDialogState,
  RegenerateMode,
} from "@/components/feed/feed-panel.types";
import {
  buildFeedSearch,
  buildFallbackPagination,
  formatClusterAuthorLabel,
  formatClusterSourceLabel,
  formatDate,
  formatMetaLabel,
  formatRangeLabel,
  formatRunSummary,
  formatRunTime,
  formatScore,
  formatGroupOptionLabel,
  getAllSelectableItemIds,
  normalizeDateRange,
  normalizeOptionalId,
  normalizeSearchText,
  toDayjsRange,
} from "@/components/feed/feed-panel.utils";
import { PageShell } from "@/components/ui/page-shell";
import { BackToTopButton } from "@/components/ui/back-to-top-button";
import { ChevronIcon } from "@/components/ui/chevron-icon";
import { StatusBanner } from "@/components/ui/status-banner";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { FilterInput } from "@/components/ui/filter-input";
import { FilterSelect } from "@/components/ui/filter-select";
import { FilterSelectInline } from "@/components/ui/filter-select-inline";
import { FilterSummary } from "@/components/ui/filter-summary";
import { FormField } from "@/components/ui/form-field";
import { IconFilter, IconPlus, IconTrash } from "@/components/ui/icons";
import { ModalShell } from "@/components/ui/modal-shell";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { SelectField } from "@/components/ui/select-field";
import { TextInput } from "@/components/ui/text-input";
import { useClientAdminSession } from "@/components/ui/use-client-admin-session";
import { RANGE_OPTIONS, SORT_OPTIONS } from "@/lib/feed/range";
import type {
  ClusterDTO,
  FeedEntryKey,
  FeedClusterPreviewItemDTO,
  FeedEntryDTO,
  FeedGroupOption,
  FeedPagination,
  FeedRange,
  FeedSort,
  FeedTagOption,
  FetchRunSnapshot,
} from "@/lib/feed/types";
import { DEFAULT_FEED_PAGE_SIZE, FEED_PAGE_SIZE_OPTIONS } from "@/lib/feed/types";
import type { GroupBadge as FeedGroupBadge } from "@/lib/groups/badge";
import { cx } from "@/lib/ui/cx";
import { matchesFuzzySearch } from "@/lib/utils/search";
import { Button } from "@/components/ui/button";
import { getClusterDisplayTitle } from "@/lib/feed/cluster-display";

function SearchIcon() {
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

function RefreshIcon() {
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

function openTaskDetailInNewWindow(taskRunId: string) {
  window.open(`/admin?tab=monitoring&section=tasks&task=${encodeURIComponent(taskRunId)}`, "_blank", "noopener,noreferrer");
}

function scrollToPageTop(behavior: ScrollBehavior = "smooth") {
  window.scrollTo({ top: 0, behavior });
}

function isInteractiveClickTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("a,button,input,select,textarea,label,[role='button']"));
}

function getVisibleAuthorLabel(author: string | null | undefined) {
  const normalized = author?.trim();
  if (!normalized || normalized === "未知作者") return null;
  return normalized.length > 10 ? `${normalized.slice(0, 10)}...` : normalized;
}

function GroupBadge({ group }: { group: FeedGroupBadge | null | undefined }) {
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

const TAG_TONES = [
  { bg: "#ecfeff", border: "#06b6d4", text: "#0e7490", active: "#0891b2" },
  { bg: "#f0fdf4", border: "#22c55e", text: "#15803d", active: "#16a34a" },
  { bg: "#fff7ed", border: "#f97316", text: "#c2410c", active: "#ea580c" },
  { bg: "#f5f3ff", border: "#8b5cf6", text: "#6d28d9", active: "#7c3aed" },
  { bg: "#fef2f2", border: "#ef4444", text: "#b91c1c", active: "#dc2626" },
  { bg: "#eff6ff", border: "#3b82f6", text: "#1d4ed8", active: "#2563eb" },
  { bg: "#f0fdfa", border: "#14b8a6", text: "#0f766e", active: "#0d9488" },
  { bg: "#fdf4ff", border: "#d946ef", text: "#a21caf", active: "#c026d3" },
  { bg: "#fff1f2", border: "#fb7185", text: "#be123c", active: "#e11d48" },
  { bg: "#f7fee7", border: "#84cc16", text: "#4d7c0f", active: "#65a30d" },
  { bg: "#f8fafc", border: "#64748b", text: "#334155", active: "#475569" },
  { bg: "#eef2ff", border: "#6366f1", text: "#4338ca", active: "#4f46e5" },
  { bg: "#fffbeb", border: "#f59e0b", text: "#b45309", active: "#d97706" },
  { bg: "#faf5ff", border: "#a855f7", text: "#7e22ce", active: "#9333ea" },
  { bg: "#f0f9ff", border: "#0ea5e9", text: "#0369a1", active: "#0284c7" },
  { bg: "#fefce8", border: "#eab308", text: "#a16207", active: "#ca8a04" },
  { bg: "#f1f5f9", border: "#475569", text: "#1e293b", active: "#334155" },
  { bg: "#ecfdf5", border: "#10b981", text: "#047857", active: "#059669" },
  { bg: "#fdf2f8", border: "#ec4899", text: "#be185d", active: "#db2777" },
  { bg: "#f4f4f5", border: "#71717a", text: "#3f3f46", active: "#52525b" },
];
const POPULAR_TAG_DISPLAY_LIMIT = 32;
type TagButtonStyle = CSSProperties & {
  "--tag-accent": string;
  "--tag-bg": string;
  "--tag-bg-hover": string;
  "--tag-border": string;
  "--tag-border-hover": string;
  "--tag-text": string;
  "--tag-active-bg": string;
  "--tag-active-border": string;
  "--tag-active-text": string;
};

function getTagToneKey(value: string) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % TAG_TONES.length;
}

function getTagButtonStyle(option: FeedTagOption, index: number): TagButtonStyle {
  const tone = TAG_TONES[(getTagToneKey(option.normalized) + index * 7) % TAG_TONES.length] ?? TAG_TONES[0];

  return {
    "--tag-accent": tone.border,
    "--tag-bg": tone.bg,
    "--tag-bg-hover": `color-mix(in srgb, ${tone.border} 14%, #ffffff)`,
    "--tag-border": `${tone.border}66`,
    "--tag-border-hover": `${tone.border}99`,
    "--tag-text": tone.text,
    "--tag-active-bg": tone.active,
    "--tag-active-border": tone.active,
    "--tag-active-text": "#ffffff",
  };
}

function PopularTagButton({
  option,
  toneIndex,
  isActive,
  disabled,
  onSelect,
}: {
  option: FeedTagOption;
  toneIndex: number;
  isActive: boolean;
  disabled: boolean;
  onSelect: (tag: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(option.normalized)}
      disabled={disabled}
      aria-pressed={isActive}
      aria-label={`筛选标签：${option.name}，${option.count} 条`}
      title={`${option.name} ${option.count}`}
      style={getTagButtonStyle(option, toneIndex)}
      className={cx(
        "popular-tag-button inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 text-xs font-semibold transition",
        "hover:shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.28)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none",
        isActive ? "shadow-[var(--shadow-sm)]" : "",
      )}
    >
      <span>{option.name}</span>
      <span className="shrink-0 text-[11px] font-bold opacity-75">{option.count}</span>
    </button>
  );
}

const READING_PROGRESS_STORAGE_KEY = "infinitum.feed.readingProgress.v1";

type ReadingProgress = {
  filterKey: string;
  entryId: string;
  entryType: FeedEntryDTO["type"];
  page: number;
  size: number;
  updatedAt: string;
};

type PopularTagLayoutRow = {
  keys: string[];
  shouldDistribute: boolean;
};

function buildReadingProgressFilterKey(query: FeedQueryState) {
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
    tag: query.tag ?? "",
    entryKeys: query.entryKeys,
  });
}

function hasAdvancedQueryFilter(query: FeedQueryState) {
  return Boolean(
    query.sourceId ||
      query.title ||
      query.tag ||
      query.entryKeys.length > 0 ||
      query.publishedStartDate ||
      query.publishedEndDate,
  );
}

function normalizeImplicitCreatedRange(query: FeedQueryState): FeedQueryState {
  if (query.createdRangeExplicit || query.startDate || query.endDate) {
    return query;
  }

  if (hasAdvancedQueryFilter(query)) {
    return query;
  }

  const nextRange = "today";

  return query.range === nextRange ? query : { ...query, range: nextRange };
}

function buildHomeFeedQuery(): FeedQueryState {
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
    tag: null,
    entryKeys: [],
    createdRangeExplicit: false,
  };
}

function readStoredReadingProgress(filterKey: string): ReadingProgress | null {
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

function writeStoredReadingProgress(progress: ReadingProgress) {
  try {
    window.localStorage.setItem(READING_PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // localStorage may be unavailable in private or restricted browsing contexts.
  }
}

type FullSummaryDialogState = {
  title: string;
  summary: string;
} | null;

type SummaryTextProps = {
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

function SummaryMarkdown({ text }: { text: string }) {
  return <>{renderMarkdownInline(text)}</>;
}

function SummaryText({ title, summary, className, clickableClassName, onOpen }: SummaryTextProps) {
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

export function FeedPanel({
  initialItems,
  initialRange,
  initialCreatedRangeExplicit = true,
  initialSort,
  initialStartDate,
  initialEndDate,
  initialPublishedStartDate = null,
  initialPublishedEndDate = null,
  initialNextCursor = null,
  initialPagination = null,
  initialStatus,
  isAdmin: initialIsAdmin,
  hydrateAdminClient = false,
  initialGroupId = null,
  initialSourceId = null,
  initialTitle = null,
  initialTag = null,
  initialEntryKeys = [],
  availableGroups = [],
  initialGroupTotalCount,
  availableSources = [],
  popularTags: initialPopularTags = [],
  initialHeaderLinks = [],
}: FeedPanelProps) {
  const router = useRouter();
  const isAdmin = useClientAdminSession(initialIsAdmin, hydrateAdminClient);
  const fallbackInitialPagination: FeedPagination = initialPagination ?? buildFallbackPagination(initialItems, initialNextCursor);
  const [items, setItems] = useState(initialItems);
  const [pagination, setPagination] = useState<FeedPagination>(fallbackInitialPagination);
  const [jumpToPage, setJumpToPage] = useState(String(fallbackInitialPagination.page));
  const [range, setRange] = useState<FeedRange>(initialRange);
  const [createdRangeExplicit, setCreatedRangeExplicit] = useState(initialCreatedRangeExplicit);
  const [sort, setSort] = useState<FeedSort>(initialSort);
  const [startDate, setStartDate] = useState<string | null>(initialStartDate);
  const [endDate, setEndDate] = useState<string | null>(initialEndDate);
  const [publishedStartDate, setPublishedStartDate] = useState<string | null>(initialPublishedStartDate);
  const [publishedEndDate, setPublishedEndDate] = useState<string | null>(initialPublishedEndDate);
  const [groupId, setGroupId] = useState<string | null>(normalizeOptionalId(initialGroupId));
  const [sourceId, setSourceId] = useState<string | null>(normalizeOptionalId(initialSourceId));
  const [titleInput, setTitleInput] = useState<string>(normalizeSearchText(initialTitle) ?? "");
  const [titleFilter, setTitleFilter] = useState<string | null>(normalizeSearchText(initialTitle));
  const [tag, setTag] = useState<string | null>(normalizeOptionalId(initialTag));
  const [entryKeys, setEntryKeys] = useState<FeedEntryKey[]>(initialEntryKeys);
  const [status, setStatus] = useState<FetchRunSnapshot | null>(initialStatus);
  const [groups, setGroups] = useState<FeedGroupOption[]>(availableGroups);
  const [popularTags, setPopularTags] = useState<FeedTagOption[]>(initialPopularTags);
  const [groupTotalCount, setGroupTotalCount] = useState<number>(
    initialGroupTotalCount ?? fallbackInitialPagination.total,
  );
  const [queuedRefreshAt, setQueuedRefreshAt] = useState<string | null>(null);
  const [expandedClusters, setExpandedClusters] = useState<Record<string, FeedClusterPreviewItemDTO[]>>({});
  const [openClusters, setOpenClusters] = useState<Record<string, boolean>>({});
  const [isPending, startTransition] = useTransition();
  const [refreshFeedback, setRefreshFeedback] = useState<FeedFeedback | null>(null);
  const [regenerateDialog, setRegenerateDialog] = useState<RegenerateDialogState>(null);
  const [regenerateMode, setRegenerateMode] = useState<RegenerateMode>("summary");
  const [assignClusterDialog, setAssignClusterDialog] = useState<AssignClusterDialogState>(null);
  const [manualFilterDialog, setManualFilterDialog] = useState<ManualFilterDialogState>(null);
  const [deleteItemDialog, setDeleteItemDialog] = useState<DeleteItemDialogState>(null);
  const [batchActionDialog, setBatchActionDialog] = useState<BatchActionDialogState>(null);
  const [fullSummaryDialog, setFullSummaryDialog] = useState<FullSummaryDialogState>(null);
  const [batchRegenerateMode, setBatchRegenerateMode] = useState<RegenerateMode>("summary");
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [clusterOptions, setClusterOptions] = useState<ClusterDTO[]>([]);
  const [clusterSearch, setClusterSearch] = useState("");
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [isLoadingClusterOptions, setIsLoadingClusterOptions] = useState(false);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(
    Boolean(initialStartDate || initialEndDate || initialPublishedStartDate || initialPublishedEndDate || initialSourceId || initialTitle),
  );
  const [popularTagLayoutRows, setPopularTagLayoutRows] = useState<PopularTagLayoutRow[]>([]);
  const [readingProgress, setReadingProgress] = useState<ReadingProgress | null>(null);
  const [isReadingProgressHidden, setIsReadingProgressHidden] = useState(false);
  const [pendingRestoreEntryId, setPendingRestoreEntryId] = useState<string | null>(null);
  const progressWriteTimerRef = useRef<number | null>(null);
  const lastSavedProgressRef = useRef<string | null>(null);
  const pendingScrollToTopRef = useRef(false);
  const popularTagListRef = useRef<HTMLDivElement | null>(null);
  const initialQuery: FeedQueryState = {
    range: initialRange,
    sort: initialSort,
    startDate: initialStartDate,
    endDate: initialEndDate,
    publishedStartDate: initialPublishedStartDate,
    publishedEndDate: initialPublishedEndDate,
    groupId: normalizeOptionalId(initialGroupId),
    sourceId: normalizeOptionalId(initialSourceId),
    title: normalizeSearchText(initialTitle),
    tag: normalizeOptionalId(initialTag),
    entryKeys: initialEntryKeys,
    createdRangeExplicit: initialCreatedRangeExplicit,
  };
  const [appliedQuery, setAppliedQuery] = useState<FeedQueryState>(initialQuery);
  const latestQueryRef = useRef<FeedQueryState>(initialQuery);
  const visibleSources = useMemo(
    () => availableSources.filter((source) => (!groupId ? true : source.groupId === groupId)),
    [availableSources, groupId],
  );
  const currentPage = pagination.page;
  const pageSize = pagination.size;
  const total = pagination.total;
  const totalPages = pagination.totalPages;
  const shouldShowPagination = total > 0;
  const readingProgressFilterKey = useMemo(
    () => buildReadingProgressFilterKey({
      range: appliedQuery.range,
      sort: appliedQuery.sort,
      startDate: appliedQuery.startDate,
      endDate: appliedQuery.endDate,
      publishedStartDate: appliedQuery.publishedStartDate,
      publishedEndDate: appliedQuery.publishedEndDate,
      groupId: appliedQuery.groupId,
      sourceId: appliedQuery.sourceId,
      title: appliedQuery.title,
      tag: appliedQuery.tag,
      entryKeys: appliedQuery.entryKeys,
    }),
    [appliedQuery],
  );

  const summary = useMemo(
    () => ({
      rangeLabel: formatRangeLabel(range, startDate, endDate),
      publishedRangeLabel:
        publishedStartDate || publishedEndDate ? formatRangeLabel("all", publishedStartDate, publishedEndDate) : null,
      sortLabel: SORT_OPTIONS.find((option) => option.value === sort)?.label ?? "按时间倒序",
    }),
    [endDate, publishedEndDate, publishedStartDate, range, sort, startDate],
  );
  const activeFilterSummary = useMemo(() => {
    const filters = [`创建时间：${summary.rangeLabel}`, `排序：${summary.sortLabel}`];

    if (summary.publishedRangeLabel) {
      filters.push(`发表时间：${summary.publishedRangeLabel}`);
    }

    if (titleFilter) {
      filters.push(`搜索：${titleFilter}`);
    }

    if (groupId) {
      filters.push(`分组：${availableGroups.find((group) => group.id === groupId)?.name ?? groupId}`);
    }

    if (sourceId) {
      filters.push(`信息源：${availableSources.find((source) => source.id === sourceId)?.name ?? sourceId}`);
    }

    if (tag) {
      filters.push(`标签：${popularTags.find((option) => option.normalized === tag)?.name ?? tag}`);
    }

    if (entryKeys.length > 0) {
      filters.push(`精确筛选：${entryKeys.length} 条`);
    }

    return filters;
  }, [
    availableGroups,
    availableSources,
    entryKeys.length,
    groupId,
    popularTags,
    sourceId,
    summary.publishedRangeLabel,
    summary.rangeLabel,
    summary.sortLabel,
    tag,
    titleFilter,
  ]);
  const visiblePopularTags = useMemo(() => {
    return popularTags.slice(0, POPULAR_TAG_DISPLAY_LIMIT);
  }, [popularTags]);

  useEffect(() => {
    const element = popularTagListRef.current;

    if (!element || visiblePopularTags.length === 0) {
      setPopularTagLayoutRows([]);
      return;
    }

    const measure = () => {
      const children = Array.from(element.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      );
      if (element.clientWidth <= 0 || children.length === 0) {
        setPopularTagLayoutRows([]);
        return;
      }

      const computedStyle = window.getComputedStyle(element);
      const gap = Number.parseFloat(computedStyle.columnGap || computedStyle.gap || "0") || 0;
      const visibleRowTops = [...new Set(children.map((child) => child.offsetTop))].sort((left, right) => left - right).slice(0, 2);
      const visibleRows = visibleRowTops.map((rowTop) => children.filter((child) => child.offsetTop === rowTop));
      const nextRows = visibleRows.map((row) => {
        const keys = row.map((child) => child.dataset.tagKey).filter((key): key is string => Boolean(key));
        const rowWidth = row.reduce((sum, child) => sum + child.offsetWidth, 0)
          + Math.max(0, row.length - 1) * gap;
        const remainingWidth = element.clientWidth - rowWidth;
        const lastChild = row.at(-1);
        const nextChild = lastChild ? children[children.indexOf(lastChild) + 1] : undefined;
        const nextTagFitWidth = nextChild ? nextChild.offsetWidth + gap : 0;
        const shouldDistribute = keys.length > 1 && nextTagFitWidth > 0 && remainingWidth < nextTagFitWidth;

        return { keys, shouldDistribute };
      });

      setPopularTagLayoutRows((current) => JSON.stringify(current) === JSON.stringify(nextRows) ? current : nextRows);
    };

    measure();

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resizeObserver?.observe(element);
    window.addEventListener("resize", measure);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [visiblePopularTags]);
  const visiblePopularTagRows = useMemo(() => {
    if (popularTagLayoutRows.length === 0) {
      return [];
    }

    const optionByKey = new Map(visiblePopularTags.map((option) => [option.normalized, option]));
    const rows = popularTagLayoutRows
      .map((row) => ({
        options: row.keys.map((key) => optionByKey.get(key)).filter((option): option is FeedTagOption => Boolean(option)),
        shouldDistribute: row.shouldDistribute,
      }))
      .filter((row) => row.options.length > 0);

    return rows;
  }, [popularTagLayoutRows, visiblePopularTags]);
  const visibleClusterOptions = useMemo(() => {
    return clusterOptions.filter((cluster) => {
      if (cluster.status !== "active") {
        return false;
      }

      if (assignClusterDialog?.currentClusterId && cluster.id === assignClusterDialog.currentClusterId) {
        return false;
      }

      return matchesFuzzySearch(clusterSearch, [
        getClusterDisplayTitle(cluster),
        cluster.title,
        cluster.summary,
        cluster.items[0]?.title,
        cluster.items[0]?.originalTitle,
      ]);
    });
  }, [assignClusterDialog?.currentClusterId, clusterOptions, clusterSearch]);

  const resetExpandedClusterState = useCallback(() => {
    setExpandedClusters({});
    setOpenClusters({});
  }, []);

  const replaceFeedData = useCallback((nextItems: FeedEntryDTO[], nextPagination: FeedPagination) => {
    setItems(nextItems);
    setPagination(nextPagination);
    resetExpandedClusterState();
  }, [resetExpandedClusterState]);

  const syncUrlWithQuery = useCallback((query: FeedQueryState, page?: number, size?: number) => {
    const search = buildFeedSearch(query, { page, size });
    const newUrl = `${window.location.pathname}?${search}`;
    window.history.replaceState(null, "", newUrl);
  }, []);

  const loadFeed = useCallback((
    query: FeedQueryState,
    page = 1,
    size = pageSize,
    options?: {
      scrollToTop?: boolean;
      includePopularTags?: boolean;
      replaceUrl?: string;
    },
  ) => {
    const normalizedQuery = normalizeImplicitCreatedRange(query);

    if (options?.scrollToTop) {
      pendingScrollToTopRef.current = true;
      setPendingRestoreEntryId(null);
    }

    if (normalizedQuery.range !== query.range) {
      setRange(normalizedQuery.range);
    }

    latestQueryRef.current = normalizedQuery;
    setAppliedQuery(normalizedQuery);
    if (options?.replaceUrl) {
      window.history.replaceState(null, "", options.replaceUrl);
    } else {
      syncUrlWithQuery(normalizedQuery, page, size);
    }
    startTransition(async () => {
      const payload = await requestFeed(normalizedQuery, {
        page,
        size,
        includePopularTags: options?.includePopularTags,
      });
      replaceFeedData(payload.items, payload.pagination);
      setGroups(payload.groups ?? availableGroups);
      if (payload.popularTags) {
        setPopularTags(payload.popularTags);
      }
      setGroupTotalCount(payload.groupTotalCount ?? payload.pagination.total);
      setRefreshFeedback(null);

      if (pendingScrollToTopRef.current) {
        pendingScrollToTopRef.current = false;
        window.requestAnimationFrame(() => scrollToPageTop("auto"));
      }
    });
  }, [pageSize, availableGroups, syncUrlWithQuery, replaceFeedData]);

  const resetHomeFeed = useCallback(() => {
    const homeQuery = buildHomeFeedQuery();

    setRange(homeQuery.range);
    setCreatedRangeExplicit(false);
    setSort(homeQuery.sort);
    setStartDate(homeQuery.startDate);
    setEndDate(homeQuery.endDate);
    setPublishedStartDate(homeQuery.publishedStartDate);
    setPublishedEndDate(homeQuery.publishedEndDate);
    setGroupId(homeQuery.groupId);
    setSourceId(homeQuery.sourceId);
    setTitleInput("");
    setTitleFilter(homeQuery.title);
    setTag(homeQuery.tag);
    setEntryKeys(homeQuery.entryKeys);
    setAdvancedFiltersOpen(false);
    setSelectedItems(new Set());

    loadFeed(homeQuery, 1, DEFAULT_FEED_PAGE_SIZE, {
      scrollToTop: true,
      includePopularTags: true,
      replaceUrl: "/",
    });
  }, [loadFeed]);

  const buildQuery = (overrides: Partial<FeedQueryState> = {}): FeedQueryState => ({
    range,
    sort,
    startDate,
    endDate,
    publishedStartDate,
    publishedEndDate,
    groupId,
    sourceId,
    title: titleFilter,
    tag,
    entryKeys,
    createdRangeExplicit,
    ...overrides,
  });

  const updateRange = (nextRange: FeedRange) => {
    setRange(nextRange);
    setCreatedRangeExplicit(true);
    setStartDate(null);
    setEndDate(null);
  };

  const changeSort = (nextSort: FeedSort) => {
    setSort(nextSort);
  };

  const changeGroup = (nextGroupId: string) => {
    const normalizedGroupId = normalizeOptionalId(nextGroupId);
    const nextSourceId =
      normalizedGroupId && sourceId && !availableSources.some((source) => source.id === sourceId && source.groupId === normalizedGroupId)
        ? null
        : sourceId;

    setGroupId(normalizedGroupId);
    setSourceId(nextSourceId);
    loadFeed(buildQuery({ groupId: normalizedGroupId, sourceId: nextSourceId }), 1, pageSize, { scrollToTop: true });
  };

  const changeSource = (nextSourceId: string) => {
    const normalizedSourceId = normalizeOptionalId(nextSourceId);
    setSourceId(normalizedSourceId);
  };

  const changeDateRange = (nextRange: DateRangeValue) => {
    const { startDate: normalizedStartDate, endDate: normalizedEndDate } = normalizeDateRange(nextRange);

    setStartDate(normalizedStartDate);
    setEndDate(normalizedEndDate);
    setCreatedRangeExplicit(true);
  };

  const changePublishedDateRange = (nextRange: DateRangeValue) => {
    const { startDate: normalizedStartDate, endDate: normalizedEndDate } = normalizeDateRange(nextRange);

    setPublishedStartDate(normalizedStartDate);
    setPublishedEndDate(normalizedEndDate);
  };

  const applyFilters = () => {
    loadFeed(buildQuery(), 1, pageSize, { scrollToTop: true });
  };

  const clearFilters = () => {
    setRange("today");
    setCreatedRangeExplicit(false);
    setSort("time_desc");
    setStartDate(null);
    setEndDate(null);
    setPublishedStartDate(null);
    setPublishedEndDate(null);
    setGroupId(null);
    setSourceId(null);
    setTitleInput("");
    setTitleFilter(null);
    setTag(null);
    setEntryKeys([]);
  };

  const toggleTag = (nextTag: string) => {
    const normalizedTag = normalizeOptionalId(nextTag);
    const selectedTag = normalizedTag && normalizedTag !== tag ? normalizedTag : null;
    setTag(selectedTag);
    loadFeed(buildQuery({ tag: selectedTag }), 1, pageSize, { scrollToTop: true });
  };

  const refresh = () => {
    if (!isAdmin || status?.status === "running" || queuedRefreshAt) {
      return;
    }

    startTransition(async () => {
      try {
        const queuedAt = new Date().toISOString();
        const result = await queueIngestionRun();

        if (!result.ok || result.data.error) {
          setRefreshFeedback({ tone: "error", message: result.data.error ?? "创建抓取任务失败，请稍后重试。" });
          return;
        }

        if (!result.data.taskRun) {
          setRefreshFeedback({ tone: "error", message: "未返回后台任务信息。" });
          return;
        }

        setQueuedRefreshAt(queuedAt);
        setRefreshFeedback({ tone: "success", message: "抓取任务已进入队列，等待后台执行。" });
        router.push(
          `/admin?tab=monitoring&section=tasks&task=${encodeURIComponent(result.data.taskRun.id)}`,
        );
      } catch {
        setRefreshFeedback({ tone: "error", message: "创建抓取任务失败，请稍后重试。" });
      }
    });
  };

  const reloadCurrentFeed = () => {
    startTransition(async () => {
      const payload = await requestFeed(latestQueryRef.current, {
        page: currentPage,
        size: pageSize,
        includePopularTags: currentPage === 1,
      });
      replaceFeedData(payload.items, payload.pagination);
      setGroups(payload.groups ?? availableGroups);
      if (payload.popularTags) {
        setPopularTags(payload.popularTags);
      }
      setGroupTotalCount(payload.groupTotalCount ?? payload.pagination.total);
    });
  };

  const openAssignClusterDialog = (itemId: string, itemTitle: string, currentClusterId?: string | null) => {
    setAssignClusterDialog({
      itemId,
      itemTitle,
      currentClusterId: currentClusterId ?? null,
    });
    setClusterSearch("");
    setSelectedClusterId(null);
    setIsLoadingClusterOptions(true);
  };

  useEffect(() => {
    if (!assignClusterDialog) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setIsLoadingClusterOptions(true);
      startTransition(async () => {
        try {
          const result = await requestClusterOptions(clusterSearch);

          if (cancelled) {
            return;
          }

          if (!result.ok || result.data.error) {
            setRefreshFeedback({
              tone: "error",
              message: result.data.error ?? "加载聚合组选项失败，请稍后重试。",
            });
            setAssignClusterDialog(null);
            return;
          }

          setClusterOptions(result.data.clusters ?? []);
        } catch {
          if (!cancelled) {
            setRefreshFeedback({
              tone: "error",
              message: "加载聚合组选项失败，请稍后重试。",
            });
            setAssignClusterDialog(null);
          }
        } finally {
          if (!cancelled) {
            setIsLoadingClusterOptions(false);
          }
        }
      });
    }, clusterSearch.trim() ? ADMIN_CLUSTER_SEARCH_DEBOUNCE_MS : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [assignClusterDialog, clusterSearch]);

  const confirmAssignCluster = () => {
    if (!assignClusterDialog || !selectedClusterId) {
      return;
    }

    const { itemId } = assignClusterDialog;
    setAssignClusterDialog(null);

    startTransition(async () => {
      try {
        const result = await joinCluster(itemId, selectedClusterId);

        if (!result.ok || result.data.error) {
          setRefreshFeedback({
            tone: "error",
            message: result.data.error ?? "加入聚合组失败，请稍后重试。",
          });
          return;
        }

        reloadCurrentFeed();
        setRefreshFeedback({
          tone: "success",
          message: "已加入聚合组。",
        });
      } catch {
        setRefreshFeedback({
          tone: "error",
          message: "加入聚合组失败，请稍后重试。",
        });
      }
    });
  };

  const confirmManualFilter = () => {
    if (!manualFilterDialog) {
      return;
    }

    const { itemId } = manualFilterDialog;
    setManualFilterDialog(null);

    startTransition(async () => {
      try {
        const result = await filterItem(itemId);

        if (!result.ok || result.data.error) {
          setRefreshFeedback({
            tone: "error",
            message: result.data.error ?? "手动过滤失败，请稍后重试。",
          });
          return;
        }

        reloadCurrentFeed();
        setRefreshFeedback({
          tone: "success",
          message: "已手动过滤该内容。",
        });
      } catch {
        setRefreshFeedback({
          tone: "error",
          message: "手动过滤失败，请稍后重试。",
        });
      }
    });
  };

  const confirmDeleteItem = () => {
    if (!deleteItemDialog) {
      return;
    }

    const { itemId } = deleteItemDialog;
    setDeleteItemDialog(null);

    startTransition(async () => {
      try {
        const result = await deleteItem(itemId);

        if (!result.ok || result.data.error) {
          setRefreshFeedback({
            tone: "error",
            message: result.data.error ?? "删除内容失败，请稍后重试。",
          });
          return;
        }

        reloadCurrentFeed();
        setRefreshFeedback({
          tone: "success",
          message: "已删除该内容。",
        });
      } catch {
        setRefreshFeedback({
          tone: "error",
          message: "删除内容失败，请稍后重试。",
        });
      }
    });
  };

  const runRegeneration = (targets: Array<"translation" | "summary">) => {
    if (!regenerateDialog) {
      return;
    }

    const { itemId, shouldAnnounceClusterRefresh } = regenerateDialog;
    setRegenerateDialog(null);

    startTransition(async () => {
      const createdTaskRunIds: string[] = [];

      for (const target of targets) {
        const result = await requestRegeneration(itemId, target);

        if (!result.ok || result.data.error) {
          setRefreshFeedback({ tone: "error", message: result.data.error ?? "创建重新生成任务失败，请稍后重试。" });
          return;
        }

        if (!result.data.taskRun) {
          setRefreshFeedback({ tone: "error", message: "未返回后台任务信息。" });
          return;
        }

        createdTaskRunIds.push(result.data.taskRun.id);
      }

      const primaryTaskRunId = createdTaskRunIds[0];
      if (!primaryTaskRunId) {
        setRefreshFeedback({ tone: "error", message: "未返回后台任务信息。" });
        return;
      }

      openTaskDetailInNewWindow(primaryTaskRunId);

      if (shouldAnnounceClusterRefresh) {
        setRefreshFeedback(null);
      }
    });
  };

  const runReanalysis = () => {
    if (!regenerateDialog) {
      return;
    }

    const { itemId, shouldAnnounceClusterRefresh } = regenerateDialog;
    setRegenerateDialog(null);

    startTransition(async () => {
      const result = await requestReanalysis(itemId);

      if (!result.ok || result.data.error) {
        setRefreshFeedback({ tone: "error", message: result.data.error ?? "创建重新 AI 判定任务失败，请稍后重试。" });
        return;
      }

      if (!result.data.taskRun) {
        setRefreshFeedback({ tone: "error", message: "未返回后台任务信息。" });
        return;
      }

      openTaskDetailInNewWindow(result.data.taskRun.id);

      if (shouldAnnounceClusterRefresh) {
        setRefreshFeedback(null);
      }
    });
  };

  const openRegenerateDialog = (
    itemId: string,
    canRegenerateTranslation: boolean,
    options?: {
      shouldAnnounceClusterRefresh?: boolean;
    },
  ) => {
    setRegenerateDialog({
      itemId,
      canRegenerateTranslation,
      shouldAnnounceClusterRefresh: options?.shouldAnnounceClusterRefresh ?? false,
    });
    setRegenerateMode("summary");
  };

  const confirmRegeneration = () => {
    if (!regenerateDialog) {
      return;
    }

    if (regenerateMode === "reanalyze") {
      runReanalysis();
      return;
    }

    if (regenerateMode === "translation") {
      runRegeneration(["translation"]);
      return;
    }

    if (regenerateMode === "both") {
      runRegeneration(["translation", "summary"]);
      return;
    }

    runRegeneration(["summary"]);
  };

  const toggleCluster = (clusterId: string) => {
    startTransition(async () => {
      const nextOpen = !openClusters[clusterId];

      if (nextOpen && !expandedClusters[clusterId]) {
        const clusterItems = await requestClusterItems(clusterId, latestQueryRef.current);
        setExpandedClusters((current) => ({
          ...current,
          [clusterId]: clusterItems,
        }));
      }

      setOpenClusters((current) => ({
        ...current,
        [clusterId]: nextOpen,
      }));
    });
  };

  const handleClusterCardClick = (event: MouseEvent<HTMLElement>, clusterId: string) => {
    if (isPending || isInteractiveClickTarget(event.target)) {
      return;
    }

    toggleCluster(clusterId);
  };

  // 重新生成聚合摘要
  const handleRegenerateClusterSummary = async (clusterId: string) => {
    startTransition(async () => {
      try {
        const result = await regenerateClusterSummary(clusterId);

        if (!result.ok || result.data.error) {
          setRefreshFeedback({ tone: "error", message: result.data.error ?? "创建聚合摘要重生成任务失败，请稍后重试。" });
          return;
        }

        if (!result.data.taskRun) {
          setRefreshFeedback({ tone: "error", message: "未返回后台任务信息。" });
          return;
        }

        setRefreshFeedback({ tone: "success", message: "聚合摘要重生成任务已进入队列。" });
        openTaskDetailInNewWindow(result.data.taskRun.id);
      } catch {
        setRefreshFeedback({ tone: "error", message: "创建聚合摘要重生成任务失败，请稍后重试。" });
      }
    });
  };
  const allSelectableItemIds = useMemo(() => getAllSelectableItemIds(items), [items]);

  const handleToggleSelect = (itemId: string) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedItems.size === allSelectableItemIds.length && allSelectableItemIds.length > 0) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(allSelectableItemIds));
    }
  };

  const handleClearSelection = () => {
    setSelectedItems(new Set());
  };

  const openBatchRegenerateDialog = () => {
    if (selectedItems.size === 0) return;
    setBatchActionDialog({
      type: "regenerate",
      itemIds: Array.from(selectedItems),
      itemTitles: [],
    });
    setBatchRegenerateMode("summary");
  };

  const openBatchFilterDialog = () => {
    if (selectedItems.size === 0) return;
    setBatchActionDialog({
      type: "filter",
      itemIds: Array.from(selectedItems),
      itemTitles: [],
    });
  };

  const openBatchDeleteDialog = () => {
    if (selectedItems.size === 0) return;
    setBatchActionDialog({
      type: "delete",
      itemIds: Array.from(selectedItems),
      itemTitles: [],
    });
  };

  const openBatchMergeDialog = () => {
    if (selectedItems.size < 2) return;
    setBatchActionDialog({
      type: "merge",
      itemIds: Array.from(selectedItems),
      itemTitles: [],
    });
  };

  const runBatchRegeneration = async (targets: Array<"translation" | "summary">) => {
    if (!batchActionDialog || batchActionDialog.type !== "regenerate") return;

    const itemIds = batchActionDialog.itemIds;
    const results = { success: 0, failed: 0 };

    for (const itemId of itemIds) {
      for (const target of targets) {
        try {
          const result = await requestRegeneration(itemId, target);
          if (result.ok && !result.data.error && result.data.taskRun) {
            results.success++;
          } else {
            results.failed++;
          }
        } catch {
          results.failed++;
        }
      }
    }

    setBatchActionDialog(null);

    if (results.failed === 0) {
      setRefreshFeedback({
        tone: "success",
        message: `已成功为 ${itemIds.length} 条内容创建重新生成任务。`,
      });
    } else {
      setRefreshFeedback({
        tone: "error",
        message: `批量重新生成完成：成功 ${results.success} 条，失败 ${results.failed} 条。`,
      });
    }

    setSelectedItems(new Set());
  };

  const confirmBatchRegeneration = () => {
    if (batchRegenerateMode === "translation") {
      runBatchRegeneration(["translation"]);
    } else if (batchRegenerateMode === "both") {
      runBatchRegeneration(["translation", "summary"]);
    } else {
      runBatchRegeneration(["summary"]);
    }
  };

  const confirmBatchFilter = async () => {
    if (!batchActionDialog || batchActionDialog.type !== "filter") return;

    const itemIds = batchActionDialog.itemIds;
    const results = { success: 0, failed: 0 };

    for (const itemId of itemIds) {
      try {
        const result = await filterItem(itemId);
        if (result.ok && !result.data.error) {
          results.success++;
        } else {
          results.failed++;
        }
      } catch {
        results.failed++;
      }
    }

    setBatchActionDialog(null);
    reloadCurrentFeed();

    if (results.failed === 0) {
      setRefreshFeedback({
        tone: "success",
        message: `已成功过滤 ${results.success} 条内容。`,
      });
    } else {
      setRefreshFeedback({
        tone: "error",
        message: `批量过滤完成：成功 ${results.success} 条，失败 ${results.failed} 条。`,
      });
    }

    setSelectedItems(new Set());
  };

  const confirmBatchDelete = async () => {
    if (!batchActionDialog || batchActionDialog.type !== "delete") return;

    const itemIds = batchActionDialog.itemIds;
    const results = { success: 0, failed: 0 };

    for (const itemId of itemIds) {
      try {
        const result = await deleteItem(itemId);
        if (result.ok && !result.data.error) {
          results.success++;
        } else {
          results.failed++;
        }
      } catch {
        results.failed++;
      }
    }

    setBatchActionDialog(null);
    reloadCurrentFeed();

    if (results.failed === 0) {
      setRefreshFeedback({
        tone: "success",
        message: `已成功删除 ${results.success} 条内容。`,
      });
    } else {
      setRefreshFeedback({
        tone: "error",
        message: `批量删除完成：成功 ${results.success} 条，失败 ${results.failed} 条。`,
      });
    }

    setSelectedItems(new Set());
  };

  const confirmBatchMerge = async () => {
    if (!batchActionDialog || batchActionDialog.type !== "merge") return;

    const itemIds = batchActionDialog.itemIds;

    try {
      const result = await mergeSelectedItems(itemIds);

      if (!result.ok || result.data.error || !result.data.result) {
        setRefreshFeedback({
          tone: "error",
          message: result.data.error ?? "批量合并失败，请稍后重试。",
        });
        return;
      }

      setBatchActionDialog(null);
      reloadCurrentFeed();
      setRefreshFeedback({
        tone: "success",
        message: `已将 ${result.data.result.itemsMoved} 条内容合并到「${result.data.result.targetClusterTitle}」。`,
      });
      setSelectedItems(new Set());
    } catch {
      setRefreshFeedback({
        tone: "error",
        message: "批量合并失败，请稍后重试。",
      });
    }
  };

  useEffect(() => {
    const progress = readStoredReadingProgress(readingProgressFilterKey);
    setReadingProgress(progress);
    setIsReadingProgressHidden(false);
    lastSavedProgressRef.current = progress
      ? `${progress.filterKey}:${progress.entryId}:${progress.page}:${progress.size}`
      : null;
  }, [readingProgressFilterKey]);

  useEffect(() => {
    if (items.length === 0 || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observedElements = Array.from(
      document.querySelectorAll<HTMLElement>("[data-feed-entry-id][data-feed-entry-type]"),
    );

    if (observedElements.length === 0) {
      return;
    }

    const saveVisibleProgress = () => {
      if (window.scrollY < 80 && currentPage === 1) {
        return;
      }

      const viewportHeight = window.innerHeight;
      const visibleElement = observedElements
        .map((element) => ({
          element,
          rect: element.getBoundingClientRect(),
        }))
        .filter(({ rect }) => rect.bottom > 80 && rect.top < viewportHeight * 0.7)
        .sort((a, b) => Math.abs(a.rect.top - 120) - Math.abs(b.rect.top - 120))[0]?.element;

      const entryId = visibleElement?.dataset.feedEntryId;
      const entryType = visibleElement?.dataset.feedEntryType;

      if (!entryId || (entryType !== "cluster" && entryType !== "single")) {
        return;
      }

      const progressKey = `${readingProgressFilterKey}:${entryId}:${currentPage}:${pageSize}`;
      if (progressKey === lastSavedProgressRef.current) {
        return;
      }

      const progress: ReadingProgress = {
        filterKey: readingProgressFilterKey,
        entryId,
        entryType,
        page: currentPage,
        size: pageSize,
        updatedAt: new Date().toISOString(),
      };

      lastSavedProgressRef.current = progressKey;
      setReadingProgress(progress);
      writeStoredReadingProgress(progress);
    };

    const scheduleSave = () => {
      if (progressWriteTimerRef.current !== null) {
        window.clearTimeout(progressWriteTimerRef.current);
      }

      progressWriteTimerRef.current = window.setTimeout(saveVisibleProgress, 350);
    };

    const observer = new IntersectionObserver(scheduleSave, {
      root: null,
      rootMargin: "-10% 0px -45% 0px",
      threshold: [0, 0.25, 0.5, 0.75],
    });

    observedElements.forEach((element) => observer.observe(element));
    window.addEventListener("scroll", scheduleSave, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", scheduleSave);
      if (progressWriteTimerRef.current !== null) {
        window.clearTimeout(progressWriteTimerRef.current);
        progressWriteTimerRef.current = null;
      }
    };
  }, [currentPage, items, pageSize, readingProgressFilterKey]);

  useEffect(() => {
    if (!pendingRestoreEntryId || isPending) {
      return;
    }

    const target = document.querySelector<HTMLElement>(
      `[data-feed-entry-id="${CSS.escape(pendingRestoreEntryId)}"]`,
    );

    if (!target) {
      setRefreshFeedback({
        tone: "info",
        message: "上次阅读的内容位置已变化，已为你打开保存的页码。",
      });
      setPendingRestoreEntryId(null);
      return;
    }

    window.setTimeout(() => {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.focus({ preventScroll: true });
    }, 50);
    setPendingRestoreEntryId(null);
  }, [isPending, items, pendingRestoreEntryId]);

  useEffect(() => {
    if (!isAdmin) {
      return;
    }

    if (status?.status !== "running" && !queuedRefreshAt) {
      return;
    }

    const timer = window.setInterval(() => {
      startTransition(async () => {
        const payload = await requestIngestionStatus();

        if (!payload.run) {
          return;
        }

        if (queuedRefreshAt) {
          const runStartedAt = new Date(payload.run.startedAt).getTime();
          const queuedAt = new Date(queuedRefreshAt).getTime();

          if (runStartedAt < queuedAt) {
            return;
          }
        }

        setStatus(payload.run);

        if (payload.run.status === "running") {
          setQueuedRefreshAt(null);
          return;
        }

        setQueuedRefreshAt(null);
        const feedPayload = await requestFeed(latestQueryRef.current, { page: 1, size: pageSize });
        setItems(feedPayload.items);
        setPagination(feedPayload.pagination);
        setGroups(feedPayload.groups ?? availableGroups);
        if (feedPayload.popularTags) {
          setPopularTags(feedPayload.popularTags);
        }
        setGroupTotalCount(feedPayload.groupTotalCount ?? feedPayload.pagination.total);
        resetExpandedClusterState();
        setRefreshFeedback({
          tone: payload.run.status === "succeeded" || payload.run.status === "partial" ? "success" : "error",
          message:
            payload.run.status === "succeeded" || payload.run.status === "partial"
              ? "抓取完成，已重新载入当前时间范围。"
              : "抓取失败，请稍后重试。",
        });
      });
    }, STATUS_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [availableGroups, isAdmin, pageSize, queuedRefreshAt, resetExpandedClusterState, startTransition, status]);

  useEffect(() => {
    setJumpToPage(String(currentPage));
  }, [currentPage]);

  const handlePageSizeChange = (value: unknown) => {
    const nextSize = Number(value);
    if (!FEED_PAGE_SIZE_OPTIONS.includes(nextSize as (typeof FEED_PAGE_SIZE_OPTIONS)[number])) {
      return;
    }
    loadFeed(latestQueryRef.current, 1, nextSize, { scrollToTop: true, includePopularTags: false });
  };

  const handleJumpToPage = () => {
    const nextPage = Number.parseInt(jumpToPage, 10);
    if (!Number.isFinite(nextPage)) {
      setJumpToPage(String(currentPage));
      return;
    }

    const normalizedPage = Math.min(Math.max(1, nextPage), totalPages);
    if (normalizedPage === currentPage) {
      setJumpToPage(String(normalizedPage));
      return;
    }

    loadFeed(latestQueryRef.current, normalizedPage, pageSize, { scrollToTop: true, includePopularTags: false });
  };

  const resumeReadingProgress = () => {
    if (!readingProgress || isPending) {
      return;
    }

    setIsReadingProgressHidden(true);
    const restoredPage = Math.min(Math.max(1, readingProgress.page), totalPages || readingProgress.page);
    setPendingRestoreEntryId(readingProgress.entryId);

    if (restoredPage === currentPage && readingProgress.size === pageSize) {
      const target = document.querySelector<HTMLElement>(
        `[data-feed-entry-id="${CSS.escape(readingProgress.entryId)}"]`,
      );

      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        target.focus({ preventScroll: true });
        setPendingRestoreEntryId(null);
        return;
      }
    }

    loadFeed(latestQueryRef.current, restoredPage, readingProgress.size, { includePopularTags: false });
  };

  const neutralBadgeClassName =
    "inline-flex items-center rounded-sm border border-[color:var(--line)] bg-[var(--surface-muted)] px-2 py-1 text-xs text-[var(--muted)]";
  const denseCardClassName =
    "w-full min-w-0 overflow-hidden rounded-lg border border-[color:var(--line)] bg-[var(--surface)] px-4 py-4 shadow-[var(--shadow-sm)] transition hover:border-[color:var(--line-strong)] hover:shadow-md sm:px-6 sm:py-5";
  const cardMetaRowClassName = "flex items-center gap-x-3 overflow-hidden text-sm text-[var(--muted)]";
  const cardSummaryClassName = "line-clamp-5 text-sm leading-6 text-[var(--muted)]";
  const clickableCardSummaryClassName =
    "line-clamp-5 w-full cursor-pointer bg-transparent p-0 text-left text-sm leading-6 text-[var(--muted)] transition hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]";
  const cardTitleClassName = "text-xl font-semibold leading-7 text-[var(--foreground)]";
  const metaTextClassName = "inline-flex items-center";
  const iconButtonClassName =
    "feed-card-icon-button inline-flex items-center justify-center rounded-sm border border-transparent bg-transparent p-1.5 text-[var(--text-2)] transition hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/35 disabled:cursor-not-allowed disabled:opacity-50";
  const clusterToggleClassName =
    "inline-flex shrink-0 items-center gap-1 bg-transparent px-0 py-0 text-left text-[11px] leading-none text-[var(--muted)] transition hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.28)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-55";
  const hasClearableFilters = activeFilterSummary.length > 0;
  const latestRunSummary = formatRunSummary(status);
  const latestRunTime = formatRunTime(status);
  const isRefreshDisabled =
    isPending || status?.status === "running" || Boolean(queuedRefreshAt);
  const renderSummary = (title: string, summaryText: string) => (
    <SummaryText
      title={title}
      summary={summaryText}
      className={cardSummaryClassName}
      clickableClassName={clickableCardSummaryClassName}
      onOpen={setFullSummaryDialog}
    />
  );
  return (
    <PageShell
      header={{
        activeNav: "home",
        isAdmin,
        onHomeClick: resetHomeFeed,
        customLinks: initialHeaderLinks,
      }}
      footerPath="/"
      contentClassName="gap-5 sm:gap-6"
      contentPaddingClassName="px-4 pt-3 pb-6 sm:px-6 sm:pt-4 sm:pb-8 lg:px-8 lg:pt-4 lg:pb-10"
      sidebarContainerClassName={cx(
        "flex-shrink-0",
        "lg:w-56",
      )}
      sidebarVisibility="lg"
      sidebar={
        <GroupFilterSidebar
          groups={groups}
          totalCount={groupTotalCount}
          selectedGroupId={groupId}
          onSelect={changeGroup}
        />
      }
    >
      <section className="grid w-full min-w-0 gap-4">
        {visiblePopularTags.length > 0 ? (
          <section
            role="region"
            aria-label="热门标签"
            className="w-full min-w-0"
          >
            <div className="relative w-full min-w-0">
              <div
                ref={popularTagListRef}
                aria-hidden="true"
                className="pointer-events-none invisible absolute inset-x-0 top-0 flex w-full min-w-0 flex-wrap items-center justify-start gap-1.5 overflow-visible"
              >
                {visiblePopularTags.map((option, index) => {
                  return (
                    <span
                      key={option.normalized}
                      data-tag-key={option.normalized}
                      style={getTagButtonStyle(option, index)}
                      className="popular-tag-button inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 text-xs font-semibold"
                    >
                      <span>{option.name}</span>
                      <span className="shrink-0 text-[11px] font-bold opacity-75">{option.count}</span>
                    </span>
                  );
                })}
              </div>
              {visiblePopularTagRows.length === 0 ? (
                <div className="flex max-h-[4.375rem] w-full min-w-0 flex-wrap items-center gap-1.5 overflow-hidden">
                  {visiblePopularTags.map((option, index) => {
                    const isActive = option.normalized === tag;

                    return (
                      <PopularTagButton
                        key={option.normalized}
                        option={option}
                        toneIndex={index}
                        isActive={isActive}
                        disabled={isPending}
                        onSelect={toggleTag}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="grid max-h-[4.375rem] w-full min-w-0 gap-1.5 overflow-hidden">
                  {visiblePopularTagRows.map((row, rowIndex) => (
                    <div
                      key={`popular-tag-row-${rowIndex}`}
                      className={cx(
                        "flex h-8 w-full min-w-0 items-center gap-1.5 overflow-hidden",
                        row.shouldDistribute ? "lg:justify-between" : "justify-start",
                      )}
                    >
                      {row.options.map((option, index) => {
                        const isActive = option.normalized === tag;
                        const toneIndex = visiblePopularTags.findIndex((tagOption) => tagOption.normalized === option.normalized);

                        return (
                          <PopularTagButton
                            key={option.normalized}
                            option={option}
                            toneIndex={toneIndex >= 0 ? toneIndex : index}
                            isActive={isActive}
                            disabled={isPending}
                            onSelect={toggleTag}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        ) : null}

        <section
          role="region"
          aria-label="信息流筛选"
          className="panel-raised w-full min-w-0 overflow-hidden rounded-sm border border-[color:var(--line)] px-4 py-3 sm:px-6 sm:py-4"
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-2 lg:flex-1 lg:flex-nowrap">
                <button
                  aria-expanded={advancedFiltersOpen}
                  className={cx(
                    "lumina-home-action-button inline-flex whitespace-nowrap px-4 py-1 text-sm rounded-sm transition",
                    advancedFiltersOpen
                      ? "lumina-home-action-button--active bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                      : "bg-[var(--bg-muted)] text-[var(--text-2)] hover:bg-[var(--surface)]",
                  )}
                  type="button"
                  onClick={() => setAdvancedFiltersOpen((current) => !current)}
                >
                  <span className="inline-flex items-center gap-2">
                    <SearchIcon />
                    <span>高级筛选</span>
                  </span>
                </button>
                {isAdmin ? (
                  <button
                    type="button"
                    onClick={refresh}
                    disabled={isRefreshDisabled}
                    className="lumina-home-action-button lumina-home-action-button--primary inline-flex items-center justify-center whitespace-nowrap rounded-sm bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="inline-flex items-center gap-2">
                      <RefreshIcon />
                      <span>立即更新</span>
                    </span>
                  </button>
                ) : null}
                {isAdmin ? (
                  <span className="min-w-0 text-sm text-[var(--text-2)] lg:truncate">
                    {latestRunSummary}
                  </span>
                ) : latestRunTime ? (
                  <span className="min-w-0 text-sm text-[var(--text-2)] lg:truncate">
                    更新时间：{latestRunTime}
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-2 lg:flex-nowrap lg:justify-end lg:pl-4">
                <FilterSelectInline
                  label="创建时间："
                  ariaLabel="创建时间"
                  value={range}
                  onChange={(value) => updateRange(value as FeedRange)}
                  options={RANGE_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  showSearch={false}
                />

                <FilterSelectInline
                  label="排序："
                  ariaLabel="排序方式"
                  value={sort}
                  onChange={(value) => changeSort(value as FeedSort)}
                  options={SORT_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  showSearch={false}
                />
              </div>
            </div>

            <div className="lg:hidden">
              <div className="rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-3 py-2.5 shadow-[var(--shadow-sm)]">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-sm font-medium text-[var(--foreground)]">分组筛选</span>
                  <FilterSelectInline
                    label="分组："
                    ariaLabel="移动端分组筛选"
                    value={groupId ?? ""}
                    onChange={changeGroup}
                    options={[
                      { value: "", label: formatGroupOptionLabel("全部内容", groupTotalCount) },
                      ...groups.map((group) => ({
                        value: group.id,
                        label: formatGroupOptionLabel(group.name, group.count),
                      })),
                    ]}
                    showSearch={false}
                  />
                </div>
              </div>
            </div>

            {advancedFiltersOpen ? (
              <div className="border-t border-[color:var(--line)] pt-3">
                <div className="grid gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FilterInput
                      id="feed-title-filter"
                      label="全文搜索"
                      value={titleInput}
                      onChange={(value) => {
                        setTitleInput(value);
                        setTitleFilter(normalizeSearchText(value));
                      }}
                      placeholder="输入搜索关键词"
                    />

                    <FilterSelect
                      id="feed-source-filter"
                      label="信息源"
                      ariaLabel="信息源"
                      value={sourceId ?? ""}
                      onChange={changeSource}
                      showSearch
                      options={[
                        { value: "", label: "全部信息源" },
                        ...visibleSources.map((source) => ({
                          value: source.id,
                          label: source.name,
                        })),
                      ]}
                    />
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label="创建时间" htmlFor="feed-created-date-range">
                      <DateRangePicker
                        id="feed-created-date-range"
                        value={toDayjsRange(startDate, endDate)}
                        onChange={changeDateRange}
                        className="w-full"
                      />
                    </FormField>

                    <FormField label="发表时间" htmlFor="feed-published-date-range">
                      <DateRangePicker
                        id="feed-published-date-range"
                        value={toDayjsRange(publishedStartDate, publishedEndDate)}
                        onChange={changePublishedDateRange}
                        className="w-full"
                      />
                    </FormField>
                  </div>
                </div>
              </div>
            ) : null}

            <FilterSummary
              items={activeFilterSummary}
              onClear={clearFilters}
              canClear={hasClearableFilters && !isPending}
              actions={
                <button
                  type="button"
                  onClick={applyFilters}
                  disabled={isPending}
                  className="lumina-home-action-button lumina-home-action-button--primary inline-flex items-center justify-center rounded-sm bg-[var(--accent)] px-3 py-1 text-sm font-medium text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <SearchIcon />
                    <span>查询</span>
                  </span>
                </button>
              }
              details={null}
              className="pt-3"
            />

            {/* 批量操作工具栏 */}
            {isAdmin && selectedItems.size > 0 && (
              <div className="border-t border-[color:var(--line)] pt-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-[var(--text-2)]">
                      已选 {selectedItems.size} 条
                    </span>
                    <button
                      type="button"
                      onClick={handleClearSelection}
                      className="text-sm text-[var(--muted)] hover:text-[var(--text-1)] transition"
                    >
                      清空选择
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={openBatchRegenerateDialog}
                      disabled={isPending}
                      className="inline-flex items-center gap-1 rounded-sm bg-[var(--bg-muted)] px-3 py-1.5 text-sm font-medium text-[var(--text-2)] transition hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      重新生成
                    </button>
                    <button
                      type="button"
                      onClick={openBatchMergeDialog}
                      disabled={isPending || selectedItems.size < 2}
                      className="inline-flex items-center gap-1 rounded-sm bg-[var(--bg-muted)] px-3 py-1.5 text-sm font-medium text-[var(--text-2)] transition hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      批量合并
                    </button>
                    <button
                      type="button"
                      onClick={openBatchFilterDialog}
                      disabled={isPending}
                      className="inline-flex items-center gap-1 rounded-sm bg-[var(--bg-muted)] px-3 py-1.5 text-sm font-medium text-[var(--text-2)] transition hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      批量过滤
                    </button>
                    <button
                      type="button"
                      onClick={openBatchDeleteDialog}
                      disabled={isPending}
                      className="inline-flex items-center gap-1 rounded-sm bg-[var(--danger-surface)] px-3 py-1.5 text-sm font-medium text-[var(--danger-ink)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      批量删除
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {refreshFeedback ? (
          <StatusBanner className="rounded-[1.1rem]" tone={refreshFeedback.tone}>
            {refreshFeedback.message}
          </StatusBanner>
        ) : null}

        <section role="region" aria-label="信息流结果" className="min-w-0 space-y-2.5">
          {/* 全选按钮（仅管理员可见） */}
          {isAdmin && items.length > 0 && (
            <div className="flex items-center gap-2 px-1">
              <input
                type="checkbox"
                id="select-all-items"
                checked={selectedItems.size > 0 && selectedItems.size === allSelectableItemIds.length}
                onChange={handleSelectAll}
                className="h-4 w-4 rounded border-[color:var(--line)] text-[var(--accent)] focus:ring-[var(--accent)]"
              />
              <label htmlFor="select-all-items" className="text-sm text-[var(--text-2)] cursor-pointer">
                批量选择 ({selectedItems.size}/{allSelectableItemIds.length})
              </label>
            </div>
          )}

          {items.length === 0 ? (
            <div className="rounded-[1.15rem] border border-dashed border-[color:var(--line-strong)] bg-[color-mix(in_srgb,var(--surface)_80%,transparent)] px-5 py-8 text-sm leading-7 text-[var(--muted)] shadow-[var(--shadow-sm)]">
              {isAdmin
                ? "当前时间范围内还没有可展示内容，可以先点击“立即更新”拉取数据。"
                : "当前时间范围内还没有可展示内容，请稍后再回来看看。"}
            </div>
          ) : (
            items.map((entry) =>
              entry.type === "cluster" ? (
                <article
                  key={entry.id}
                  data-feed-entry-id={entry.id}
                  data-feed-entry-type={entry.type}
                  tabIndex={-1}
                  className={denseCardClassName}
                >
                  {/* 聚合条目头部 */}
                  <div
                    className="flex cursor-pointer items-start gap-3"
                    onClick={(event) => handleClusterCardClick(event, entry.id)}
                  >
                    {isAdmin && (
                      <div className="flex flex-col gap-1 pt-1">
                        <input
                          type="checkbox"
                          checked={entry.itemsPreview.every((item) => selectedItems.has(item.id))}
                          onChange={() => {
                            const ids = entry.itemsPreview.map((item) => item.id);
                            const allSelected = ids.every((id) => selectedItems.has(id));
                            setSelectedItems((prev) => {
                              const next = new Set(prev);
                              if (allSelected) {
                                ids.forEach((id) => next.delete(id));
                              } else {
                                ids.forEach((id) => next.add(id));
                              }
                              return next;
                            });
                          }}
                          className="h-4 w-4 rounded border-[color:var(--line)] text-[var(--accent)] focus:ring-[var(--accent)]"
                        />
                      </div>
                    )}
                    <div className="flex-1 space-y-3">
                      {/* 标题行：左侧标题，右侧投票按钮 + 管理按钮 */}
                      <div className="flex items-start justify-between gap-3">
                        <h2 className={cardTitleClassName}>{entry.title}</h2>
                        <div className="flex shrink-0 items-center gap-0.5">
                          {/* 重新生成聚合摘要按钮（仅管理员可见） */}
                          {isAdmin ? (
                            <button
                              type="button"
                              onClick={() => handleRegenerateClusterSummary(entry.id)}
                              disabled={isPending}
                              className={iconButtonClassName}
                              title="重新生成聚合摘要"
                              aria-label={`重新生成聚合摘要：${entry.title}`}
                            >
                              <RefreshIcon />
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div className={cardMetaRowClassName}>
                        <span className="rounded-sm bg-[var(--accent-soft)] px-2 py-1 text-[11px] text-[var(--accent-strong)]">聚合</span>
                        <GroupBadge group={entry.group} />
                        <span className={neutralBadgeClassName}>{formatScore(entry.score)}</span>
                        <span className={metaTextClassName}>{formatMetaLabel("来源", formatClusterSourceLabel(entry))}</span>
                        {getVisibleAuthorLabel(formatClusterAuthorLabel(entry)) ? (
                          <span className={`${metaTextClassName} min-w-0 truncate`}>
                            {formatMetaLabel("作者", getVisibleAuthorLabel(formatClusterAuthorLabel(entry)) ?? "")}
                          </span>
                        ) : null}
                        <span className={metaTextClassName}>{formatMetaLabel("发表", formatDate(entry.latestPublishedAt))}</span>
                      </div>
                      {renderSummary(entry.title, entry.summary)}
                      <div className="mt-4">
                        <div className="flex items-center gap-3">
                          <button
                            aria-label={openClusters[entry.id] ? "收起相关内容" : "展开相关内容"}
                            aria-expanded={Boolean(openClusters[entry.id])}
                            className={clusterToggleClassName}
                            type="button"
                            onClick={() => toggleCluster(entry.id)}
                            disabled={isPending}
                          >
                            <ChevronIcon expanded={Boolean(openClusters[entry.id])} className="h-3.5 w-3.5" />
                            <span>{entry.itemCount} 条</span>
                          </button>
                          <div aria-hidden="true" className="h-px flex-1 bg-[color:var(--line)]" />
                        </div>
                      </div>
                    </div>
                  </div>

                  {openClusters[entry.id] ? (
                    <div className="mt-3 space-y-2">
                      {(expandedClusters[entry.id] ?? entry.itemsPreview).map((clusterItem) => (
                        <div
                          key={clusterItem.id}
                          className="rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-3 py-3"
                        >
                          <div className="flex items-start gap-3">
                            {isAdmin && (
                              <input
                                type="checkbox"
                                checked={selectedItems.has(clusterItem.id)}
                                onChange={() => handleToggleSelect(clusterItem.id)}
                                className="mt-1 h-4 w-4 rounded border-[color:var(--line)] text-[var(--accent)] focus:ring-[var(--accent)]"
                              />
                            )}
                            <div className="flex-1 space-y-2">
                              <div className="flex items-start justify-between gap-3">
                                <a
                                  className="block min-w-0 flex-1 text-base font-medium leading-6 text-[var(--foreground)] underline decoration-transparent underline-offset-4 transition hover:decoration-[var(--accent)]"
                                  href={clusterItem.originalUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={() => recordCuratorBehaviorClient({
                                    eventType: "feed_item_opened",
                                    targetType: "item",
                                    targetId: clusterItem.id,
                                    itemId: clusterItem.id,
                                  })}
                                >
                                  {clusterItem.title}
                                </a>
                                {isAdmin ? (
                                  <div className="flex shrink-0 items-center gap-0.5">
                                    <button
                                      aria-label={`加入聚合组：${clusterItem.title}`}
                                      title="加入聚合组"
                                      className={iconButtonClassName}
                                      type="button"
                                      onClick={() => openAssignClusterDialog(clusterItem.id, clusterItem.title, entry.id)}
                                      disabled={isPending}
                                    >
                                      <IconPlus className="h-4 w-4" />
                                    </button>
                                    <button
                                      aria-label={`手动过滤：${clusterItem.title}`}
                                      title="手动过滤"
                                      className={iconButtonClassName}
                                      type="button"
                                      onClick={() =>
                                        setManualFilterDialog({ itemId: clusterItem.id, itemTitle: clusterItem.title })
                                      }
                                      disabled={isPending}
                                    >
                                      <IconFilter className="h-4 w-4" />
                                    </button>
                                    <button
                                      aria-label={`重新生成内容：${clusterItem.title}`}
                                      title="重新生成内容"
                                      className={iconButtonClassName}
                                      type="button"
                                      onClick={() =>
                                        openRegenerateDialog(clusterItem.id, Boolean(clusterItem.canRegenerateTranslation), {
                                          shouldAnnounceClusterRefresh: true,
                                        })
                                      }
                                      disabled={isPending}
                                    >
                                      <RefreshIcon />
                                    </button>
                                    <button
                                      aria-label={`删除内容：${clusterItem.title}`}
                                      title="删除内容"
                                      className={iconButtonClassName}
                                      type="button"
                                      onClick={() =>
                                        setDeleteItemDialog({ itemId: clusterItem.id, itemTitle: clusterItem.title })
                                      }
                                      disabled={isPending}
                                    >
                                      <IconTrash className="h-4 w-4" />
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                              <div className={cardMetaRowClassName}>
                                <GroupBadge group={clusterItem.group} />
                                <span className={neutralBadgeClassName}>{formatScore(clusterItem.score)}</span>
                                <span className={metaTextClassName}>{formatMetaLabel("来源", clusterItem.sourceName)}</span>
                                {getVisibleAuthorLabel(clusterItem.author) ? (
                                  <span className={`${metaTextClassName} min-w-0 truncate`}>
                                    {formatMetaLabel("作者", getVisibleAuthorLabel(clusterItem.author) ?? "")}
                                  </span>
                                ) : null}
                                <span className={metaTextClassName}>{formatMetaLabel("发表", formatDate(clusterItem.publishedAt))}</span>
                              </div>
                              {renderSummary(clusterItem.title, clusterItem.summary)}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              ) : (
                <article
                  key={entry.id}
                  data-feed-entry-id={entry.id}
                  data-feed-entry-type={entry.type}
                  tabIndex={-1}
                  className={denseCardClassName}
                >
                  <div className="flex items-start gap-3">
                    {isAdmin && (
                      <input
                        type="checkbox"
                        checked={selectedItems.has(entry.id)}
                        onChange={() => handleToggleSelect(entry.id)}
                        className="mt-1 h-4 w-4 rounded border-[color:var(--line)] text-[var(--accent)] focus:ring-[var(--accent)]"
                      />
                    )}
                    <div className="flex-1 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <h2 className={cx(cardTitleClassName, "min-w-0 flex-1")}>
                          <a
                            className="underline decoration-transparent underline-offset-4 transition hover:decoration-[var(--accent)]"
                            href={entry.originalUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={() => recordCuratorBehaviorClient({
                              eventType: "feed_item_opened",
                              targetType: "item",
                              targetId: entry.id,
                              itemId: entry.id,
                            })}
                          >
                            {entry.title}
                          </a>
                        </h2>
                        <div className="flex shrink-0 items-center gap-0.5">
                          {isAdmin ? (
                            <>
                              <button
                                aria-label={`加入聚合组：${entry.title}`}
                                title="加入聚合组"
                                className={iconButtonClassName}
                                type="button"
                                onClick={() => openAssignClusterDialog(entry.id, entry.title)}
                                disabled={isPending}
                              >
                                <IconPlus className="h-4 w-4" />
                              </button>
                              <button
                                aria-label={`手动过滤：${entry.title}`}
                                title="手动过滤"
                                className={iconButtonClassName}
                                type="button"
                                onClick={() => setManualFilterDialog({ itemId: entry.id, itemTitle: entry.title })}
                                disabled={isPending}
                              >
                                <IconFilter className="h-4 w-4" />
                              </button>
                              <button
                                aria-label="重新生成内容"
                                title="重新生成内容"
                                className={iconButtonClassName}
                                type="button"
                                onClick={() => openRegenerateDialog(entry.id, Boolean(entry.canRegenerateTranslation))}
                                disabled={isPending}
                              >
                                <RefreshIcon />
                              </button>
                              <button
                                aria-label={`删除内容：${entry.title}`}
                                title="删除内容"
                                className={iconButtonClassName}
                                type="button"
                                onClick={() => setDeleteItemDialog({ itemId: entry.id, itemTitle: entry.title })}
                                disabled={isPending}
                              >
                                <IconTrash className="h-4 w-4" />
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className={cardMetaRowClassName}>
                        <GroupBadge group={entry.group} />
                        <span className={neutralBadgeClassName}>{formatScore(entry.score)}</span>
                        <span className={metaTextClassName}>{formatMetaLabel("来源", entry.sourceName)}</span>
                        {getVisibleAuthorLabel(entry.author) ? (
                          <span className={`${metaTextClassName} min-w-0 truncate`}>
                            {formatMetaLabel("作者", getVisibleAuthorLabel(entry.author) ?? "")}
                          </span>
                        ) : null}
                        <span className={metaTextClassName}>{formatMetaLabel("发表", formatDate(entry.publishedAt))}</span>
                      </div>
                      {renderSummary(entry.title, entry.summary)}
                    </div>
                  </div>
                </article>
              ),
            )
          )}
        </section>

        {shouldShowPagination ? (
          <PaginationControls
            className="mt-6"
            totalItems={total}
            page={currentPage}
            totalPages={totalPages}
            pageSize={pageSize}
            pageSizeOptions={FEED_PAGE_SIZE_OPTIONS}
            onPageChange={(nextPage) =>
              loadFeed(latestQueryRef.current, nextPage, pageSize, {
                scrollToTop: true,
                includePopularTags: false,
              })}
            onPageSizeChange={handlePageSizeChange}
            disabled={isPending}
            nextLabel={isPending ? "加载中..." : "下一页"}
            jumpValue={jumpToPage}
            onJumpValueChange={setJumpToPage}
            onJump={handleJumpToPage}
          />
        ) : null}

        <ModalShell
          isOpen={Boolean(fullSummaryDialog)}
          onClose={() => setFullSummaryDialog(null)}
          title="完整摘要"
          widthClassName="max-w-5xl"
          bodyClassName="space-y-3 p-4"
          footer={
            <div className="flex justify-end">
              <Button type="button" variant="secondary" onClick={() => setFullSummaryDialog(null)}>
                关闭
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <h4 className="text-base font-semibold leading-6 text-[var(--foreground)]">{fullSummaryDialog?.title ?? ""}</h4>
            <p className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap text-sm leading-7 text-[var(--muted)]">
              <SummaryMarkdown text={fullSummaryDialog?.summary ?? ""} />
            </p>
          </div>
        </ModalShell>

        <ModalShell
          isOpen={Boolean(assignClusterDialog)}
          onClose={() => setAssignClusterDialog(null)}
          title="手动加入聚合组"
          widthClassName="max-w-2xl"
          bodyClassName="space-y-4 p-4"
          footer={
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setAssignClusterDialog(null)} disabled={isPending}>
                取消
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={confirmAssignCluster}
                disabled={isPending || !selectedClusterId}
              >
                确认加入
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <p className="text-sm text-[var(--muted)]">
              为“{assignClusterDialog?.itemTitle ?? ""}”搜索并选择目标聚合组。
            </p>
            <FormField label="搜索聚合标题" htmlFor="assign-cluster-search">
              <TextInput
                id="assign-cluster-search"
                aria-label="搜索聚合标题"
                value={clusterSearch}
                onChange={(event) => setClusterSearch(event.target.value)}
                placeholder="输入聚合标题关键词"
              />
            </FormField>
            <div className="max-h-72 space-y-2 overflow-y-auto rounded-sm border border-[color:var(--line)] p-2">
              {isLoadingClusterOptions ? (
                <p className="px-2 py-3 text-sm text-[var(--muted)]">正在加载聚合组选项...</p>
              ) : visibleClusterOptions.length ? (
                visibleClusterOptions.map((cluster) => {
                  const isSelected = selectedClusterId === cluster.id;
                  const clusterDisplayTitle = getClusterDisplayTitle(cluster);

                  return (
                    <button
                      key={cluster.id}
                      type="button"
                      aria-pressed={isSelected}
                      aria-label={`选择聚合组：${clusterDisplayTitle}`}
                      onClick={() => setSelectedClusterId(cluster.id)}
                      className={cx(
                        "w-full rounded-sm border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.28)]",
                        isSelected
                          ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                          : "border-[color:var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-muted)]",
                      )}
                    >
                      <div className="text-sm font-medium">{clusterDisplayTitle}</div>
                      <div className="mt-1 text-xs text-[var(--muted)]">{cluster.itemCount} 条内容</div>
                    </button>
                  );
                })
              ) : (
                <p className="px-2 py-3 text-sm text-[var(--muted)]">没有匹配的聚合组。</p>
              )}
            </div>
          </div>
        </ModalShell>

        <ModalShell
          isOpen={Boolean(manualFilterDialog)}
          onClose={() => setManualFilterDialog(null)}
          title="确认手动过滤"
          widthClassName="max-w-md"
          bodyClassName="space-y-3 p-4"
          footer={
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setManualFilterDialog(null)} disabled={isPending}>
                取消
              </Button>
              <Button type="button" variant="primary" onClick={confirmManualFilter} disabled={isPending}>
                确认过滤
              </Button>
            </div>
          }
        >
          <div className="space-y-3 text-sm text-[var(--muted)]">
            <p>将“{manualFilterDialog?.itemTitle ?? ""}”标记为手动过滤。</p>
            <p>过滤后该内容会立即从主页列表中移除。</p>
          </div>
        </ModalShell>

        <ModalShell
          isOpen={Boolean(deleteItemDialog)}
          onClose={() => setDeleteItemDialog(null)}
          title="确认删除内容"
          widthClassName="max-w-md"
          bodyClassName="space-y-3 p-4"
          footer={
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setDeleteItemDialog(null)} disabled={isPending}>
                取消
              </Button>
              <Button type="button" variant="danger" onClick={confirmDeleteItem} disabled={isPending}>
                确认删除
              </Button>
            </div>
          }
        >
          <div className="space-y-3 text-sm text-[var(--muted)]">
            <p>将永久删除“{deleteItemDialog?.itemTitle ?? ""}”。</p>
            <p>删除后会立即从主页列表移除，并自动重算所属聚合。</p>
          </div>
        </ModalShell>

        <ModalShell
          isOpen={Boolean(regenerateDialog)}
          onClose={() => setRegenerateDialog(null)}
          title="选择重新生成内容"
          widthClassName="max-w-sm"
          showCloseButton={false}
          bodyClassName="space-y-4 p-4"
          footer={
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setRegenerateDialog(null)} disabled={isPending}>
                取消
              </Button>
              <Button type="button" variant="primary" onClick={confirmRegeneration} disabled={isPending}>
                确认
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <p className="text-sm text-[var(--muted)]">请选择要重新生成的内容范围。</p>
            <FormField label="重新生成范围" className="w-full">
              <SelectField
                aria-label="重新生成范围"
                value={regenerateMode}
                onChange={(value) => setRegenerateMode((value as RegenerateMode | null) ?? "summary")}
                showSearch={false}
                className="w-full"
                options={[
                  { value: "summary", label: "仅摘要" },
                  { value: "reanalyze", label: "重新 AI 判定" },
                  ...(regenerateDialog?.canRegenerateTranslation
                    ? [
                        { value: "translation", label: "仅翻译" },
                        { value: "both", label: "重新翻译&摘要" },
                      ]
                    : []),
                ]}
              />
            </FormField>
          </div>
        </ModalShell>

        {/* 批量操作对话框 */}
        <ModalShell
          isOpen={Boolean(batchActionDialog) && batchActionDialog?.type === "regenerate"}
          onClose={() => setBatchActionDialog(null)}
          title="批量重新生成"
          widthClassName="max-w-sm"
          showCloseButton={false}
          bodyClassName="space-y-4 p-4"
          footer={
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setBatchActionDialog(null)} disabled={isPending}>
                取消
              </Button>
              <Button type="button" variant="primary" onClick={confirmBatchRegeneration} disabled={isPending}>
                确认
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <p className="text-sm text-[var(--muted)]">
              将为 {batchActionDialog?.itemIds.length ?? 0} 条内容创建重新生成任务。
            </p>
            <FormField label="重新生成范围" className="w-full">
              <SelectField
                aria-label="重新生成范围"
                value={batchRegenerateMode}
                onChange={(value) => setBatchRegenerateMode((value as RegenerateMode | null) ?? "summary")}
                showSearch={false}
                className="w-full"
                options={[
                  { value: "summary", label: "仅摘要" },
                  { value: "translation", label: "仅翻译" },
                  { value: "both", label: "重新翻译&摘要" },
                ]}
              />
            </FormField>
          </div>
        </ModalShell>

        <ModalShell
          isOpen={Boolean(batchActionDialog) && batchActionDialog?.type === "filter"}
          onClose={() => setBatchActionDialog(null)}
          title="确认批量过滤"
          widthClassName="max-w-md"
          bodyClassName="space-y-3 p-4"
          footer={
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setBatchActionDialog(null)} disabled={isPending}>
                取消
              </Button>
              <Button type="button" variant="primary" onClick={confirmBatchFilter} disabled={isPending}>
                确认过滤
              </Button>
            </div>
          }
        >
          <div className="space-y-3 text-sm text-[var(--muted)]">
            <p>将批量过滤 {batchActionDialog?.itemIds.length ?? 0} 条内容。</p>
            <p>过滤后这些内容会立即从主页列表中移除。</p>
          </div>
        </ModalShell>

        <ModalShell
          isOpen={Boolean(batchActionDialog) && batchActionDialog?.type === "delete"}
          onClose={() => setBatchActionDialog(null)}
          title="确认批量删除"
          widthClassName="max-w-md"
          bodyClassName="space-y-3 p-4"
          footer={
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setBatchActionDialog(null)} disabled={isPending}>
                取消
              </Button>
              <Button type="button" variant="danger" onClick={confirmBatchDelete} disabled={isPending}>
                确认删除
              </Button>
            </div>
          }
        >
          <div className="space-y-3 text-sm text-[var(--muted)]">
            <p>将永久删除 {batchActionDialog?.itemIds.length ?? 0} 条内容。</p>
            <p>删除后会立即从主页列表移除，此操作不可恢复。</p>
          </div>
        </ModalShell>
        <ModalShell
          isOpen={Boolean(batchActionDialog) && batchActionDialog?.type === "merge"}
          onClose={() => setBatchActionDialog(null)}
          title="确认批量合并"
          widthClassName="max-w-md"
          bodyClassName="space-y-3 p-4"
          footer={
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setBatchActionDialog(null)} disabled={isPending}>
                取消
              </Button>
              <Button type="button" variant="primary" onClick={confirmBatchMerge} disabled={isPending}>
                确认合并
              </Button>
            </div>
          }
        >
          <div className="space-y-3 text-sm text-[var(--muted)]">
            <p>将把 {batchActionDialog?.itemIds.length ?? 0} 条内容合并到同一个聚合组。</p>
            <p>系统会以所选内容中当前聚合条目数最多的聚合组作为基准。</p>
          </div>
        </ModalShell>
        {readingProgress && !isReadingProgressHidden ? (
          <button
            type="button"
            onClick={resumeReadingProgress}
            disabled={isPending}
            className="fixed right-4 top-20 z-50 inline-flex items-center justify-center rounded-full bg-emerald-100 px-4 py-2 text-sm font-medium text-emerald-800 shadow-md transition hover:bg-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-50 sm:right-8"
            title="继续阅读"
            aria-label="继续阅读"
          >
            <span>继续阅读</span>
          </button>
        ) : null}
        <BackToTopButton />
      </section>
    </PageShell>
  );
}
