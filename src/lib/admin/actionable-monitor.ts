import { listClusterReviewCandidates } from "@/lib/clusters/decisions";
import { prisma } from "@/lib/db";
import { getSourceMonitorSnapshot } from "@/lib/source-monitor/service";
import { listAdminEntitySuggestions } from "@/lib/entities/service";
import type { BackgroundTaskRunStatus } from "@/lib/tasks/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIONABLE_MONITOR_RANGE_DAYS = [1, 3, 7] as const;
const AUTO_ENTITY_CONFIDENCE_THRESHOLD = 0.98;
const MIN_ENTITY_SUGGESTION_AFFECTED_COUNT = 3;

export type ActionableMonitorRangeDays = (typeof ACTIONABLE_MONITOR_RANGE_DAYS)[number];
export type ActionableMonitorSeverity = "critical" | "warning" | "info";
export type ActionableMonitorCategory = "source" | "content" | "entity" | "preference" | "cluster" | "split" | "task";

export type ActionableMonitorItem = {
  id: string;
  category: ActionableMonitorCategory;
  severity: ActionableMonitorSeverity;
  title: string;
  description: string;
  count: number;
  href: string;
  actionLabel: string;
  details: string[];
};

export type ActionableMonitorSnapshot = {
  generatedAt: string;
  rangeDays: ActionableMonitorRangeDays;
  since: string;
  totalCount: number;
  criticalCount: number;
  warningCount: number;
  items: ActionableMonitorItem[];
};

export function normalizeActionableMonitorRangeDays(value: number | string | null | undefined): ActionableMonitorRangeDays {
  const normalizedValue = typeof value === "string" ? Number(value) : value;
  return ACTIONABLE_MONITOR_RANGE_DAYS.includes(normalizedValue as ActionableMonitorRangeDays)
    ? (normalizedValue as ActionableMonitorRangeDays)
    : 1;
}

function getTaskHref(status: BackgroundTaskRunStatus, rangeDays: ActionableMonitorRangeDays) {
  return `/admin?tab=monitoring&section=tasks&status=${status}&rangeDays=${rangeDays}`;
}

