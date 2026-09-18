import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { listOpenClusterFeedback } from "@/lib/clusters/feedback";

export async function GET() {
  try {
    await requireAdmin();
    const items = await listOpenClusterFeedback();

    return Response.json({ items });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
