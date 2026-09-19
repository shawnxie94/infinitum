import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import {
  createModelApiConfig,
  listModelApiConfigs,
} from "@/lib/settings/service";

const modelApiConfigSchema = z.object({
  type: z.enum(["chat", "embedding"]).default("chat"),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  apiKeyMode: z.enum(["replace", "clear", "keep"]).default("replace"),
  modelName: z.string().min(1),
  ingestionItemConcurrency: z.number().int().min(1).max(10),
  customHeaders: z.record(z.string(), z.string()).default({}),
  dimensions: z.number().int().min(16).max(4096).nullable().default(null),
  batchSize: z.number().int().min(1).max(128).nullable().default(null),
  timeoutMs: z.number().int().min(3000).max(60000).nullable().default(null),
  isEnabled: z.boolean(),
  isDefault: z.boolean(),
});

export async function GET() {
  try {
    await requireAdmin();

    return Response.json(await listModelApiConfigs());
  } catch (error) {
    return adminErrorResponse(error, 401, "Unauthorized");
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = modelApiConfigSchema.parse(await request.json());
    const config = await createModelApiConfig(body);

    return Response.json({ config }, { status: 201 });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
