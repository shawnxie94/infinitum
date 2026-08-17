import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { enqueueTaskRun, getTaskRun, resumeTaskRun, toTaskRunSnapshot } from "@/lib/tasks/service";

export async function POST(_request: Request, context: RouteContext<"/api/admin/monitor/tasks/[id]/retrigger">) {
  try {
    await requireAdmin();
    const { id } = await context.params;

    // Get the original task directly from database
    const originalTask = await getTaskRun(id);

    if (!originalTask) {
      throw new Error("Task not found");
    }

    const checkpoint = originalTask.pipelineCheckpointJson
      ? (() => {
          try {
            return JSON.parse(originalTask.pipelineCheckpointJson) as { version?: number; resumeEligible?: boolean };
          } catch {
            return null;
          }
        })()
      : null;
    const canResume = originalTask.kind === "daily_report_generate"
      && ["failed", "partial", "cancelled"].includes(originalTask.status)
      && checkpoint?.version === 1
      && checkpoint.resumeEligible === true;
    const newTask = canResume
      ? await resumeTaskRun(id)
      : await enqueueTaskRun({
        kind: originalTask.kind,
        triggerType: "admin_action",
        label: `${originalTask.label} (重新触发)`,
        entityId: originalTask.entityId,
      });

    return Response.json({
      task: toTaskRunSnapshot(newTask),
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
