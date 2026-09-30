import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { mapItemToReviewItem } from "@/lib/feed/repository";
import { manuallyFilterItem } from "@/lib/items/service";

export async function POST(_request: Request, context: RouteContext<"/api/admin/items/[id]/filter">) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const item = await manuallyFilterItem(id);

    return Response.json({
      item: mapItemToReviewItem(item),
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
