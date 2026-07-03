import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import {
  generateBriefingPreferenceSuggestions,
  listBriefingPreferenceSuggestions,
} from "@/lib/curator-behavior/service";

export async function GET() {
  try {
    await requireAdmin();
    const suggestions = await listBriefingPreferenceSuggestions();

    return Response.json({ suggestions });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function POST() {
  try {
    await requireAdmin();
    await generateBriefingPreferenceSuggestions();
    const suggestions = await listBriefingPreferenceSuggestions();

    return Response.json({ suggestions });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
