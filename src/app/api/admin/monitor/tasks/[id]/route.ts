import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { attachTaskEntityTitles, getTaskRun, toTaskRunSnapshot } from "@/lib/tasks/service";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const taskRun = await getTaskRun(id);
    if (!taskRun) {
      return Response.json({ error: "任务不存在。" }, { status: 404 });
    }

    const [task] = await attachTaskEntityTitles([toTaskRunSnapshot(taskRun, { isDetailLoaded: true })]);
    return Response.json({ task });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
