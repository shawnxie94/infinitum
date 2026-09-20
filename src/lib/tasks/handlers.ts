import type { BackgroundTaskRun } from "@prisma/client";

import { executeClusterMergeCleanPairPrecomputeTask, executeClusterSummaryTask } from "@/lib/clusters/service";
import { executeItemCleanupTask, executeItemReanalyzeTask, executeItemRegenerationTask, executeItemReparseAggregationsTask } from "@/lib/items/service";
import { executePrecomputeTask } from "@/lib/precompute/service";

/**
 * P7 薄 dispatch（spec D10）：3 个 AI 批量 kind（daily_report_generate / ingestion /
 * item_processing_recovery）已迁 Mastra workflow，由 src/lib/tasks/routing.ts
 * 在进入本文件之前路由；这里只保留 8 个 plain kind。
 */
export async function executeTaskRun(taskRun: BackgroundTaskRun) {
  switch (taskRun.kind) {
    case "precompute":
      await executePrecomputeTask(taskRun);
      return;
    case "item_regenerate_translation":
      await executeItemRegenerationTask(taskRun, "translation");
      return;
    case "item_regenerate_summary":
      await executeItemRegenerationTask(taskRun, "summary");
      return;
    case "item_reanalyze":
      await executeItemReanalyzeTask(taskRun);
      return;
    case "cluster_regenerate_summary":
      await executeClusterSummaryTask(taskRun);
      return;
    case "cluster_merge_precompute_clean_pairs":
      await executeClusterMergeCleanPairPrecomputeTask(taskRun);
      return;
    case "item_cleanup":
      await executeItemCleanupTask(taskRun);
      return;
    case "item_reparse_aggregations":
      await executeItemReparseAggregationsTask(taskRun);
      return;
  }
}
