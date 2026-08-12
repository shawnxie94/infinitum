"use client";

import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

import {
  fetchAggregationSplitDetail,
  fetchAggregationSplits,
  fetchAdminCluster,
  fetchClusterReviewCandidates,
  fetchFilteredReviewItems,
  fetchReviewClusters,
  ignoreClusterReviewCandidate,
  mergeClusterReviewCandidate,
  mergeReviewClusters,
  postContentReviewAction,
  type ContentReviewActionPayload,
  type RequiredActionField,
} from "@/components/admin/content-review-panel.api";
import { ADMIN_CLUSTER_SEARCH_DEBOUNCE_MS } from "@/config/constants";
import { ContentReviewMergeModal } from "@/components/admin/content-review-merge-modal";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterInput } from "@/components/ui/filter-input";
import { FilterSelect } from "@/components/ui/filter-select";
import { ModalShell } from "@/components/ui/modal-shell";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { renderInlineMarkdown } from "@/components/ui/inline-markdown";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import {
  IconRotateCw,
  IconCheck,
  IconX,
  IconEye,
  IconExternalLink,
  IconTrash,
  IconMerge,
  IconSplit,
} from "@/components/ui/icons";
import type {
  AggregationSplitParentDTO,
  ClusterDTO,
  ClusterReviewCandidateDTO,
  ReviewItemDTO,
} from "@/lib/feed/types";
import { getClusterDisplayTitle } from "@/lib/feed/cluster-display";
import { cx } from "@/lib/ui/cx";
import { matchesFuzzySearch } from "@/lib/utils/search";

type ReviewTab = "filtered" | "clusters" | "splits";

const reviewReasonLabels: Record<NonNullable<ReviewItemDTO["moderationReason"]>, string> = {
  marketing: "营销内容",
  low_quality: "低质量",
  duplicate_noise: "重复噪音",
  rule_filter: "规则过滤",
  rule_blacklist: "规则黑名单",
  other: "其他原因",
};

const reviewReasonTone: Record<NonNullable<ReviewItemDTO["moderationReason"]>, "neutral" | "warning" | "danger"> = {
  marketing: "warning",
  low_quality: "neutral",
  duplicate_noise: "neutral",
  rule_filter: "danger",
  rule_blacklist: "danger",
  other: "neutral",
};

const clusterStatusLabels: Record<ClusterDTO["status"], string> = {
  active: "显示中",
  hidden: "已隐藏",
};

const clusterStatusTone: Record<ClusterDTO["status"], "success" | "neutral"> = {
  active: "success",
  hidden: "neutral",
};

const splitStatusOptions = [
  { value: "", label: "全部状态" },
  { value: "parsed", label: "已拆分" },
  { value: "detected", label: "待拆分" },
  { value: "failed", label: "解析失败" },
];

const splitStatusLabels: Record<string, string> = {
  parsed: "已拆分",
  detected: "待拆分",
  failed: "解析失败",
};

const splitStatusTone: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  parsed: "success",
  detected: "warning",
  failed: "danger",
};

const reviewCandidateVerdictLabels: Record<ClusterReviewCandidateDTO["verdict"], string> = {
  approved: "建议合并",
  ambiguous: "灰区复核",
  declined: "已拒绝",
  failed: "判定失败",
};

const reviewCandidateVerdictTone: Record<
  ClusterReviewCandidateDTO["verdict"],
  "success" | "warning" | "danger" | "neutral"
> = {
  approved: "success",
  ambiguous: "warning",
  declined: "neutral",
  failed: "danger",
};

const CLUSTER_REVIEW_DEFAULT_PAGE_SIZE = 10;

// Time range filter options
const timeRangeOptions: Array<{ value: TimeRangeFilter; label: string }> = [
  { value: "", label: "全部时间" },
  { value: "today", label: "今天" },
  { value: "week", label: "最近7天" },
  { value: "month", label: "最近30天" },
];

type TimeRangeFilter = "" | "today" | "week" | "month";
type ReviewRangeDays = 1 | 3 | 7;

const reviewRangeOptions: Array<{ value: "" | string; label: string }> = [
  { value: "", label: "全部时间" },
  { value: "1", label: "最近1天" },
  { value: "3", label: "最近3天" },
  { value: "7", label: "最近7天" },
];

function normalizeReviewRangeDays(value: number | null | undefined): ReviewRangeDays | null {
  return value === 1 || value === 3 || value === 7 ? value : null;
}

const subtleCardClassName =
  "rounded-[0.95rem] border border-[color:var(--line)] bg-[var(--surface-muted)]/82 shadow-[var(--shadow-sm)]";

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Shanghai",
});

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Shanghai",
});

function formatDateTime(value: string) {
  return dateTimeFormatter.format(new Date(value));
}

function formatDate(value: string) {
  return dateFormatter.format(new Date(value));
}

function getClusterLatestItemUpdatedAt(cluster: ClusterDTO) {
  return cluster.latestItemUpdatedAt ?? cluster.latestPublishedAt;
}

function getReviewReasonLabel(reason: ReviewItemDTO["moderationReason"]) {
  if (!reason) {
    return "待复核";
  }
  return reviewReasonLabels[reason];
}

function getFilteredItemReasonLabel(item: ReviewItemDTO) {
  if (item.filterReason === "reparsed_parent") {
    return "重拆下线";
  }
  return getReviewReasonLabel(item.moderationReason);
}

const splitChildFilterReasonLabels: Record<string, string> = {
  reparsed_parent: "重拆下线",
  aggregation_split_cancelled: "拆分取消",
};

function getSplitStatusLabel(status: string | null) {
  return status ? splitStatusLabels[status] ?? status : "未知";
}

function getSplitStatusTone(status: string | null) {
  return status ? splitStatusTone[status] ?? "neutral" : "neutral";
}

function formatEventAnchor(input: {
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
}) {
  const parts = [
    input.eventType,
    input.eventSubject,
    input.eventAction,
    input.eventObject,
    input.eventDate,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" / ") : "事件锚点不足";
}

function formatCompactClusterAnchor(input: {
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
}) {
  const parts = [
    input.eventSubject,
    input.eventAction,
    input.eventObject,
    input.eventDate,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" / ") : "锚点不足";
}

function summarizeAssignmentReasons(reasons: string[]) {
  return reasons.slice(0, 2).join("；") || "主要由标题、时间窗口和内容相似度归组";
}

async function executeWithPendingId(
  id: string,
  setPendingId: Dispatch<SetStateAction<string | null>>,
  action: () => Promise<void>,
) {
  setPendingId(id);

  try {
    await action();
  } finally {
    setPendingId((current) => (current === id ? null : current));
  }
}

// Filtered Item Detail Modal
interface FilteredItemDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: ReviewItemDTO | null;
  onRestore?: () => void;
  onReanalyze?: () => void;
  isRestoring?: boolean;
  isReanalyzing?: boolean;
}

function getSafeUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function FilteredItemDetailModal({
  isOpen,
  onClose,
  item,
  onRestore,
  onReanalyze,
  isRestoring,
  isReanalyzing,
}: FilteredItemDetailModalProps) {
  if (!item) return null;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="过滤内容详情"
      widthClassName="max-w-2xl"
      headerClassName="border-b border-[color:var(--line)] p-6"
      bodyClassName="space-y-4 p-6"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
      footer={
        <div className="flex justify-end gap-2">
          {onRestore && (
            <Button onClick={onRestore} variant="primary" disabled={isRestoring}>
              <IconCheck className={cx("h-4 w-4 mr-1", isRestoring && "animate-pulse")} />
              恢复内容
            </Button>
          )}
          {onReanalyze && (
            <Button onClick={onReanalyze} variant="secondary" disabled={isReanalyzing}>
              <IconRotateCw className={cx("h-4 w-4 mr-1", isReanalyzing && "animate-spin")} />
              重新 AI 判定
            </Button>
          )}
          <Button onClick={onClose} variant="secondary">
            关闭
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Basic Info */}
        <div className="rounded-lg border border-[color:var(--line)] bg-[var(--bg-muted)] p-4 text-sm text-[var(--text-2)]">
          <div className="font-medium text-[var(--text-1)] mb-2">{item.title}</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-[var(--text-3)]">来源:</span> {item.sourceName}
            </div>
            <div>
              <span className="text-[var(--text-3)]">发布时间:</span> {formatDateTime(item.publishedAt)}
            </div>
            <div>
              <span className="text-[var(--text-3)]">过滤原因:</span>{" "}
              <StatusTag tone={reviewReasonTone[item.moderationReason ?? "other"]}>
                {getFilteredItemReasonLabel(item)}
              </StatusTag>
            </div>
            <div>
              <span className="text-[var(--text-3)]">质量分:</span> {item.qualityScore}
            </div>
          </div>
        </div>

        {/* Summary */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-[var(--text-1)]">内容摘要</h4>
          <p className="text-sm text-[var(--text-2)] leading-6">
            {renderInlineMarkdown(item.summary || "暂无摘要")}
          </p>
        </div>

        {/* Moderation Detail */}
        {(item.moderationDetail || item.qualityRationale) && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-[var(--text-1)]">审核说明</h4>
            <p className="text-sm text-[var(--text-2)] leading-6">
              {item.moderationDetail || item.qualityRationale}
            </p>
          </div>
        )}

        {/* External Link */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-[var(--text-1)]">原文链接</h4>
          {getSafeUrl(item.originalUrl) ? (
            <button
              type="button"
              onClick={() => window.open(item.originalUrl, "_blank", "noopener,noreferrer")}
              className="inline-flex items-center gap-1 text-sm text-[var(--accent)] hover:underline cursor-pointer"
            >
              {item.originalUrl}
              <IconExternalLink className="h-3.5 w-3.5" />
            </button>
          ) : (
            <span className="text-sm text-[var(--text-2)]">{item.originalUrl}</span>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

// Cluster Detail Modal
interface ClusterDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  cluster: ClusterDTO | null;
  onRegenerateSummary?: () => void;
  onToggleStatus?: () => void;
  onDetachItem?: (itemId: string) => void;
  onMerge?: () => void;
  onSplit?: () => void;
  isRegenerating?: boolean;
  isTogglingStatus?: boolean;
  isSplitting?: boolean;
}

function ClusterDetailModal({
  isOpen,
  onClose,
  cluster,
  onRegenerateSummary,
  onToggleStatus,
  onDetachItem,
  onMerge,
  onSplit,
  isRegenerating,
  isTogglingStatus,
  isSplitting,
}: ClusterDetailModalProps) {
  if (!cluster) return null;

  const isHidden = cluster.status === "hidden";

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="聚合详情"
      widthClassName="max-w-3xl"
      headerClassName="border-b border-[color:var(--line)] p-6"
      bodyClassName="space-y-4 p-6 max-h-[70vh] overflow-y-auto"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
      footer={
        <div className="flex justify-end gap-2">
          {onMerge && (
            <Button onClick={onMerge} variant="secondary">
              <IconMerge className="h-4 w-4 mr-1" />
              合并聚合组
            </Button>
          )}
          {onRegenerateSummary && (
            <Button onClick={onRegenerateSummary} variant="secondary" disabled={isRegenerating}>
              <IconRotateCw className={cx("h-4 w-4 mr-1", isRegenerating && "animate-spin")} />
              重新生成摘要
            </Button>
          )}
          {onSplit && (
            <Button onClick={onSplit} variant="danger" disabled={isSplitting}>
              <IconSplit className={cx("h-4 w-4 mr-1", isSplitting && "animate-pulse")} />
              全部拆分
            </Button>
          )}
          {onToggleStatus && (
            <Button
              onClick={onToggleStatus}
              variant={isHidden ? "primary" : "secondary"}
              disabled={isTogglingStatus}
            >
              {isHidden ? (
                <>
                  <IconCheck className="h-4 w-4 mr-1" />
                  恢复显示
                </>
              ) : (
                <>
                  <IconX className="h-4 w-4 mr-1" />
                  隐藏聚合
                </>
              )}
            </Button>
          )}
          <Button onClick={onClose} variant="secondary">
            关闭
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Basic Info */}
        <div className="rounded-lg border border-[color:var(--line)] bg-[var(--bg-muted)] p-4 text-sm text-[var(--text-2)]">
          <div className="font-medium text-[var(--text-1)] mb-2">{cluster.title}</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-[var(--text-3)]">内容数:</span> {cluster.itemCount} 条
            </div>
            <div>
              <span className="text-[var(--text-3)]">最新更新:</span>{" "}
              {formatDateTime(getClusterLatestItemUpdatedAt(cluster))}
            </div>
            <div>
              <span className="text-[var(--text-3)]">状态:</span>{" "}
              <StatusTag tone={clusterStatusTone[cluster.status]}>
                {clusterStatusLabels[cluster.status]}
              </StatusTag>
            </div>
            <div>
              <span className="text-[var(--text-3)]">质量分:</span> {cluster.score}
            </div>
          </div>
        </div>

        {/* Summary */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-[var(--text-1)]">聚合摘要</h4>
          <p className="text-sm text-[var(--text-2)] leading-6">
            {renderInlineMarkdown(cluster.summary || "暂无摘要")}
          </p>
        </div>

        {cluster.assignmentExplanation ? (
          <div className="rounded-md border border-[color:var(--line)] bg-[var(--bg-muted)] px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-semibold text-[var(--text-1)]">归组依据</span>
              <span className="text-[var(--text-2)]">
                {formatCompactClusterAnchor(cluster.assignmentExplanation)}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-[var(--text-3)]">
              {summarizeAssignmentReasons(cluster.assignmentExplanation.reasons)}
            </p>
          </div>
        ) : null}

        {/* Items List */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-[var(--text-1)]">
            包含内容 ({cluster.items.length})
          </h4>
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {cluster.items.map((item) => (
              <div
                key={item.id}
                className={cx(subtleCardClassName, "p-3 flex items-start justify-between gap-3")}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-medium text-sm text-[var(--foreground)] truncate">
                    {item.title}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                    <span>{item.sourceName}</span>
                    <span>{formatDate(item.publishedAt)}</span>
                  </div>
                  <div className="text-xs text-[var(--text-3)]">
                    {formatEventAnchor(item)}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <IconButton
                    onClick={() => window.open(item.originalUrl, "_blank")}
                    variant="ghost"
                    size="sm"
                    title="查看原文"
                  >
                    <IconExternalLink className="h-4 w-4" />
                  </IconButton>
                  {onDetachItem && (
                    <IconButton
                      onClick={() => onDetachItem(item.id)}
                      variant="ghost"
                      size="sm"
                      title="移出聚合"
                    >
                      <IconTrash className="h-4 w-4" />
                    </IconButton>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

interface AggregationSplitDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: AggregationSplitParentDTO | null;
  onCancelSplit?: () => void;
  isCancelling?: boolean;
}

function AggregationSplitDetailModal({
  isOpen,
  onClose,
  item,
  onCancelSplit,
  isCancelling,
}: AggregationSplitDetailModalProps) {
  if (!item) return null;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="聚合拆分详情"
      widthClassName="max-w-3xl"
      headerClassName="border-b border-[color:var(--line)] p-6"
      bodyClassName="space-y-4 p-6 max-h-[70vh] overflow-y-auto"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
      footer={
        <div className="flex justify-end gap-2">
          {onCancelSplit && (
            <Button onClick={onCancelSplit} variant="danger" disabled={isCancelling}>
              <IconSplit className={cx("h-4 w-4 mr-1", isCancelling && "animate-pulse")} />
              取消拆分
            </Button>
          )}
          <Button onClick={onClose} variant="secondary">
            关闭
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-[color:var(--line)] bg-[var(--bg-muted)] p-4 text-sm text-[var(--text-2)]">
          <div className="font-medium text-[var(--text-1)] mb-2">{item.title}</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-[var(--text-3)]">来源:</span> {item.sourceName}
            </div>
            <div>
              <span className="text-[var(--text-3)]">发布时间:</span> {formatDateTime(item.publishedAt)}
            </div>
            <div>
              <span className="text-[var(--text-3)]">子事件:</span> {item.childCount}
            </div>
            <div>
              <span className="text-[var(--text-3)]">质量分:</span> {item.qualityScore}
            </div>
            <div>
              <span className="text-[var(--text-3)]">事件链接:</span> {item.eventUrlCount}
            </div>
            <div>
              <span className="text-[var(--text-3)]">父链接复用:</span> {item.parentUrlCount}
            </div>
            <div>
              <span className="text-[var(--text-3)]">状态:</span> {item.aggregationParseStatus ?? "未知"}
            </div>
            <div>
              <span className="text-[var(--text-3)]">错误信息:</span> {item.errorMessage || "无"}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-[var(--text-1)]">父项摘要</h4>
          <p className="text-sm text-[var(--text-2)] leading-6">
            {renderInlineMarkdown(item.summary || "暂无摘要")}
          </p>
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-[var(--text-1)]">
            拆分子项 ({item.children?.length ?? 0})
          </h4>
          <div className="space-y-2">
            {(item.children ?? []).map((child) => (
              <div
                key={child.id}
                className={cx(subtleCardClassName, "p-3 flex items-start justify-between gap-3")}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <div className="font-medium text-sm text-[var(--foreground)] truncate">
                      {child.title}
                    </div>
                    <StatusTag tone={child.usesParentUrl ? "warning" : "success"}>
                      {child.usesParentUrl ? "父链接" : "事件链接"}
                    </StatusTag>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                    <span>{child.sourceName}</span>
                    <span>{formatDate(child.publishedAt)}</span>
                    <span>质量 {child.qualityScore}</span>
                    <span>
                      {child.filterReason
                        ? splitChildFilterReasonLabels[child.filterReason] ?? child.filterReason
                        : "未过滤"}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--text-2)] leading-5 line-clamp-2">
                    {renderInlineMarkdown(child.summary || "暂无摘要")}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <IconButton
                    onClick={() => window.open(child.originalUrl, "_blank")}
                    variant="ghost"
                    size="sm"
                    title="查看原文"
                  >
                    <IconExternalLink className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

type ClusterReviewModalProps = {
  candidates: ClusterReviewCandidateDTO[];
  totalCount: number;
  page: number;
  pageSize: number;
  isOpen: boolean;
  isBusy: boolean;
  pendingId: string | null;
  onClose: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onRefresh: () => void;
  onOpenCluster: (cluster: ClusterReviewCandidateDTO["leftCluster"]) => void;
  onMerge: (candidateId: string) => void;
  onIgnore: (candidateId: string) => void;
};

function ClusterReviewModal({
  candidates,
  totalCount,
  page,
  pageSize,
  isOpen,
  isBusy,
  pendingId,
  onClose,
  onPageChange,
  onPageSizeChange,
  onRefresh,
  onOpenCluster,
  onMerge,
  onIgnore,
}: ClusterReviewModalProps) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="聚合待定"
      widthClassName="max-w-6xl"
      headerClassName="border-b border-[color:var(--line)] p-4"
      bodyClassName="space-y-4 p-4 max-h-[76vh] overflow-y-auto"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onRefresh} variant="secondary" disabled={isBusy}>
            刷新待定
          </Button>
          <Button onClick={onClose} variant="secondary" disabled={isBusy}>
            关闭
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {candidates.length === 0 ? (
          <EmptyState className="border-0 bg-[var(--bg-muted)]">
            暂无待处理复核
          </EmptyState>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full table-auto text-sm">
              <thead className="bg-[var(--bg-muted)] text-[var(--muted)]">
                <tr>
                  <th className="w-[12%] whitespace-nowrap px-3 py-2 text-left">判定</th>
                  <th className="w-[24%] px-3 py-2 text-left">左聚合</th>
                  <th className="w-[24%] px-3 py-2 text-left">右聚合</th>
                  <th className="w-[12%] whitespace-nowrap px-3 py-2 text-left">置信分</th>
                  <th className="w-[18%] px-3 py-2 text-left">原因</th>
                  <th className="w-[10%] whitespace-nowrap px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--line)]">
                {candidates.map((candidate) => {
                  const isCandidateBusy = pendingId === candidate.id;
                  const reason = candidate.reasonText || candidate.reasonCode || "模型或本地证据认为可能属于同一事件";

                  return (
                    <tr key={candidate.id} className="align-top transition-colors hover:bg-[var(--bg-muted)]">
                      <td className="px-3 py-3">
                        <StatusTag tone={reviewCandidateVerdictTone[candidate.verdict]}>
                          {reviewCandidateVerdictLabels[candidate.verdict]}
                        </StatusTag>
                        <div className="mt-1 text-xs text-[var(--text-3)]">
                          {formatDate(candidate.createdAt)}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <button
                          type="button"
                          className="block max-w-full truncate text-left font-medium text-[var(--accent)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
                          onClick={() => onOpenCluster(candidate.leftCluster)}
                        >
                          {candidate.leftCluster.title}
                        </button>
                        <div className="mt-1 text-xs text-[var(--text-3)]">
                          {candidate.leftCluster.itemCount} 条 · {formatDate(candidate.leftCluster.latestPublishedAt)}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <button
                          type="button"
                          className="block max-w-full truncate text-left font-medium text-[var(--accent)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
                          onClick={() => onOpenCluster(candidate.rightCluster)}
                        >
                          {candidate.rightCluster.title}
                        </button>
                        <div className="mt-1 text-xs text-[var(--text-3)]">
                          {candidate.rightCluster.itemCount} 条 · {formatDate(candidate.rightCluster.latestPublishedAt)}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-[var(--text-2)]">
                        {candidate.confidence != null ? candidate.confidence : "-"}
                      </td>
                      <td className="px-3 py-3 text-xs leading-5 text-[var(--text-2)]">
                        {reason}
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <IconButton
                            aria-label={`合并待定：${candidate.leftCluster.title}`}
                            title="合并"
                            size="sm"
                            variant="ghost"
                            disabled={isBusy || isCandidateBusy}
                            onClick={() => onMerge(candidate.id)}
                          >
                            <IconMerge className={cx("h-4 w-4", isCandidateBusy && "animate-pulse")} />
                          </IconButton>
                          <IconButton
                            aria-label={`忽略待定：${candidate.leftCluster.title}`}
                            title="忽略"
                            size="sm"
                            variant="ghost"
                            disabled={isBusy || isCandidateBusy}
                            onClick={() => onIgnore(candidate.id)}
                          >
                            <IconX className={cx("h-4 w-4", isCandidateBusy && "animate-pulse")} />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {totalCount > 0 ? (
          <PaginationControls
            totalItems={totalCount}
            page={page}
            totalPages={totalPages}
            pageSize={pageSize}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
            disabled={isBusy}
          />
        ) : null}
      </div>
    </ModalShell>
  );
}

interface ContentReviewContentProps {
  initialTab?: ReviewTab;
  initialPage?: number | null;
  initialPageSize?: number | null;
  initialRangeDays?: ReviewRangeDays | null;
  initialOpenClusterReview?: boolean;
  onPageStateChange?: (state: { page: number; pageSize: number }) => void;
  onTaskCreated?: (taskId: string, state: { page: number; pageSize: number }) => void;
}

function ContentReviewContent({
  initialTab = "filtered",
  initialPage = null,
  initialPageSize = null,
  initialRangeDays = null,
  initialOpenClusterReview = false,
  onPageStateChange,
  onTaskCreated,
}: ContentReviewContentProps) {
  const { showToast } = useToast();
  const activeTab = initialTab;
  const [filteredItems, setFilteredItems] = useState<ReviewItemDTO[]>([]);
  const [clusters, setClusters] = useState<ClusterDTO[]>([]);
  const [clusterReviewCandidates, setClusterReviewCandidates] = useState<ClusterReviewCandidateDTO[]>([]);
  const [aggregationSplits, setAggregationSplits] = useState<AggregationSplitParentDTO[]>([]);
  const [filteredSearch, setFilteredSearch] = useState("");
  const [debouncedFilteredSearch, setDebouncedFilteredSearch] = useState("");
  const [filteredSource, setFilteredSource] = useState("");
  const [filteredReason, setFilteredReason] = useState("");
  const [filteredRangeDays, setFilteredRangeDays] = useState<ReviewRangeDays | null>(
    activeTab === "filtered" ? normalizeReviewRangeDays(initialRangeDays) : null,
  );
  const [clusterSearch, setClusterSearch] = useState("");
  const [debouncedClusterSearch, setDebouncedClusterSearch] = useState("");
  const [clusterStatus, setClusterStatus] = useState<ClusterDTO["status"] | "">("");
  const [clusterTimeRange, setClusterTimeRange] = useState<TimeRangeFilter>("");
  const [splitSearch, setSplitSearch] = useState("");
  const [debouncedSplitSearch, setDebouncedSplitSearch] = useState("");
  const [splitStatus, setSplitStatus] = useState("");
  const [splitRangeDays, setSplitRangeDays] = useState<ReviewRangeDays | null>(
    activeTab === "splits" ? normalizeReviewRangeDays(initialRangeDays) : null,
  );
  const [isPending, startTransition] = useTransition();
  const [page, setPage] = useState(initialPage ?? 1);
  const [pageSize, setPageSize] = useState(initialPageSize ?? 10);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [clusterTotal, setClusterTotal] = useState(0);
  const [clusterReviewTotal, setClusterReviewTotal] = useState(0);
  const [clusterReviewPage, setClusterReviewPage] = useState(1);
  const [clusterReviewPageSize, setClusterReviewPageSize] = useState(CLUSTER_REVIEW_DEFAULT_PAGE_SIZE);
  const [splitTotal, setSplitTotal] = useState(0);

  // Detail modal states
  const [selectedFilteredItem, setSelectedFilteredItem] = useState<ReviewItemDTO | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<ClusterDTO | null>(null);
  const [selectedSplit, setSelectedSplit] = useState<AggregationSplitParentDTO | null>(null);
  const [isFilteredDetailOpen, setIsFilteredDetailOpen] = useState(false);
  const [isClusterDetailOpen, setIsClusterDetailOpen] = useState(false);
  const [isSplitDetailOpen, setIsSplitDetailOpen] = useState(false);
  const [isClusterReviewModalOpen, setIsClusterReviewModalOpen] = useState(
    activeTab === "clusters" && initialOpenClusterReview,
  );

  // Action states
  const [restoringItemId, setRestoringItemId] = useState<string | null>(null);
  const [reanalyzingItemId, setReanalyzingItemId] = useState<string | null>(null);
  const [regeneratingClusterId, setRegeneratingClusterId] = useState<string | null>(null);
  const [togglingClusterId, setTogglingClusterId] = useState<string | null>(null);
  const [mergingClusterId, setMergingClusterId] = useState<string | null>(null);
  const [reviewCandidatePendingId, setReviewCandidatePendingId] = useState<string | null>(null);
  const [splittingClusterId, setSplittingClusterId] = useState<string | null>(null);
  const [cancellingSplitId, setCancellingSplitId] = useState<string | null>(null);

  // Merge modal states
  const [isMergeModalOpen, setIsMergeModalOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);
  const [mergeSourceIds, setMergeSourceIds] = useState<Set<string>>(new Set());
  const [mergeSearchQuery, setMergeSearchQuery] = useState("");
  const [mergeCandidateClusters, setMergeCandidateClusters] = useState<ClusterDTO[]>([]);
  const [isMergeCandidatesLoading, setIsMergeCandidatesLoading] = useState(false);

  // Confirmation modal states
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    confirmText?: string;
    variant?: "danger" | "primary";
  }>({
    isOpen: false,
    title: "",
    message: "",
    onConfirm: () => {},
  });

  const loadClusterReviewCandidates = useCallback(
    async (nextPage = clusterReviewPage, nextPageSize = clusterReviewPageSize) => {
      const result = await fetchClusterReviewCandidates(nextPage, nextPageSize, {
        rangeDays: activeTab === "clusters" ? normalizeReviewRangeDays(initialRangeDays) : null,
      });
      setClusterReviewCandidates(result.candidates);
      setClusterReviewTotal(result.total);
    },
    [activeTab, clusterReviewPage, clusterReviewPageSize, initialRangeDays],
  );

  const fetchData = useCallback(() => {
    let cancelled = false;

    startTransition(async () => {
      try {
        if (activeTab === "filtered") {
          const result = await fetchFilteredReviewItems(page, pageSize, {
            search: debouncedFilteredSearch,
            sourceName: filteredSource,
            reason: filteredReason,
            rangeDays: filteredRangeDays,
          });

          if (cancelled) return;
          setFilteredItems(result.items);
          setFilteredTotal(result.total);
        } else if (activeTab === "clusters") {
          const [result, reviewResult] = await Promise.all([
            fetchReviewClusters(page, pageSize, debouncedClusterSearch, {
              minItemCount: 2,
              status: clusterStatus,
              timeRange: clusterTimeRange,
            }),
            fetchClusterReviewCandidates(1, 1, {
              rangeDays: normalizeReviewRangeDays(initialRangeDays),
            }),
          ]);

          if (cancelled) return;
          setClusters(result.clusters);
          setClusterTotal(result.total);
          setClusterReviewTotal(reviewResult.total);
        } else {
          const result = await fetchAggregationSplits(page, pageSize, debouncedSplitSearch, splitStatus, splitRangeDays);

          if (cancelled) return;
          setAggregationSplits(result.items);
          setSplitTotal(result.total);
        }
      } catch (error) {
        if (!cancelled) {
          showToast(error instanceof Error ? error.message : "审核数据加载失败。", "error");
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    page,
    pageSize,
    debouncedFilteredSearch,
    filteredSource,
    filteredReason,
    filteredRangeDays,
    debouncedClusterSearch,
    clusterStatus,
    clusterTimeRange,
    initialRangeDays,
    debouncedSplitSearch,
    splitStatus,
    splitRangeDays,
    showToast,
  ]);

  useEffect(() => {
    const cleanup = fetchData();
    return cleanup;
  }, [fetchData]);

  useEffect(() => {
    if (!isClusterReviewModalOpen) {
      return;
    }

    let cancelled = false;

    startTransition(async () => {
      try {
        const result = await fetchClusterReviewCandidates(clusterReviewPage, clusterReviewPageSize, {
          rangeDays: normalizeReviewRangeDays(initialRangeDays),
        });
        if (!cancelled) {
          setClusterReviewCandidates(result.candidates);
          setClusterReviewTotal(result.total);
        }
      } catch (error) {
        if (!cancelled) {
          showToast(error instanceof Error ? error.message : "聚合待定加载失败。", "error");
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [clusterReviewPage, clusterReviewPageSize, initialRangeDays, isClusterReviewModalOpen, showToast]);

  useEffect(() => {
    if (activeTab !== "clusters") {
      return;
    }

    const timer = window.setTimeout(
      () => setDebouncedClusterSearch(clusterSearch),
      clusterSearch.trim() ? ADMIN_CLUSTER_SEARCH_DEBOUNCE_MS : 0,
    );

    return () => window.clearTimeout(timer);
  }, [activeTab, clusterSearch]);

  useEffect(() => {
    if (activeTab !== "filtered") {
      return;
    }

    const timer = window.setTimeout(
      () => setDebouncedFilteredSearch(filteredSearch),
      filteredSearch.trim() ? ADMIN_CLUSTER_SEARCH_DEBOUNCE_MS : 0,
    );

    return () => window.clearTimeout(timer);
  }, [activeTab, filteredSearch]);

  useEffect(() => {
    if (activeTab !== "splits") {
      return;
    }

    const timer = window.setTimeout(
      () => setDebouncedSplitSearch(splitSearch),
      splitSearch.trim() ? ADMIN_CLUSTER_SEARCH_DEBOUNCE_MS : 0,
    );

    return () => window.clearTimeout(timer);
  }, [activeTab, splitSearch]);

  useEffect(() => {
    if (!isMergeModalOpen) {
      return;
    }

    let cancelled = false;
    setIsMergeCandidatesLoading(true);
    const timer = window.setTimeout(() => {
      startTransition(async () => {
        try {
          const result = await fetchReviewClusters(1, 100, mergeSearchQuery);
          if (!cancelled) {
            setMergeCandidateClusters(result.clusters);
          }
        } catch (error) {
          if (!cancelled) {
            showToast(error instanceof Error ? error.message : "聚合组搜索失败。", "error");
          }
        } finally {
          if (!cancelled) {
            setIsMergeCandidatesLoading(false);
          }
        }
      });
    }, mergeSearchQuery.trim() ? ADMIN_CLUSTER_SEARCH_DEBOUNCE_MS : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isMergeModalOpen, mergeSearchQuery, showToast]);

  const runTransition = useCallback((action: () => Promise<void>) => {
    startTransition(() => {
      void action();
    });
  }, []);

  const postAction = useCallback(async (
    url: string,
    successMessage: string,
    options?: {
      onSuccess?: (payload: ContentReviewActionPayload) => void;
      requiredField?: RequiredActionField;
    },
  ) => {
    try {
      const payload = await postContentReviewAction(url);

      if (options?.requiredField && !payload[options.requiredField]) {
        showToast("操作失败", "error");
        return false;
      }

      options?.onSuccess?.(payload);
      showToast(successMessage, "success");
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "操作失败", "error");
      return false;
    }
  }, [showToast]);

  const filteredSources = useMemo(
    () => Array.from(new Set(filteredItems.map((item) => item.sourceName))).sort((a, b) => a.localeCompare(b)),
    [filteredItems]
  );

  const filteredSourceOptions = useMemo(
    () => [
      { value: "", label: "全部来源" },
      ...filteredSources.map((source) => ({
        value: source,
        label: source,
      })),
    ],
    [filteredSources]
  );

  const reviewReasonOptions = useMemo(
    () => [
      { value: "", label: "全部原因" },
      ...Object.entries(reviewReasonLabels).map(([reason, label]) => ({
        value: reason,
        label,
      })),
    ],
    []
  );

  // Available clusters for merge (exclude current cluster and filter by search)
  const availableClustersForMerge = useMemo(() => {
    const filtered = mergeCandidateClusters.filter((cluster: ClusterDTO) => {
      // Exclude target cluster
      if (cluster.id === mergeTargetId) return false;
      // Only show clusters with items
      if (cluster.itemCount < 1) return false;
      // Apply search filter
      return matchesFuzzySearch(mergeSearchQuery, [
        getClusterDisplayTitle(cluster),
        cluster.title,
        cluster.summary,
        cluster.items[0]?.title,
        cluster.items[0]?.originalTitle,
      ]);
    });
    // Limit to first 20 clusters to avoid overwhelming the UI
    return filtered.slice(0, 20);
  }, [mergeCandidateClusters, mergeTargetId, mergeSearchQuery]);

  // Get target cluster info for merge modal
  const targetClusterForMerge = useMemo(() => {
    return clusters.find((c) => c.id === mergeTargetId) ?? null;
  }, [clusters, mergeTargetId]);

  // Pagination — total comes from API, items are already paginated by the server
  const { totalPages, paginatedItems, currentPage } = useMemo(() => {
    const items =
      activeTab === "filtered"
        ? filteredItems
        : activeTab === "clusters"
          ? clusters
          : aggregationSplits;
    const total =
      activeTab === "filtered"
        ? filteredTotal
        : activeTab === "clusters"
          ? clusterTotal
          : splitTotal;
    const totalPages = Math.ceil(total / pageSize) || 1;
    const currentPage = Math.min(page, totalPages);
    return { totalPages, paginatedItems: items, currentPage };
  }, [
    activeTab,
    filteredItems,
    clusters,
    aggregationSplits,
    filteredTotal,
    clusterTotal,
    splitTotal,
    page,
    pageSize,
  ]);

  const hasFilters =
    activeTab === "filtered"
      ? filteredSearch || filteredSource || filteredReason || filteredRangeDays
      : activeTab === "clusters"
        ? clusterSearch || clusterStatus || clusterTimeRange
        : splitSearch || splitStatus || splitRangeDays;

  const updatePage = useCallback((nextPage: number) => {
    setPage(nextPage);
    onPageStateChange?.({ page: nextPage, pageSize });
  }, [onPageStateChange, pageSize]);

  const updatePageSize = useCallback((nextPageSize: number) => {
    setPageSize(nextPageSize);
    setPage(1);
    onPageStateChange?.({ page: 1, pageSize: nextPageSize });
  }, [onPageStateChange]);

  const handleClearFilters = () => {
    if (activeTab === "filtered") {
      setFilteredSearch("");
      setDebouncedFilteredSearch("");
      setFilteredSource("");
      setFilteredReason("");
      setFilteredRangeDays(null);
    } else {
      if (activeTab === "clusters") {
        setClusterSearch("");
        setClusterStatus("");
        setClusterTimeRange("");
      } else {
        setSplitSearch("");
        setDebouncedSplitSearch("");
        setSplitStatus("");
        setSplitRangeDays(null);
      }
    }
    setPage(1);
  };

  const handleOpenFilteredDetail = (item: ReviewItemDTO) => {
    setSelectedFilteredItem(item);
    setIsFilteredDetailOpen(true);
  };

  const handleCloseFilteredDetail = () => {
    setIsFilteredDetailOpen(false);
    setSelectedFilteredItem(null);
  };

  const handleOpenClusterDetail = async (cluster: ClusterDTO) => {
    try {
      setSelectedCluster((await fetchAdminCluster(cluster.id)) ?? cluster);
    } catch {
      setSelectedCluster(cluster);
    }
    setIsClusterDetailOpen(true);
  };

  const handleOpenClusterReviewDetail = async (cluster: ClusterReviewCandidateDTO["leftCluster"]) => {
    const fallbackCluster: ClusterDTO = {
      ...cluster,
      items: [],
    };

    try {
      setSelectedCluster((await fetchAdminCluster(cluster.id)) ?? fallbackCluster);
    } catch {
      setSelectedCluster(fallbackCluster);
    }
    setIsClusterDetailOpen(true);
  };

  const handleCloseClusterDetail = () => {
    setIsClusterDetailOpen(false);
    setSelectedCluster(null);
  };

  const handleOpenSplitDetail = async (item: AggregationSplitParentDTO) => {
    try {
      setSelectedSplit((await fetchAggregationSplitDetail(item.id)) ?? item);
    } catch {
      setSelectedSplit(item);
    }
    setIsSplitDetailOpen(true);
  };

  const handleCloseSplitDetail = () => {
    setIsSplitDetailOpen(false);
    setSelectedSplit(null);
  };

  const handleOpenClusterReview = () => {
    setClusterReviewPage(1);
    setIsClusterReviewModalOpen(true);
  };

  const handleCloseClusterReview = () => {
    setIsClusterReviewModalOpen(false);
  };

  const handleRestoreItem = (itemId: string) => {
    runTransition(async () => {
      await executeWithPendingId(itemId, setRestoringItemId, async () => {
        await postAction(`/api/admin/items/${itemId}/restore`, "内容已恢复。", {
          onSuccess: () => {
            setFilteredItems((current) => current.filter((entry) => entry.id !== itemId));
            handleCloseFilteredDetail();
          },
        });
      });
    });
  };

  const handleReanalyzeItem = (itemId: string) => {
    runTransition(async () => {
      await executeWithPendingId(itemId, setReanalyzingItemId, async () => {
        await postAction(`/api/admin/items/${itemId}/reanalyze`, "已创建后台任务，正在处理中。", {
          requiredField: "taskRun",
        });
      });
    });
  };

  const handleRegenerateSummary = (clusterId: string) => {
    runTransition(async () => {
      await executeWithPendingId(clusterId, setRegeneratingClusterId, async () => {
        await postAction(`/api/admin/clusters/${clusterId}/regenerate-summary`, "已创建后台任务，正在处理中。", {
          requiredField: "taskRun",
          onSuccess: (payload) => {
            if (payload.taskRun?.id) {
              onTaskCreated?.(payload.taskRun.id, { page: currentPage, pageSize });
            }
          },
        });
      });
    });
  };

  const handleToggleClusterStatus = (clusterId: string, currentStatus: ClusterDTO["status"]) => {
    const action = currentStatus === "hidden" ? "restore" : "hide";
    const message = currentStatus === "hidden" ? "聚合组已恢复。" : "聚合组已隐藏。";
    runTransition(async () => {
      await executeWithPendingId(clusterId, setTogglingClusterId, async () => {
        await postAction(`/api/admin/clusters/${clusterId}/${action}`, message, {
          requiredField: "cluster",
          onSuccess: (payload) => {
            setClusters((current) =>
              current.map((entry) => (entry.id === clusterId ? payload.cluster ?? entry : entry)),
            );
            if (selectedCluster?.id === clusterId && payload.cluster) {
              setSelectedCluster(payload.cluster);
            }
          },
        });
      });
    });
  };

  const handleDetachItem = (clusterId: string, itemId: string) => {
    runTransition(async () => {
      await postAction(`/api/admin/clusters/${clusterId}/items/${itemId}/detach`, "已移出聚合组。", {
        requiredField: "cluster",
        onSuccess: (payload) => {
          setClusters((current) =>
            current.map((entry) => (entry.id === clusterId ? payload.cluster ?? entry : entry)),
          );
          if (selectedCluster?.id === clusterId && payload.cluster) {
            setSelectedCluster(payload.cluster);
          }
        },
      });
    });
  };

  const handleSplitCluster = (clusterId: string) => {
    runTransition(async () => {
      await executeWithPendingId(clusterId, setSplittingClusterId, async () => {
        const succeeded = await postAction(`/api/admin/clusters/${clusterId}/split`, "已拆分为单条目聚合。", {
          onSuccess: () => {
            setClusters((current) => current.filter((entry) => entry.id !== clusterId));
            if (selectedCluster?.id === clusterId) {
              handleCloseClusterDetail();
            }
          },
        });

        if (succeeded) {
          fetchData();
        }
      });
    });
  };

  const handleCancelAggregationSplit = (parentItemId: string) => {
    runTransition(async () => {
      await executeWithPendingId(parentItemId, setCancellingSplitId, async () => {
        const succeeded = await postAction(
          `/api/admin/items/aggregation/${parentItemId}/cancel`,
          "已取消聚合拆分。",
        );

        if (succeeded) {
          setAggregationSplits((current) => current.filter((entry) => entry.id !== parentItemId));
          setSplitTotal((current) => Math.max(0, current - 1));
          if (selectedSplit?.id === parentItemId) {
            handleCloseSplitDetail();
          }
          fetchData();
        }
      });
    });
  };

  // Confirmation handlers
  const openConfirmRestore = (itemId: string) => {
    const item = filteredItems.find((i) => i.id === itemId);
    setConfirmModal({
      isOpen: true,
      title: "确认恢复内容",
      message: `确定要恢复内容 "${item?.title ?? ""}" 吗？`,
      confirmText: "恢复",
      variant: "primary",
      onConfirm: () => {
        handleRestoreItem(itemId);
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  const openConfirmReanalyze = (itemId: string) => {
    const item = filteredItems.find((i) => i.id === itemId);
    setConfirmModal({
      isOpen: true,
      title: "确认重新 AI 判定",
      message: `确定要重新 AI 判定内容 "${item?.title ?? ""}" 吗？`,
      confirmText: "重新判定",
      variant: "primary",
      onConfirm: () => {
        handleReanalyzeItem(itemId);
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  const openConfirmRegenerate = (clusterId: string) => {
    const cluster = clusters.find((c) => c.id === clusterId);
    setConfirmModal({
      isOpen: true,
      title: "确认重新生成摘要",
      message: `确定要重新生成聚合 "${cluster?.title ?? ""}" 的摘要吗？`,
      confirmText: "重新生成",
      variant: "primary",
      onConfirm: () => {
        handleRegenerateSummary(clusterId);
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  const openConfirmToggleStatus = (clusterId: string, currentStatus: ClusterDTO["status"]) => {
    const cluster = clusters.find((c) => c.id === clusterId);
    const isHidden = currentStatus === "hidden";
    setConfirmModal({
      isOpen: true,
      title: isHidden ? "确认恢复聚合" : "确认隐藏聚合",
      message: isHidden
        ? `确定要恢复显示聚合 "${cluster?.title ?? ""}" 吗？`
        : `确定要隐藏聚合 "${cluster?.title ?? ""}" 吗？`,
      confirmText: isHidden ? "恢复" : "隐藏",
      variant: isHidden ? "primary" : "danger",
      onConfirm: () => {
        handleToggleClusterStatus(clusterId, currentStatus);
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  const openConfirmDetach = (clusterId: string, itemId: string) => {
    const cluster = clusters.find((c) => c.id === clusterId);
    const item = cluster?.items.find((i) => i.id === itemId);
    setConfirmModal({
      isOpen: true,
      title: "确认移出条目",
      message: `确定要将内容 "${item?.title ?? ""}" 移出聚合组吗？`,
      confirmText: "移出",
      variant: "danger",
      onConfirm: () => {
        handleDetachItem(clusterId, itemId);
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  const openConfirmSplit = (clusterId: string) => {
    const cluster = selectedCluster?.id === clusterId ? selectedCluster : clusters.find((c) => c.id === clusterId);
    setConfirmModal({
      isOpen: true,
      title: "确认全部拆分",
      message: `确定要将聚合 "${cluster?.title ?? ""}" 的 ${cluster?.itemCount ?? 0} 个条目全部拆成单聚合吗？`,
      confirmText: "全部拆分",
      variant: "danger",
      onConfirm: () => {
        handleSplitCluster(clusterId);
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  const openConfirmCancelSplit = (parentItemId: string) => {
    const item = selectedSplit?.id === parentItemId ? selectedSplit : aggregationSplits.find((entry) => entry.id === parentItemId);
    setConfirmModal({
      isOpen: true,
      title: "确认取消拆分",
      message: `确定要取消 "${item?.title ?? ""}" 的聚合拆分吗？父条目会重新进入内容流，${item?.childCount ?? 0} 个子事件会被过滤。`,
      confirmText: "取消拆分",
      variant: "danger",
      onConfirm: () => {
        handleCancelAggregationSplit(parentItemId);
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  const closeConfirmModal = () => {
    setConfirmModal((prev) => ({ ...prev, isOpen: false }));
  };

  // Merge handlers
  const handleOpenMergeModal = (targetClusterId: string) => {
    setMergeTargetId(targetClusterId);
    setMergeSearchQuery("");
    setMergeSourceIds(new Set());
    setMergeCandidateClusters([]);
    setIsMergeCandidatesLoading(false);
    setIsMergeModalOpen(true);
  };

  const handleCloseMergeModal = () => {
    setIsMergeModalOpen(false);
    setMergeTargetId(null);
    setMergeSourceIds(new Set());
    setMergeCandidateClusters([]);
    setIsMergeCandidatesLoading(false);
  };

  const handleToggleMergeSource = (clusterId: string) => {
    setMergeSourceIds((prev) => {
      const next = new Set(prev);
      if (next.has(clusterId)) {
        next.delete(clusterId);
      } else {
        next.add(clusterId);
      }
      return next;
    });
  };

  const handleExecuteMerge = async () => {
    if (!mergeTargetId || mergeSourceIds.size === 0) {
      showToast("请至少选择一个要合并的聚合组", "error");
      return;
    }

    setMergingClusterId(mergeTargetId);
    try {
      const result = await mergeReviewClusters({
        targetClusterId: mergeTargetId,
        sourceClusterIds: Array.from(mergeSourceIds),
      });

      showToast(`成功合并 ${result.itemsMoved} 个条目`, "success");
      handleCloseMergeModal();
      handleCloseClusterDetail();
      fetchData();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "合并请求失败", "error");
    } finally {
      setMergingClusterId(null);
    }
  };

  const handleMergeReviewCandidate = (candidateId: string) => {
    runTransition(async () => {
      await executeWithPendingId(candidateId, setReviewCandidatePendingId, async () => {
        try {
          const result = await mergeClusterReviewCandidate(candidateId);
          showToast(`待定合并完成，移动 ${result.itemsMoved} 个条目。`, "success");
          await loadClusterReviewCandidates();
          fetchData();
        } catch (error) {
          showToast(error instanceof Error ? error.message : "待定合并失败", "error");
        }
      });
    });
  };

  const handleIgnoreReviewCandidate = (candidateId: string) => {
    runTransition(async () => {
      await executeWithPendingId(candidateId, setReviewCandidatePendingId, async () => {
        try {
          await ignoreClusterReviewCandidate(candidateId);
          showToast("已忽略并写入不可合并约束。", "success");
          await loadClusterReviewCandidates();
        } catch (error) {
          showToast(error instanceof Error ? error.message : "待定忽略失败", "error");
        }
      });
    });
  };

  const openConfirmMergeReviewCandidate = (candidateId: string) => {
    const candidate = clusterReviewCandidates.find((entry) => entry.id === candidateId);
    const sourceCluster = candidate
      ? candidate.sourceClusterId === candidate.leftCluster.id
        ? candidate.leftCluster
        : candidate.rightCluster
      : null;
    const targetCluster = candidate
      ? candidate.targetClusterId === candidate.leftCluster.id
        ? candidate.leftCluster
        : candidate.rightCluster
      : null;
    setConfirmModal({
      isOpen: true,
      title: "确认合并待定",
      message: `确定要合并 "${sourceCluster?.title ?? ""}" 到 "${targetCluster?.title ?? ""}" 吗？确认后会移动源聚合条目。`,
      confirmText: "合并",
      variant: "primary",
      onConfirm: () => {
        handleMergeReviewCandidate(candidateId);
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  const openConfirmIgnoreReviewCandidate = (candidateId: string) => {
    const candidate = clusterReviewCandidates.find((entry) => entry.id === candidateId);
    setConfirmModal({
      isOpen: true,
      title: "确认忽略待定",
      message: `确定要忽略 "${candidate?.leftCluster.title ?? ""}" 与 "${candidate?.rightCluster.title ?? ""}" 的待定合并吗？确认后会写入不可合并约束。`,
      confirmText: "忽略",
      variant: "danger",
      onConfirm: () => {
        handleIgnoreReviewCandidate(candidateId);
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            {activeTab === "filtered"
              ? "过滤内容"
              : activeTab === "clusters"
                ? "聚合管理"
                : "聚合拆分"}
          </h2>
          <p className="text-sm text-[var(--muted)]">
            {activeTab === "filtered"
              ? "查看和管理被过滤的内容"
              : activeTab === "clusters"
                ? "管理内容聚合组"
                : "管理聚合拆分结果"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {activeTab === "clusters" ? (
            <Button onClick={handleOpenClusterReview} variant="secondary" disabled={isPending}>
              聚合待定{clusterReviewTotal > 0 ? `（${clusterReviewTotal}）` : ""}
            </Button>
          ) : null}
          <Button onClick={handleClearFilters} variant="secondary" disabled={!hasFilters}>
            清空筛选
          </Button>
          <Button onClick={fetchData} variant="secondary" disabled={isPending}>
            刷新
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div
        className={cx(
          "grid grid-cols-1 gap-4",
          activeTab === "filtered" ? "md:grid-cols-4" : "md:grid-cols-3",
        )}
      >
        <FilterInput
          id="content-review-keyword"
          label="关键词"
          ariaLabel="审核关键词"
          placeholder={
            activeTab === "filtered"
              ? "搜索标题、摘要或复核说明"
              : activeTab === "clusters"
                ? "搜索聚合标题或子项标题"
                : "搜索父项标题、摘要或子事件"
          }
          value={
            activeTab === "filtered"
              ? filteredSearch
              : activeTab === "clusters"
                ? clusterSearch
                : splitSearch
          }
          onChange={(value) => {
            if (activeTab === "filtered") {
              setFilteredSearch(value);
            } else if (activeTab === "clusters") {
              setClusterSearch(value);
            } else {
              setSplitSearch(value);
            }
            setPage(1);
          }}
        />

        {activeTab === "filtered" ? (
          <>
            <FilterSelect
              id="content-review-source"
              label="来源"
              ariaLabel="审核来源"
              value={filteredSource}
              onChange={(value) => {
                setFilteredSource(value);
                setPage(1);
              }}
              showSearch={false}
              options={filteredSourceOptions}
            />

            <FilterSelect
              id="content-review-reason"
              label="原因"
              ariaLabel="过滤原因"
              value={filteredReason}
              onChange={(value) => {
                setFilteredReason(value);
                setPage(1);
              }}
              showSearch={false}
              options={reviewReasonOptions}
            />

            <FilterSelect
              id="content-review-filtered-range"
              label="处理时间"
              ariaLabel="过滤内容处理时间"
              value={filteredRangeDays ? String(filteredRangeDays) : ""}
              onChange={(value) => {
                setFilteredRangeDays(normalizeReviewRangeDays(Number(value)));
                setPage(1);
              }}
              showSearch={false}
              options={reviewRangeOptions}
            />
          </>
        ) : activeTab === "clusters" ? (
          <>
            <FilterSelect
              id="content-review-status"
              label="状态"
              ariaLabel="聚合状态"
              value={clusterStatus}
              onChange={(value) => {
                setClusterStatus(value as ClusterDTO["status"] | "");
                setPage(1);
              }}
              showSearch={false}
              options={[
                { value: "", label: "全部状态" },
                { value: "active", label: "显示中" },
                { value: "hidden", label: "已隐藏" },
              ]}
            />

            <FilterSelect
              id="content-review-time-range"
              label="最新更新时间"
              ariaLabel="最新更新时间范围"
              value={clusterTimeRange}
              onChange={(value) => {
                setClusterTimeRange(value as TimeRangeFilter);
                setPage(1);
              }}
              showSearch={false}
              options={timeRangeOptions}
            />
          </>
        ) : (
          <>
            <FilterSelect
              id="content-review-split-status"
              label="状态"
              ariaLabel="拆分状态"
              value={splitStatus}
              onChange={(value) => {
                setSplitStatus(value);
                setPage(1);
              }}
              showSearch={false}
              options={splitStatusOptions}
            />

            <FilterSelect
              id="content-review-split-range"
              label="拆分时间"
              ariaLabel="聚合拆分时间"
              value={splitRangeDays ? String(splitRangeDays) : ""}
              onChange={(value) => {
                setSplitRangeDays(normalizeReviewRangeDays(Number(value)));
                setPage(1);
              }}
              showSearch={false}
              options={reviewRangeOptions}
            />
          </>
        )}
      </div>

      {/* List */}
      {isPending ? (
        <EmptyState>加载中...</EmptyState>
      ) : paginatedItems.length === 0 ? (
        <EmptyState>
          {hasFilters
            ? "暂无匹配内容"
            : activeTab === "filtered"
              ? "当前没有待处理的过滤内容"
              : activeTab === "clusters"
                ? "当前没有可管理的聚合结果"
                : "当前没有可复核的聚合拆分"}
        </EmptyState>
      ) : activeTab === "filtered" ? (
        <div className="w-full overflow-hidden">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-[var(--bg-muted)] text-[var(--muted)]">
              <tr>
                <th className="w-[34%] text-left px-4 py-3">标题</th>
                <th className="w-[22%] whitespace-nowrap text-left px-4 py-3">来源</th>
                <th className="w-[14%] whitespace-nowrap text-left px-4 py-3">原因</th>
                <th className="w-[8%] whitespace-nowrap text-left px-4 py-3">质量</th>
                <th className="w-[12%] whitespace-nowrap text-left px-4 py-3">时间</th>
                <th className="w-[10%] whitespace-nowrap text-right px-4 py-3">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--line)]">
              {(paginatedItems as ReviewItemDTO[]).map((item) => (
                <tr key={item.id} className="hover:bg-[var(--bg-muted)] transition-colors">
                  <td className="px-4 py-3 max-w-0">
                    <button
                      type="button"
                      onClick={() => handleOpenFilteredDetail(item)}
                      className="w-full text-left group"
                    >
                      <div className="font-medium text-[var(--foreground)] group-hover:text-[var(--accent)] transition-colors truncate">
                        {item.title}
                      </div>
                    </button>
                  </td>
                  <td className="px-4 py-3 max-w-0 text-[var(--text-2)]">
                    <div className="truncate" title={item.sourceName}>{item.sourceName}</div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusTag tone={reviewReasonTone[item.moderationReason ?? "other"]}>
                      {getFilteredItemReasonLabel(item)}
                    </StatusTag>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-2)]">{item.qualityScore}</td>
                  <td className="px-4 py-3 text-[var(--text-3)] text-xs">{formatDate(item.publishedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        onClick={() => openConfirmRestore(item.id)}
                        variant="ghost"
                        size="sm"
                        title="恢复内容"
                        disabled={restoringItemId === item.id}
                      >
                        <IconCheck className={cx("h-4 w-4 text-[var(--success-ink)]", restoringItemId === item.id && "animate-pulse")} />
                      </IconButton>
                      <IconButton
                        onClick={() => openConfirmReanalyze(item.id)}
                        variant="ghost"
                        size="sm"
                        title="重新 AI 判定"
                        disabled={reanalyzingItemId === item.id}
                      >
                        <IconRotateCw className={cx("h-4 w-4", reanalyzingItemId === item.id && "animate-spin")} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : activeTab === "clusters" ? (
        <div className="w-full overflow-x-auto">
          <table className="w-full table-auto text-sm">
            <thead className="bg-[var(--bg-muted)] text-[var(--muted)]">
              <tr>
                <th className="w-[35%] text-left px-4 py-3">标题</th>
                <th className="w-[10%] whitespace-nowrap text-left px-4 py-3">内容数</th>
                <th className="w-[12%] whitespace-nowrap text-left px-4 py-3">状态</th>
                <th className="w-[10%] whitespace-nowrap text-left px-4 py-3">质量</th>
                <th className="w-[15%] whitespace-nowrap text-left px-4 py-3">最新更新</th>
                <th className="w-[18%] whitespace-nowrap text-right px-4 py-3">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--line)]">
              {(paginatedItems as ClusterDTO[]).map((cluster) => (
                <tr key={cluster.id} className="hover:bg-[var(--bg-muted)] transition-colors">
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => handleOpenClusterDetail(cluster)}
                      className="w-full text-left group"
                    >
                      <div className="font-medium text-[var(--foreground)] group-hover:text-[var(--accent)] transition-colors truncate max-w-[320px]">
                        {cluster.title}
                      </div>
                    </button>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-2)]">{cluster.itemCount} 条</td>
                  <td className="px-4 py-3">
                    <StatusTag tone={clusterStatusTone[cluster.status]}>
                      {clusterStatusLabels[cluster.status]}
                    </StatusTag>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-2)]">{cluster.score}</td>
                  <td className="px-4 py-3 text-[var(--text-3)] text-xs">
                    {formatDate(getClusterLatestItemUpdatedAt(cluster))}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        onClick={() => handleOpenMergeModal(cluster.id)}
                        variant="ghost"
                        size="sm"
                        title="合并其他聚合组"
                        disabled={false}
                      >
                        <IconMerge className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        onClick={() => openConfirmRegenerate(cluster.id)}
                        variant="ghost"
                        size="sm"
                        title="重新生成摘要"
                        disabled={regeneratingClusterId === cluster.id}
                      >
                        <IconRotateCw className={cx("h-4 w-4", regeneratingClusterId === cluster.id && "animate-spin")} />
                      </IconButton>
                      <IconButton
                        onClick={() => openConfirmSplit(cluster.id)}
                        variant="ghost"
                        size="sm"
                        title="全部拆分"
                        disabled={splittingClusterId === cluster.id}
                      >
                        <IconSplit className={cx("h-4 w-4 text-[var(--danger-ink)]", splittingClusterId === cluster.id && "animate-pulse")} />
                      </IconButton>
                      <IconButton
                        onClick={() => openConfirmToggleStatus(cluster.id, cluster.status)}
                        variant="ghost"
                        size="sm"
                        title={cluster.status === "hidden" ? "恢复显示" : "隐藏聚合"}
                        disabled={togglingClusterId === cluster.id}
                      >
                        {cluster.status === "hidden" ? (
                          <IconCheck className={cx("h-4 w-4 text-[var(--success-ink)]", togglingClusterId === cluster.id && "animate-pulse")} />
                        ) : (
                          <IconX className={cx("h-4 w-4 text-[var(--danger-ink)]", togglingClusterId === cluster.id && "animate-pulse")} />
                        )}
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="w-full overflow-x-auto">
          <table className="w-full table-auto text-sm">
            <thead className="bg-[var(--bg-muted)] text-[var(--muted)]">
              <tr>
                <th className="w-[38%] text-left px-4 py-3">标题</th>
                <th className="w-[16%] whitespace-nowrap text-left px-4 py-3">来源</th>
                <th className="w-[12%] whitespace-nowrap text-left px-4 py-3">子事件</th>
                <th className="w-[12%] whitespace-nowrap text-left px-4 py-3">状态</th>
                <th className="w-[12%] whitespace-nowrap text-left px-4 py-3">拆分时间</th>
                <th className="w-[10%] whitespace-nowrap text-right px-4 py-3">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--line)]">
              {(paginatedItems as AggregationSplitParentDTO[]).map((item) => (
                <tr key={item.id} className="hover:bg-[var(--bg-muted)] transition-colors">
                  <td className="px-4 py-3 max-w-0">
                    <button
                      type="button"
                      onClick={() => handleOpenSplitDetail(item)}
                      className="w-full text-left group"
                    >
                      <div className="font-medium text-[var(--foreground)] group-hover:text-[var(--accent)] transition-colors truncate">
                        {item.title}
                      </div>
                    </button>
                  </td>
                  <td className="px-4 py-3 max-w-0 text-[var(--text-2)]">
                    <div className="truncate" title={item.sourceName}>{item.sourceName}</div>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-2)]">{item.childCount} 条</td>
                  <td className="px-4 py-3">
                    <StatusTag
                      tone={getSplitStatusTone(item.aggregationParseStatus)}
                      className="min-w-[3.75rem] justify-center whitespace-nowrap"
                    >
                      {getSplitStatusLabel(item.aggregationParseStatus)}
                    </StatusTag>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-3)] text-xs">
                    {formatDate(item.aggregationCheckedAt ?? item.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        onClick={() => handleOpenSplitDetail(item)}
                        variant="ghost"
                        size="sm"
                        title="查看拆分"
                      >
                        <IconEye className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        onClick={() => openConfirmCancelSplit(item.id)}
                        variant="ghost"
                        size="sm"
                        title="取消拆分"
                        disabled={cancellingSplitId === item.id}
                      >
                        <IconSplit className={cx("h-4 w-4 text-[var(--danger-ink)]", cancellingSplitId === item.id && "animate-pulse")} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {(activeTab === "filtered" ? filteredTotal : activeTab === "clusters" ? clusterTotal : splitTotal) > 0 && (
        <PaginationControls
          totalItems={activeTab === "filtered" ? filteredTotal : activeTab === "clusters" ? clusterTotal : splitTotal}
          page={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          onPageChange={updatePage}
          onPageSizeChange={updatePageSize}
        />
      )}

      {/* Detail Modals */}
      {selectedFilteredItem && (
        <FilteredItemDetailModal
          isOpen={isFilteredDetailOpen}
          onClose={handleCloseFilteredDetail}
          item={selectedFilteredItem}
          onRestore={() => openConfirmRestore(selectedFilteredItem.id)}
          onReanalyze={() => openConfirmReanalyze(selectedFilteredItem.id)}
          isRestoring={restoringItemId === selectedFilteredItem?.id}
          isReanalyzing={reanalyzingItemId === selectedFilteredItem?.id}
        />
      )}

      {selectedCluster && (
        <ClusterDetailModal
          isOpen={isClusterDetailOpen}
          onClose={handleCloseClusterDetail}
          cluster={selectedCluster}
          onRegenerateSummary={() => openConfirmRegenerate(selectedCluster.id)}
          onToggleStatus={() => openConfirmToggleStatus(selectedCluster.id, selectedCluster.status)}
          onDetachItem={(itemId) => openConfirmDetach(selectedCluster.id, itemId)}
          onMerge={() => handleOpenMergeModal(selectedCluster.id)}
          onSplit={() => openConfirmSplit(selectedCluster.id)}
          isRegenerating={regeneratingClusterId === selectedCluster?.id}
          isTogglingStatus={togglingClusterId === selectedCluster?.id}
          isSplitting={splittingClusterId === selectedCluster?.id}
        />
      )}

      {selectedSplit && (
        <AggregationSplitDetailModal
          isOpen={isSplitDetailOpen}
          onClose={handleCloseSplitDetail}
          item={selectedSplit}
          onCancelSplit={() => openConfirmCancelSplit(selectedSplit.id)}
          isCancelling={cancellingSplitId === selectedSplit.id}
        />
      )}

      <ClusterReviewModal
        candidates={clusterReviewCandidates}
        totalCount={clusterReviewTotal}
        page={clusterReviewPage}
        pageSize={clusterReviewPageSize}
        isOpen={isClusterReviewModalOpen}
        isBusy={isPending}
        pendingId={reviewCandidatePendingId}
        onClose={handleCloseClusterReview}
        onPageChange={setClusterReviewPage}
        onPageSizeChange={(nextPageSize) => {
          setClusterReviewPageSize(nextPageSize);
          setClusterReviewPage(1);
        }}
        onRefresh={() => {
          runTransition(async () => {
            try {
              await loadClusterReviewCandidates();
            } catch (error) {
              showToast(error instanceof Error ? error.message : "聚合待定加载失败。", "error");
            }
          });
        }}
        onOpenCluster={handleOpenClusterReviewDetail}
        onMerge={openConfirmMergeReviewCandidate}
        onIgnore={openConfirmIgnoreReviewCandidate}
      />

      {/* Confirmation Modal */}
      <ModalShell
        isOpen={confirmModal.isOpen}
        onClose={closeConfirmModal}
        title={confirmModal.title}
        widthClassName="max-w-md"
        headerClassName="border-b border-[color:var(--line)] p-4"
        bodyClassName="p-4"
        footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={closeConfirmModal} variant="secondary">
              取消
            </Button>
            <Button
              onClick={confirmModal.onConfirm}
              variant={confirmModal.variant === "danger" ? "danger" : "primary"}
            >
              {confirmModal.confirmText ?? "确认"}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-[var(--text-2)]">{confirmModal.message}</p>
      </ModalShell>

      <ContentReviewMergeModal
        isOpen={isMergeModalOpen}
        onClose={handleCloseMergeModal}
        targetCluster={targetClusterForMerge}
        availableClusters={availableClustersForMerge}
        selectedClusterIds={mergeSourceIds}
        searchQuery={mergeSearchQuery}
        isLoadingCandidates={isMergeCandidatesLoading}
        isMerging={mergingClusterId === mergeTargetId}
        onSearchQueryChange={setMergeSearchQuery}
        onToggleSource={handleToggleMergeSource}
        onExecuteMerge={handleExecuteMerge}
      />
    </div>
  );
}

interface ContentReviewPanelProps {
  embedMode?: boolean;
  activeTab?: ReviewTab;
  initialPage?: number | null;
  initialPageSize?: number | null;
  initialRangeDays?: ReviewRangeDays | null;
  initialOpenClusterReview?: boolean;
  onPageStateChange?: (state: { page: number; pageSize: number }) => void;
  onTaskCreated?: (taskId: string, state: { page: number; pageSize: number }) => void;
}

export function ContentReviewPanel({
  embedMode,
  activeTab = "filtered",
  initialPage = null,
  initialPageSize = null,
  initialRangeDays = null,
  initialOpenClusterReview = false,
  onPageStateChange,
  onTaskCreated,
}: ContentReviewPanelProps) {
  if (embedMode) {
    return (
      <ContentReviewContent
        key={activeTab}
        initialTab={activeTab}
        initialPage={initialPage}
        initialPageSize={initialPageSize}
        initialRangeDays={initialRangeDays}
        initialOpenClusterReview={initialOpenClusterReview}
        onPageStateChange={onPageStateChange}
        onTaskCreated={onTaskCreated}
      />
    );
  }

  return (
    <PageShell header={{ activeNav: null, isAdmin: true }} contentClassName="gap-3">
      <ContentReviewContent key={activeTab} initialTab={activeTab} />
    </PageShell>
  );
}
