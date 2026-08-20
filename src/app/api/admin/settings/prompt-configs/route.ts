import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import {
  createPromptConfig,
  listPromptConfigs,
} from "@/lib/settings/service";
import { PROMPT_CONFIG_TYPES } from "@/lib/settings/types";

const promptConfigSchema = z.object({
  name: z.string().min(1),
  type: z.enum(PROMPT_CONFIG_TYPES),
  prompt: z.string().optional(),
  userPrompt: z.string().nullable().optional(),
  // Accepted during the compatibility window but never used as the runtime
  // system contract. Internal protocols are code-owned.
  systemPrompt: z.string().nullable().optional(),
  templateJson: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
  topP: z.number().min(0).max(1).nullable().optional(),
  modelApiConfigId: z.string().nullable().optional(),
  isEnabled: z.boolean(),
  isDefault: z.boolean(),
});

export async function GET() {
  try {
    await requireAdmin();

    return Response.json(await listPromptConfigs());
  } catch (error) {
    return adminErrorResponse(error, 401, "Unauthorized");
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = promptConfigSchema.parse(await request.json());
    const config = await createPromptConfig(body);

    return Response.json({ config }, { status: 201 });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
