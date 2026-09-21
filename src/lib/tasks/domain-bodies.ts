import type { BackgroundTaskRun } from "@prisma/client";

import { executeClusterMergeCleanPairPrecomputeTask, executeClusterSummaryTask } from "@/lib/clusters/service";
import { executeDailyReportTask } from "@/lib/daily-report/generation";
import { runIngestionTask } from "@/lib/ingestion/service";
import { executeItemProcessingRecoveryTask } from "@/lib/items/processing-recovery";
import { executeItemCleanupTask, executeItemReanalyzeTask, executeItemRegenerationTask, executeItemReparseAggregationsTask } from "@/lib/items/service";
import { executePrecomputeTask } from "@/lib/precompute/service";
import type { TaskBody } from "@infinitum/ai/orchestration/workflow-factory";

/**
 * Domain-owned execution bodies. The host catalog controls which body is
 * exposed as a Mastra task; this table owns the mapping to existing services.
 * No worker path invokes these functions directly anymore.
 */
export const TASK_BODIES: Record<BackgroundTaskRun["kind"], TaskBody> = {
  daily_report_generate: executeDailyReportTask as unknown as TaskBody,
  ingestion: runIngestionTask as unknown as TaskBody,
  item_processing_recovery: executeItemProcessingRecoveryTask as unknown as TaskBody,
  item_reanalyze: async (taskRun) => { await executeItemReanalyzeTask(taskRun as BackgroundTaskRun); },
  item_regenerate_translation: async (taskRun) => { await executeItemRegenerationTask(taskRun as BackgroundTaskRun, "translation"); },
  item_regenerate_summary: async (taskRun) => { await executeItemRegenerationTask(taskRun as BackgroundTaskRun, "summary"); },
  cluster_regenerate_summary: async (taskRun) => { await executeClusterSummaryTask(taskRun as BackgroundTaskRun); },
  precompute: async (taskRun) => { await executePrecomputeTask(taskRun as BackgroundTaskRun); },
  cluster_merge_precompute_clean_pairs: async (taskRun) => { await executeClusterMergeCleanPairPrecomputeTask(taskRun as BackgroundTaskRun); },
  item_cleanup: async (taskRun) => { await executeItemCleanupTask(taskRun as BackgroundTaskRun); },
  item_reparse_aggregations: async (taskRun) => { await executeItemReparseAggregationsTask(taskRun as BackgroundTaskRun); },
};

