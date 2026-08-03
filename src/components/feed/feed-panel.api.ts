import type {
  ClusterDTO,
  FeedClusterPreviewItemDTO,
  FeedEntryDTO,
  FeedGroupOption,
  FeedPagination,
  FeedRange,
  FeedSort,
  FetchRunSnapshot,
} from "@/lib/feed/types";
import { DEFAULT_FEED_PAGE_SIZE } from "@/lib/feed/types";
import type { FeedQueryState } from "@/components/feed/feed-panel.types";
import { buildFeedSearch } from "@/components/feed/feed-panel.utils";

type FeedPayload = {
  items: FeedEntryDTO[];
  groups?: FeedGroupOption[];
  groupTotalCount?: number;
  nextCursor?: string | null;
  pagination?: FeedPagination;
  range: FeedRange;
  sort: FeedSort;
  start: string | null;
  end: string | null;
  publishedStart: string | null;
  publishedEnd: string | null;
  groupId: string | null;
  sourceId: string | null;
  title: string | null;
  entryId: string | null;
  entryType: "single" | "cluster" | null;
  entryKeys: string[];
};

type TaskRunResponse = {
  taskRun?: {
    id: string;
  } | null;
  error?: string;
};

type ErrorResponse = {
  error?: string;
};

type MergeSelectedItemsPayload = {
  success?: boolean;
  result?: {
    targetClusterId: string;
    targetClusterTitle: string;
    movedItemIds: string[];
    affectedClusterIds: string[];
    itemsMoved: number;
  };
  error?: string;
};

type ApiResult<T> = {
  ok: boolean;
  status: number;
  data: T;
};

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = init ? await fetch(input, init) : await fetch(input);
  return (await response.json()) as T;
}

async function requestJsonWithMeta<T>(input: RequestInfo | URL, init?: RequestInit): Promise<ApiResult<T>> {
  const response = init ? await fetch(input, init) : await fetch(input);
  return {
    ok: response.ok,
    status: response.status,
    data: (await response.json()) as T,
  };
}

export async function requestFeed(
  query: FeedQueryState,
  pagination?: {
    page?: number;
    size?: number;
  },
) {
  const requestedPage = pagination?.page ?? 1;
  const requestedSize = pagination?.size ?? DEFAULT_FEED_PAGE_SIZE;
  const payload = await requestJson<FeedPayload>(`/api/feed?${buildFeedSearch(query, pagination)}`);

  return {
    ...payload,
    pagination: payload.pagination ?? {
      page: requestedPage,
      size: requestedSize,
      total: payload.items.length,
      totalPages: 1,
    },
  };
}

export async function requestClusterItems(clusterId: string, query: FeedQueryState) {
  const clusterItemQuery: FeedQueryState = {
    ...query,
    range: "all",
    startDate: null,
    endDate: null,
    publishedStartDate: null,
    publishedEndDate: null,
  };
  const payload = await requestJson<{ items: FeedClusterPreviewItemDTO[] }>(
    `/api/feed/clusters/${clusterId}?${buildFeedSearch(clusterItemQuery)}`,
  );

  return payload.items;
}

export async function requestClusterOptions(search = "") {
  const params = new URLSearchParams({
    page: "1",
    pageSize: "50",
  });
  const normalizedSearch = search.trim();
  if (normalizedSearch) {
    params.set("search", normalizedSearch);
  }

  return requestJsonWithMeta<{ clusters?: ClusterDTO[]; error?: string }>(`/api/admin/clusters?${params.toString()}`);
}

export async function queueIngestionRun() {
  return requestJsonWithMeta<TaskRunResponse>("/api/ingest/run", { method: "POST" });
}

export async function requestRegeneration(itemId: string, target: "translation" | "summary") {
  return requestJsonWithMeta<TaskRunResponse>(`/api/admin/items/${itemId}/regenerate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ target }),
  });
}

export async function requestReanalysis(itemId: string) {
  return requestJsonWithMeta<TaskRunResponse>(`/api/admin/items/${itemId}/reanalyze`, {
    method: "POST",
  });
}

export async function joinCluster(itemId: string, clusterId: string) {
  return requestJsonWithMeta<ErrorResponse>(`/api/admin/items/${itemId}/join-cluster`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ clusterId }),
  });
}

export async function mergeSelectedItems(itemIds: string[]) {
  return requestJsonWithMeta<MergeSelectedItemsPayload>("/api/admin/clusters/merge-items", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ itemIds }),
  });
}

export async function filterItem(itemId: string) {
  return requestJsonWithMeta<ErrorResponse>(`/api/admin/items/${itemId}/filter`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
  });
}

export async function deleteItem(itemId: string) {
  return requestJsonWithMeta<ErrorResponse>(`/api/admin/items/${itemId}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
    },
  });
}

export async function regenerateClusterSummary(clusterId: string) {
  return requestJsonWithMeta<TaskRunResponse>(`/api/admin/clusters/${clusterId}/regenerate-summary`, {
    method: "POST",
  });
}

export async function requestIngestionStatus() {
  return requestJson<{ run?: FetchRunSnapshot | null }>("/api/ingest/status");
}