export async function getActionableMonitorSnapshot(
  now = new Date(),
  options?: { rangeDays?: number | string | null },
): Promise<ActionableMonitorSnapshot> {
  const rangeDays = normalizeActionableMonitorRangeDays(options?.rangeDays);
  const since = new Date(now.getTime() - rangeDays * DAY_MS);
  const [
    sourceSnapshot,
    filteredItemCount,
    entitySuggestions,
    briefingPreferenceSuggestionCount,
    autoMergeableEntityCount,
    clusterReview,
    aggregationSplitCounts,
    recentIssueTaskCount,
    recentFailedTaskCount,
  ] = await Promise.all([
    getSourceMonitorSnapshot(now, { page: 1, pageSize: 1 }),
    prisma.item.count({
      where: {
        moderationStatus: "filtered",
        updatedAt: { gte: since },
      },
    }),
    listAdminEntitySuggestions({ page: 1, pageSize: 1, sort: "affected_desc" }),
    prisma.briefingPreferenceSuggestion.count({
      where: { status: "pending" },
    }),
    prisma.entitySuggestionCandidate.count({
      where: {
        status: "active",
        confidence: {
          gte: AUTO_ENTITY_CONFIDENCE_THRESHOLD,
        },
        affectedItemCount: {
          gte: MIN_ENTITY_SUGGESTION_AFFECTED_COUNT,
        },
      },
    }),
    listClusterReviewCandidates(1, 1, { since }),
    prisma.item.groupBy({
      by: ["aggregationParseStatus"],
      where: {
        isAggregation: true,
        aggregationParseStatus: {
          in: ["detected", "parsed", "failed"],
        },
        updatedAt: { gte: since },
      },
      _count: { id: true },
    }),
    prisma.backgroundTaskRun.count({
      where: {
        status: { in: ["failed", "partial"] },
        startedAt: { gte: since },
      },
    }),
    prisma.backgroundTaskRun.count({
      where: {
        status: "failed",
        startedAt: { gte: since },
      },
    }),
  ]);

  const sourceAttentionCount = sourceSnapshot.health.attentionSources?.length ?? 0;
  const sourceDetails = (sourceSnapshot.health.attentionSources ?? []).slice(0, 3).map((source) => {
    const reasons = source.attentionReasons?.join("、") || "需要巡检";
    return `${source.name}：${reasons}`;
  });
  const items: ActionableMonitorItem[] = [];

  if (sourceAttentionCount > 0) {
    items.push({
      id: "sources",
      category: "source",
      severity: sourceSnapshot.health.failedCount > 0 ? "critical" : "warning",
      title: "异常信息源",
      description: `${sourceAttentionCount} 个启用信息源当前需要处理，优先看抓取失败、未巡检和长期无新增。`,
      count: sourceAttentionCount,
      href: "/admin?tab=monitoring&section=dashboard&sourceSummary=open",
      actionLabel: "查看",
      details: sourceDetails,
    });
  }

  if (filteredItemCount > 0) {
    items.push({
      id: "filtered-content",
      category: "content",
      severity: "info",
      title: "过滤内容复核",
      description: `近 ${rangeDays} 天有 ${filteredItemCount} 条过滤内容可复核，重点看是否误伤。`,
      count: filteredItemCount,
      href: `/admin?tab=monitoring&section=content&view=filtered&rangeDays=${rangeDays}`,
      actionLabel: "查看",
      details: [],
    });
  }

  if (entitySuggestions.totalCount > 0) {
    items.push({
      id: "entities",
      category: "entity",
      severity: autoMergeableEntityCount > 0 ? "warning" : "info",
      title: "实体治理建议",
      description:
        autoMergeableEntityCount > 0
          ? `当前有 ${entitySuggestions.totalCount} 条实体建议，其中 ${autoMergeableEntityCount} 条可优先合并。`
          : `当前有 ${entitySuggestions.totalCount} 条实体建议等待复核。`,
      count: entitySuggestions.totalCount,
      href: "/admin?tab=monitoring&section=content&view=entities&suggestions=open",
      actionLabel: "查看",
      details: [],
    });
  }

  if (briefingPreferenceSuggestionCount > 0) {
    items.push({
      id: "briefing-preferences",
      category: "preference",
      severity: "info",
      title: "偏好建议",
      description: `当前有 ${briefingPreferenceSuggestionCount} 条事件偏好建议等待复核。`,
      count: briefingPreferenceSuggestionCount,
      href: "/admin?tab=settings&section=content&view=event-briefing&suggestions=open",
      actionLabel: "查看",
      details: [],
    });
  }

  const aggregationSplitTotal = aggregationSplitCounts.reduce((sum, entry) => sum + entry._count.id, 0);
  const aggregationSplitCountByStatus = new Map(
    aggregationSplitCounts.map((entry) => [entry.aggregationParseStatus ?? "", entry._count.id]),
  );
  if (aggregationSplitTotal > 0) {
    const failedCount = aggregationSplitCountByStatus.get("failed") ?? 0;
    const detectedCount = aggregationSplitCountByStatus.get("detected") ?? 0;
    items.push({
      id: "aggregation-splits",
      category: "split",
      severity: failedCount > 0 ? "warning" : "info",
      title: "聚合拆分复核",
      description: `近 ${rangeDays} 天有 ${aggregationSplitTotal} 条聚合拆分记录，失败 ${failedCount} 条、待拆分 ${detectedCount} 条。`,
      count: aggregationSplitTotal,
      href: `/admin?tab=monitoring&section=content&view=splits&rangeDays=${rangeDays}`,
      actionLabel: "查看",
      details: [],
    });
  }

  if (clusterReview.total > 0) {
    items.push({
      id: "clusters",
      category: "cluster",
      severity: "warning",
      title: "聚合待定",
      description: `近 ${rangeDays} 天有 ${clusterReview.total} 组聚合合并候选需要确认。`,
      count: clusterReview.total,
      href: `/admin?tab=monitoring&section=content&view=clusters&review=pending&rangeDays=${rangeDays}`,
      actionLabel: "查看",
      details: [],
    });
  }

  if (recentIssueTaskCount > 0) {
    items.push({
      id: "tasks",
      category: "task",
      severity: "critical",
      title: "近期失败任务",
      description: `近 ${rangeDays} 天有 ${recentIssueTaskCount} 个失败或部分成功任务，需要查看错误后决定是否重跑。`,
      count: recentIssueTaskCount,
      href: getTaskHref(recentFailedTaskCount > 0 ? "failed" : "partial", rangeDays),
      actionLabel: "查看",
      details: [],
    });
  }

  const criticalCount = items.filter((item) => item.severity === "critical").length;
  const warningCount = items.filter((item) => item.severity === "warning").length;

  return {
    generatedAt: now.toISOString(),
    rangeDays,
    since: since.toISOString(),
    totalCount: items.reduce((sum, item) => sum + item.count, 0),
    criticalCount,
    warningCount,
    items,
  };
}
