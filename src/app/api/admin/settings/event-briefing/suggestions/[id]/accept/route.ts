import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { acceptBriefingPreferenceSuggestion } from "@/lib/curator-behavior/service";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const result = await acceptBriefingPreferenceSuggestion(id);

    return Response.json(result);
  } catch (error) {
    return adminErrorResponse(error);
  }
}
