import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { setClusterVisibility } from "@/lib/clusters/service";
import { getAdminCluster } from "@/lib/feed/repository";

export async function POST(_request: Request, context: RouteContext<"/api/admin/clusters/[id]/hide">) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    await setClusterVisibility(id, false);
    const cluster = await getAdminCluster(id);

    return Response.json({ cluster });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
