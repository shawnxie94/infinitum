import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { listOrcaRouterModels } from "@/lib/settings/service";

/**
 * Served by the backend so the OrcaRouter API key never reaches the browser.
 * The client only receives minimal model metadata for the selector.
 */
const catalogQuerySchema = z.object({
  configId: z.string().min(1),
  capability: z.enum(["chat", "embedding", "image", "video", "rerank"]),
  requiredInputModalities: z.array(z.enum(["text", "image", "audio", "video", "file"])).optional(),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = catalogQuerySchema.parse(await request.json());

    const catalog = await listOrcaRouterModels(body);

    return Response.json({
      success: true,
      source: catalog.source,
      degraded: catalog.degraded,
      error: catalog.error,
      capability: catalog.capability,
      credentialSource: catalog.credentialSource,
      models: catalog.models.map((model) => ({
        id: model.id,
        name: model.name,
        contextLength: model.contextLength,
        inputModalities: model.inputModalities,
        reasoning: model.reasoning,
        reasoningEfforts: model.reasoningEfforts,
      })),
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
