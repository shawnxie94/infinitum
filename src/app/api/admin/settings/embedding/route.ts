import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { updateEmbeddingConfig } from "@/lib/settings/service";

const embeddingSchema = z
  .object({
    enabled: z.boolean(),
    baseUrl: z.string().trim().min(1),
    apiKey: z.string().optional().default(""),
    apiKeyMode: z.enum(["replace", "clear", "keep"]).optional().default("keep"),
    modelName: z.string().trim().min(1),
    dimensions: z.number().int().min(16).max(4096).nullable(),
    batchSize: z.number().int().min(1).max(128),
    timeoutMs: z.number().int(),
  })
  .strict();

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const body = embeddingSchema.parse(await request.json());
    const config = await updateEmbeddingConfig(body);

    return Response.json({ config });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
