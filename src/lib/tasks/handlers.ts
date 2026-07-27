import type { BackgroundTaskRun } from "@prisma/client";

import { executeClusterMergeCleanPairPrecomputeTask, executeClusterSummaryTask } from "@/lib/clusters/service";
import { executeDailyReportTask } from "@/lib/daily-report/service";
import { runIngestionTask } from "@/lib/ingestion/service";
import { executeItemProcessingRecoveryTask } from "@/lib/items/processing-recovery";
import { executeItemCleanupTask, executeItemReanalyzeTask, executeItemRegenerationTask, executeItemReparseAggregationsTask } from "@/lib/items/service";
import { executePrecomputeTask } from "@/lib/precompute/service";

export async function executeTaskRun(taskRun: BackgroundTaskRun) {
  switch (taskRun.kind) {
    case "ingestion":
      await runIngestionTask(taskRun);
      return;
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
    case "item_processing_recovery":
      await executeItemProcessingRecoveryTask(taskRun);
      return;
    case "cluster_regenerate_summary":
      await executeClusterSummaryTask(taskRun);
      return;
    case "cluster_merge_precompute_clean_pairs":
      await executeClusterMergeCleanPairPrecomputeTask(taskRun);
      return;
    case "daily_report_generate":
      await executeDailyReportTask(taskRun);
      return;
    case "item_cleanup":
      await executeItemCleanupTask(taskRun);
      return;
    case "item_reparse_aggregations":
      await executeItemReparseAggregationsTask(taskRun);
      return;
  }
}
