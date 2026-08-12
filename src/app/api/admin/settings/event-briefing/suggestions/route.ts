import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import {
  dismissBriefingPreferenceSuggestions,
  generateBriefingPreferenceSuggestions,
  listBriefingPreferenceSuggestions,
} from "@/lib/curator-behavior/service";

const suggestionPostSchema = z.object({
  action: z.literal("dismiss_ids"),
  suggestionIds: z.array(z.string().min(1)).min(1).max(50),
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
    if (body?.action === "dismiss_ids") {
      const dismissedCount = await dismissBriefingPreferenceSuggestions(body.suggestionIds);
      return Response.json({ dismissedCount });
    }

    await generateBriefingPreferenceSuggestions();
    const suggestions = await listBriefingPreferenceSuggestions();

    return Response.json({ suggestions });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
