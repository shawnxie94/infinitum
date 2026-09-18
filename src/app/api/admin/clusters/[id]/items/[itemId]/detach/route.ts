import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { recordClusterPairLabelFromItem } from "@/lib/clusters/feedback";
import { detachItemFromCluster } from "@/lib/clusters/service";
import { getAdminCluster } from "@/lib/feed/repository";

export async function POST(
  _request: Request,
  context: RouteContext<"/api/admin/clusters/[id]/items/[itemId]/detach">,
) {
  try {
    await requireAdmin();
    const { id, itemId } = await context.params;

    // Phase 3 反馈回写：人工判定该条目不属于此簇（不同事件）
    await recordClusterPairLabelFromItem({
      verdict: "declined",
      source: "item_detach",
      itemId,
      clusterId: id,
    });

    await detachItemFromCluster(itemId);

    return Response.json({
      cluster: await getAdminCluster(id),
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
