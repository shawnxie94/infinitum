import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { applyClusterReviewIgnore } from "@/lib/clusters/review-actions";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    await applyClusterReviewIgnore(id);

    return Response.json({
      success: true,
    });
  } catch (error) {
    return adminErrorResponse(error, 400, "复核忽略失败");
  }
}
