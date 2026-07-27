import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { getBackgroundTaskMonitorSnapshot } from "@/lib/tasks/service";
import type {
  BackgroundTaskRunKind,
  BackgroundTaskRunStatus,
} from "@/lib/tasks/types";

const TASK_STATUSES = new Set(["queued", "running", "succeeded", "failed", "partial", "cancelled"]);
const TASK_KINDS = new Set([
  "ingestion",
  "precompute",
  "item_regenerate_translation",
  "item_regenerate_summary",
  "item_reanalyze",
  "item_processing_recovery",
  "cluster_regenerate_summary",
  "cluster_merge_precompute_clean_pairs",
  "daily_report_generate",
  "item_cleanup",
  "item_reparse_aggregations",
]);
const TASK_TIME_RANGES = new Set(["today", "week", "month"]);
const TASK_RANGE_DAYS = new Set([1, 3, 7]);

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Number(searchParams.get("page")) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get("pageSize")) || 20));
    const status = searchParams.get("status")?.trim() ?? "";
    const kind = searchParams.get("kind")?.trim() ?? "";
    const timeRange = searchParams.get("timeRange")?.trim() ?? "";
    const rangeDays = Number(searchParams.get("rangeDays"));

    return Response.json(
      await getBackgroundTaskMonitorSnapshot(new Date(), {
        page,
        pageSize,
        status: TASK_STATUSES.has(status) ? (status as BackgroundTaskRunStatus) : null,
        kind: TASK_KINDS.has(kind) ? (kind as BackgroundTaskRunKind) : null,
        timeRange: TASK_TIME_RANGES.has(timeRange) ? (timeRange as "today" | "week" | "month") : null,
        rangeDays: TASK_RANGE_DAYS.has(rangeDays) ? (rangeDays as 1 | 3 | 7) : null,
      }),
    );
  } catch (error) {
    return adminErrorResponse(error);
  }
}
