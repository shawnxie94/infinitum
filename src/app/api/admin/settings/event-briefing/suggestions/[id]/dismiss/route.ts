import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { dismissBriefingPreferenceSuggestion } from "@/lib/curator-behavior/service";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const suggestion = await dismissBriefingPreferenceSuggestion(id);

    return Response.json({ suggestion });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
