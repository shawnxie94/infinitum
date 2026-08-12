import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import {
  dismissAllBriefingPreferenceSuggestions,
  generateBriefingPreferenceSuggestions,
  listBriefingPreferenceSuggestions,
} from "@/lib/curator-behavior/service";

const suggestionPostSchema = z.object({
  action: z.literal("dismiss_all"),
}).optional();

export async function GET() {
  try {
    await requireAdmin();
    const suggestions = await listBriefingPreferenceSuggestions();

    return Response.json({ suggestions });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();

    const rawBody = await request.text();
    const body = suggestionPostSchema.parse(rawBody.trim() ? JSON.parse(rawBody) : undefined);
    if (body?.action === "dismiss_all") {
      const dismissedCount = await dismissAllBriefingPreferenceSuggestions();
      return Response.json({ dismissedCount });
    }

    await generateBriefingPreferenceSuggestions();
    const suggestions = await listBriefingPreferenceSuggestions();

    return Response.json({ suggestions });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
