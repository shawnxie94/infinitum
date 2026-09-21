import type { BackgroundTaskRun } from "@prisma/client";

import { TASK_BODIES } from "@/lib/tasks/domain-bodies";

/**
 * Compatibility adapter for callers that explicitly inject a plain executor.
 * The worker's default route is now the Mastra workflow runtime; domain bodies
 * are declared once in domain-bodies.ts to prevent a second execution path.
 */
export async function executeTaskRun(taskRun: BackgroundTaskRun) {
  const body = TASK_BODIES[taskRun.kind];
  if (!body) throw new Error(`No domain body registered for ${taskRun.kind}.`);
  await body(taskRun);
}
