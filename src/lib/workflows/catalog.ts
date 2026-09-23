import type { BackgroundTaskRun } from "@prisma/client";

import type { DomainTaskDefinition } from "@infinitum/ai/orchestration/task-definition";
import { CLUSTER_WORKFLOW_DEFINITIONS } from "@/lib/workflows/clusters";
import { DAILY_REPORT_WORKFLOW_DEFINITIONS } from "@/lib/workflows/daily-report";
import { INGESTION_WORKFLOW_DEFINITIONS } from "@/lib/workflows/ingestion";
import { ITEM_WORKFLOW_DEFINITIONS } from "@/lib/workflows/items";
import { PRECOMPUTE_WORKFLOW_DEFINITIONS } from "@/lib/workflows/precompute";

export const WORKFLOW_TASK_DEFINITIONS: Partial<Record<BackgroundTaskRun["kind"], DomainTaskDefinition>> = {
  ...DAILY_REPORT_WORKFLOW_DEFINITIONS,
  ...INGESTION_WORKFLOW_DEFINITIONS,
  ...ITEM_WORKFLOW_DEFINITIONS,
  ...CLUSTER_WORKFLOW_DEFINITIONS,
  ...PRECOMPUTE_WORKFLOW_DEFINITIONS,
};
