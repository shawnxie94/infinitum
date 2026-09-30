import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { updateEventBriefingConfig } from "@/lib/settings/service";

const eventBriefingSchema = z
  .object({
    config: z.object({
      minRankScore: z.number().int(),
      channels: z.array(z.object({
        id: z.string(),
        name: z.string(),
        sourceGroupIds: z.array(z.string()),
        enabled: z.boolean(),
        sortOrder: z.number().int(),
      }).strict()).max(12),
    }).strict(),
  })
  .strict();

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const body = eventBriefingSchema.parse(await request.json());
    const config = await updateEventBriefingConfig(body.config);

    return Response.json({ eventBriefing: { config } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
