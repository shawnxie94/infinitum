import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { recordCuratorBehavior } from "@/lib/curator-behavior/service";
import { mapItemToReviewItem } from "@/lib/feed/repository";
import { manuallyFilterItem } from "@/lib/items/service";

export async function POST(_request: Request, context: RouteContext<"/api/admin/items/[id]/filter">) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const item = await manuallyFilterItem(id);
    await recordCuratorBehavior({
      eventType: "item_filtered",
      targetType: "item",
      targetId: id,
      itemId: id,
    });

    return Response.json({
      item: mapItemToReviewItem(item),
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
