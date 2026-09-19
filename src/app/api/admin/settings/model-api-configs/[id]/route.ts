import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import {
  deleteModelApiConfig,
  getModelApiConfig,
  updateModelApiConfig,
} from "@/lib/settings/service";

const modelApiConfigSchema = z.object({
  type: z.enum(["chat", "embedding"]).default("chat"),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  apiKeyMode: z.enum(["replace", "clear", "keep"]).default("keep"),
  modelName: z.string().min(1),
  ingestionItemConcurrency: z.number().int().min(1).max(10),
  customHeaders: z.record(z.string(), z.string()).default({}),
  dimensions: z.number().int().min(16).max(4096).nullable().default(null),
  batchSize: z.number().int().min(1).max(128).nullable().default(null),
  timeoutMs: z.number().int().min(3000).max(60000).nullable().default(null),
  isEnabled: z.boolean(),
  isDefault: z.boolean(),
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    await requireAdmin();
    const { id } = await context.params;

    return Response.json(await getModelApiConfig(id));
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const body = modelApiConfigSchema.parse(await request.json());
    const config = await updateModelApiConfig(id, body);

    return Response.json({ config });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    await requireAdmin();
    const { id } = await context.params;

    await deleteModelApiConfig(id);

    return Response.json({ ok: true });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
