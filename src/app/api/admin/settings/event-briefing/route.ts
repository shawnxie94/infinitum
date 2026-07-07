import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { updateBriefingPreferenceConfig, updateEventBriefingConfig } from "@/lib/settings/service";

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
    preference: z.object({
      weightedRules: z.array(z.object({
        type: z.enum(["tag", "keyword", "source_group", "event_type"]),
        value: z.string(),
        weight: z.number().int(),
      }).strict()).max(100),
      maxCuratorBoost: z.number().int(),
      maxCuratorPenalty: z.number().int(),
    }),
  })
  .strict();

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const body = eventBriefingSchema.parse(await request.json());
    const [config, preference] = await Promise.all([
      updateEventBriefingConfig(body.config),
      updateBriefingPreferenceConfig(body.preference),
    ]);

    return Response.json({ eventBriefing: { config, preference } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
