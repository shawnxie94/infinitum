import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { DAILY_REPORT_RECOVERY_STAGES } from "@/lib/tasks/types";
import { enqueueTaskRun, getTaskRun, resumeTaskRun, toTaskRunSnapshot } from "@/lib/tasks/service";
import { z } from "zod";

const retriggerSchema = z.object({
  retryFrom: z.enum(["all", ...DAILY_REPORT_RECOVERY_STAGES]).optional(),
});

export async function POST(request: Request, context: RouteContext<"/api/admin/monitor/tasks/[id]/retrigger">) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const body = retriggerSchema.parse(await request.json().catch(() => ({})));

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
    let newTask;
    if (body.retryFrom === "all") {
      newTask = await enqueueTaskRun({
        kind: originalTask.kind,
        triggerType: "admin_action",
        label: `${originalTask.label} (重新触发)`,
        entityId: originalTask.entityId,
      });
    } else if (body.retryFrom && originalTask.kind === "daily_report_generate") {
      newTask = await resumeTaskRun(id, { retryFrom: body.retryFrom });
    } else if (canResume) {
      newTask = await resumeTaskRun(id);
    } else {
      newTask = await enqueueTaskRun({
        kind: originalTask.kind,
        triggerType: "admin_action",
        label: `${originalTask.label} (重新触发)`,
        entityId: originalTask.entityId,
      });
    }

    return Response.json({
      task: toTaskRunSnapshot(newTask),
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
