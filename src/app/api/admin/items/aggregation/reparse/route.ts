import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { enqueueItemReparseAggregationsTask } from "@/lib/items/service";

export async function POST() {
  try {
    await requireAdmin();
    const taskRun = await enqueueItemReparseAggregationsTask();
    if (!taskRun) {
      return Response.json({ error: "已有聚合内容重拆任务在运行。" }, { status: 409 });
    }
    return Response.json({ taskRun }, { status: 202 });
  } catch (error) {
    return adminErrorResponse(error, 400, "创建聚合内容重拆任务失败。");
  }
}
