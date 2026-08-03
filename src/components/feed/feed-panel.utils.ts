import dayjs, { type Dayjs } from "dayjs";

import { RANGE_OPTIONS } from "@/lib/feed/range";
import type {
  FeedClusterPreviewItemDTO,
  FeedEntryDTO,
  FeedPagination,
  FeedRange,
  FetchRunSnapshot,
} from "@/lib/feed/types";
import { DEFAULT_FEED_PAGE_SIZE } from "@/lib/feed/types";
import type { DateRangeValue, FeedQueryState } from "@/components/feed/feed-panel.types";

const DISPLAY_TIME_ZONE = "Asia/Shanghai";
const FETCH_STATUS_LABELS = {
  running: "运行中",
  succeeded: "已成功",
  failed: "失败",
  partial: "部分成功",
} as const;

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(new Date(value));
}

export function formatRunSummary(status: FetchRunSnapshot | null): string {
  if (!status) {
    return "最近抓取：尚未执行";
  }

  const timestamp = formatRunTime(status) ?? "";
  const statusLabel = FETCH_STATUS_LABELS[status.status];
  const addedInfo = status.itemsAdded > 0 ? ` · 新增${status.itemsAdded}条` : "";

  return `最近抓取：${statusLabel}${addedInfo} · ${timestamp}`;
}

export function formatRunTime(status: FetchRunSnapshot | null): string | null {
  if (!status) {
    return null;
  }

  return formatDate(status.finishedAt ?? status.startedAt);
}

export function formatRunDetail(status: FetchRunSnapshot | null): string | null {
  const detail = status?.errorSummary?.trim();
  return detail ? `抓取说明：${detail}` : null;
}

export function formatScore(score: number): string {
  if (score >= 80) {
    return `高质量 ${score}`;
  }

  if (score >= 60) {
    return `一般 ${score}`;
  }

  return `较低 ${score}`;
}

export function formatRangeLabel(range: FeedRange, startDate: string | null, endDate: string | null): string {
  if (startDate || endDate) {
    return `${startDate ?? "最早"} 至 ${endDate ?? "最新"}`;
  }

  return RANGE_OPTIONS.find((option) => option.value === range)?.label ?? "当天";
}

export function formatClusterSourceLabel(entry: FeedEntryDTO): string {
  if (entry.type === "single") {
    return entry.sourceName;
  }

  if (entry.sourceCount <= 1) {
    return entry.itemsPreview[0]?.sourceName ?? "未知来源";
  }

  return `${entry.sourceCount} 个来源`;
}

export function formatClusterAuthorLabel(entry: FeedEntryDTO): string {
  if (entry.type === "single") {
    return entry.author || "未知作者";
  }

  const uniqueAuthors = Array.from(
    new Set(
      entry.itemsPreview
        .map((item) => item.author?.trim())
        .filter((author): author is string => Boolean(author)),
    ),
  );

  if (uniqueAuthors.length === 1) {
    return uniqueAuthors[0];
  }

  if (uniqueAuthors.length > 1) {
    return `${uniqueAuthors.length} 位作者`;
  }

  return "未知作者";
}

export function formatMetaLabel(label: string, value: string): string {
  return `${label}：${value}`;
}

export function normalizeOptionalId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function normalizeSearchText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function toDayjsRange(startDate: string | null, endDate: string | null): [Dayjs | null, Dayjs | null] {
  return [startDate ? dayjs(startDate, "YYYY-MM-DD") : null, endDate ? dayjs(endDate, "YYYY-MM-DD") : null];
}

export function buildFeedSearch(
  {
    range,
    sort,
    startDate,
    endDate,
    publishedStartDate,
    publishedEndDate,
    groupId,
    sourceId,
    title,
    entity,
    entryKeys,
    createdRangeExplicit = true,
  }: FeedQueryState,
  pagination?: {
    page?: number;
    size?: number;
  },
): string {
  const search = new URLSearchParams();
  const normalizedGroupId = normalizeOptionalId(groupId);
  const normalizedSourceId = normalizeOptionalId(sourceId);
  const normalizedTitle = normalizeSearchText(title);
  const normalizedEntity = normalizeOptionalId(entity);
  const page = pagination?.page ?? 1;
  const size = pagination?.size ?? DEFAULT_FEED_PAGE_SIZE;
  const hasCreatedDateRange = Boolean(startDate || endDate);

  if (createdRangeExplicit || hasCreatedDateRange || range !== "all") {
    search.set("range", range);
  }

  search.set("sort", sort);

  if (startDate) {
    search.set("start", startDate);
  }

  if (endDate) {
    search.set("end", endDate);
  }

  if (publishedStartDate) {
    search.set("publishedStart", publishedStartDate);
  }

  if (publishedEndDate) {
    search.set("publishedEnd", publishedEndDate);
  }

  if (normalizedGroupId) {
    search.set("groupId", normalizedGroupId);
  }

  if (normalizedSourceId) {
    search.set("sourceId", normalizedSourceId);
  }

  if (normalizedTitle) {
    search.set("title", normalizedTitle);
  }

  if (normalizedEntity) {
    search.set("entity", normalizedEntity);
  }

  if (entryKeys.length > 0) {
    search.set("entryKeys", entryKeys.join(","));
  }

  if (page > 1) {
    search.set("page", String(page));
  }

  if (size !== DEFAULT_FEED_PAGE_SIZE) {
    search.set("size", String(size));
  }

  return search.toString();
}

export function buildFallbackPagination(items: FeedEntryDTO[], nextCursor: string | null | undefined): FeedPagination {
  return {
    page: 1,
    size: DEFAULT_FEED_PAGE_SIZE,
    total: items.length + (nextCursor ? 1 : 0),
    totalPages: nextCursor ? 2 : 1,
  };
}

export function formatGroupOptionLabel(name: string, count: number): string {
  return `${name} (${count})`;
}

export function extractItemIdsFromEntry(entry: FeedEntryDTO): string[] {
  if (entry.type === "single") {
    return [entry.id];
  }

  return entry.itemsPreview.map((item) => item.id);
}

export function getAllSelectableItemIds(items: FeedEntryDTO[]): string[] {
  return items.flatMap(extractItemIdsFromEntry);
}

export function toClusterPreviewItems(
  entry: FeedEntryDTO,
  expandedClusters: Record<string, FeedClusterPreviewItemDTO[]>,
): FeedClusterPreviewItemDTO[] {
  if (entry.type !== "cluster") {
    return [];
  }

  return expandedClusters[entry.id] ?? entry.itemsPreview;
}

export function normalizeDateRange(nextRange: DateRangeValue): {
  startDate: string | null;
  endDate: string | null;
} {
  const [nextStartDate, nextEndDate] = nextRange ?? [null, null];

  return {
    startDate: nextStartDate ? nextStartDate.format("YYYY-MM-DD") : null,
    endDate: nextEndDate ? nextEndDate.format("YYYY-MM-DD") : null,
  };
}
