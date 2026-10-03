import type {
  AggregationSplitParentDTO,
  ClusterDTO,
  ClusterReviewCandidateDTO,
  ReviewItemDTO,
} from "@/lib/feed/types";
import { getResponseError } from "@/lib/utils/http";

export type RequiredActionField = "cluster" | "taskRun";

export type ContentReviewActionPayload = {
  success?: boolean;
  item?: ReviewItemDTO;
  aggregationSplit?: AggregationSplitParentDTO;
  cluster?: ClusterDTO | null;
  taskRun?: { id: string; kind?: string };
  error?: string;
};

export type MergeClustersResult = {
  targetClusterId: string;
  mergedClusterIds: string[];
  itemsMoved: number;
  taskId: string;
};

type CollectionPayload = {
  aggregationSplits?: AggregationSplitParentDTO[];
  candidates?: ClusterReviewCandidateDTO[];
  clusters?: ClusterDTO[];
  error?: string;
  items?: ReviewItemDTO[];
  total?: number;
  page?: number;
  pageSize?: number;
};

type MergeClustersPayload = {
  success?: boolean;
  result?: MergeClustersResult;
  error?: string;
};

export type BatchActionResult = {
  succeeded: string[];
  failed: Array<{ id: string; error: string }>;
  total: number;
};

export type BatchResponsePayload = BatchActionResult & {
  success?: boolean;
  error?: string;
};

async function postBatch(url: string, body: unknown, fallbackMessage: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return parseJsonResponse<BatchResponsePayload>(response, fallbackMessage);
}

export function batchAggregationSplits(action: "cancel" | "reanalyze", ids: string[]) {
  return postBatch("/api/admin/items/aggregation/batch", { action, ids }, "批量拆分操作失败。");
}

export function batchClusterReviewCandidates(action: "merge" | "ignore", ids: string[]) {
  return postBatch(
    "/api/admin/clusters/review-candidates/batch",
    { action, ids },
    "批量聚合复核操作失败。",
  );
}

async function parseJsonResponse<T extends { error?: string }>(
  response: Response,
  fallbackMessage: string,
): Promise<T> {
  const payload = (await response.json()) as T;
  const responseError = getResponseError(response, payload, fallbackMessage);

  if (responseError) {
    throw new Error(responseError);
  }

  return payload;
}

export async function fetchFilteredReviewItems(
  page = 1,
  pageSize = 10,
  filters?: { search?: string; sourceName?: string; reason?: string; rangeDays?: number | null },
) {
  const params = new URLSearchParams({
    moderationStatus: "filtered",
    page: String(page),
    pageSize: String(pageSize),
  });
  const normalizedSearch = filters?.search?.trim();
  const normalizedSourceName = filters?.sourceName?.trim();
  const normalizedReason = filters?.reason?.trim();

  if (normalizedSearch) {
    params.set("search", normalizedSearch);
  }
  if (normalizedSourceName) {
    params.set("sourceName", normalizedSourceName);
  }
  if (normalizedReason) {
    params.set("reason", normalizedReason);
  }
  if (filters?.rangeDays) {
    params.set("rangeDays", String(filters.rangeDays));
  }

  const response = await fetch(`/api/admin/items?${params.toString()}`);
  const payload = await parseJsonResponse<CollectionPayload>(response, "审核数据加载失败。");
  return { items: payload.items ?? [], total: payload.total ?? 0 };
}

export async function fetchReviewClusters(
  page = 1,
  pageSize = 10,
  search = "",
  options?: {
    minItemCount?: number | null;
    status?: string;
    timeRange?: string;
  },
) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  const normalizedSearch = search.trim();
  if (normalizedSearch) {
    params.set("search", normalizedSearch);
  }
  if (typeof options?.minItemCount === "number") {
    params.set("minItemCount", String(options.minItemCount));
  }
  if (options?.status) {
    params.set("status", options.status);
  }
  if (options?.timeRange) {
    params.set("timeRange", options.timeRange);
  }

  const response = await fetch(`/api/admin/clusters?${params.toString()}`);
  const payload = await parseJsonResponse<CollectionPayload>(response, "审核数据加载失败。");
  return { clusters: payload.clusters ?? [], total: payload.total ?? 0 };
}

export async function fetchAdminCluster(clusterId: string) {
  const response = await fetch(`/api/admin/clusters/${clusterId}`);
  const payload = await parseJsonResponse<ContentReviewActionPayload>(response, "聚合详情加载失败。");
  return payload.cluster ?? null;
}

export async function fetchClusterReviewCandidates(page = 1, pageSize = 5, options?: { rangeDays?: number | null }) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  if (options?.rangeDays) {
    params.set("rangeDays", String(options.rangeDays));
  }
  const response = await fetch(`/api/admin/clusters/review-candidates?${params.toString()}`);
  const payload = await parseJsonResponse<CollectionPayload>(response, "聚合复核候选加载失败。");
  return { candidates: payload.candidates ?? [], total: payload.total ?? 0 };
}

export async function fetchAggregationSplits(
  page = 1,
  pageSize = 10,
  search = "",
  status = "",
  rangeDays?: number | null,
) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  const normalizedSearch = search.trim();
  if (normalizedSearch) {
    params.set("search", normalizedSearch);
  }
  if (status) {
    params.set("status", status);
  }
  if (rangeDays) {
    params.set("rangeDays", String(rangeDays));
  }

  const response = await fetch(`/api/admin/items/aggregation?${params.toString()}`);
  const payload = await parseJsonResponse<CollectionPayload>(response, "拆分数据加载失败。");
  return { items: payload.aggregationSplits ?? [], total: payload.total ?? 0 };
}

export async function fetchAggregationSplitDetail(parentItemId: string) {
  const response = await fetch(`/api/admin/items/aggregation/${parentItemId}`);
  const payload = await parseJsonResponse<ContentReviewActionPayload>(response, "拆分详情加载失败。");
  return payload.aggregationSplit ?? null;
}

export async function postContentReviewAction(url: string) {
  const response = await fetch(url, { method: "POST" });
  return parseJsonResponse<ContentReviewActionPayload>(response, "操作失败");
}

export async function mergeReviewClusters(input: {
  targetClusterId: string;
  sourceClusterIds: string[];
}) {
  const response = await fetch("/api/admin/clusters/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await parseJsonResponse<MergeClustersPayload>(response, "合并失败");

  if (!payload.result) {
    throw new Error("合并失败");
  }

  return payload.result;
}

export async function mergeClusterReviewCandidate(candidateId: string) {
  const response = await fetch(`/api/admin/clusters/review-candidates/${candidateId}/merge`, {
    method: "POST",
  });
  const payload = await parseJsonResponse<MergeClustersPayload>(response, "复核合并失败");

  if (!payload.result) {
    throw new Error("复核合并失败");
  }

  return payload.result;
}

export async function ignoreClusterReviewCandidate(candidateId: string) {
  const response = await fetch(`/api/admin/clusters/review-candidates/${candidateId}/ignore`, {
    method: "POST",
  });
  return parseJsonResponse<{ success?: boolean; error?: string }>(response, "复核忽略失败");
}
