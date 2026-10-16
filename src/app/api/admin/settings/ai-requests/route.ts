import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { getAiRequestsSettings, updateAiRequestsConfig } from "@/lib/settings/ai-requests-service";

const aiRequestsSchema = z
  .object({
    dailyChatRequestLimit: z.number().int().min(0).nullable(),
  })
  .strict();

export async function GET() {
  try {
    await requireAdmin();
    return Response.json(await getAiRequestsSettings());
  } catch (error) {
    return adminErrorResponse(error, 401, "Unauthorized");
  }
}

export async function PUT(request: Request) {
  try {
    await requireAdmin();
    const body = aiRequestsSchema.parse(await request.json());
    return Response.json(await updateAiRequestsConfig(body));
  } catch (error) {
    return adminErrorResponse(error);
  }
}
