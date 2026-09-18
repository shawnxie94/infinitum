import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { recordClusterPairLabelFromItem } from "@/lib/clusters/feedback";
import { moveItemToCluster } from "@/lib/clusters/service";
import { getAdminCluster } from "@/lib/feed/repository";

const joinClusterSchema = z.object({
  clusterId: z.string().min(1),
});

export async function POST(request: Request, context: RouteContext<"/api/admin/items/[id]/join-cluster">) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const body = joinClusterSchema.parse(await request.json());

    // Phase 3 反馈回写：人工判定该条目属于此簇（同事件）
    await recordClusterPairLabelFromItem({
      verdict: "approved",
      source: "item_join",
      itemId: id,
      clusterId: body.clusterId,
    });

    await moveItemToCluster(id, body.clusterId);

    return Response.json({
      cluster: await getAdminCluster(body.clusterId),
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
