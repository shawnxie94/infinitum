import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import {
  deletePromptConfig,
  getPromptConfig,
  updatePromptConfig,
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

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    await requireAdmin();
    const { id } = await context.params;

    return Response.json(await getPromptConfig(id));
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const body = promptConfigSchema.parse(await request.json());
    const config = await updatePromptConfig(id, body);

    return Response.json({ config });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    await requireAdmin();
    const { id } = await context.params;

    await deletePromptConfig(id);

    return Response.json({ ok: true });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
