import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { deleteSource, updateSource } from "@/lib/settings/service";

const sourceSchema = z.object({
  name: z.string().min(1),
  rssUrl: z.url().nullable(),
  siteUrl: z.union([z.url(), z.literal("")]),
  enabled: z.boolean(),
  aiParsingEnabled: z.boolean().default(true),
  aggregationEnabled: z.boolean().default(true),
  aggregationDetectionEnabled: z.boolean().default(false),
  groupId: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
});

export async function PATCH(request: Request, context: RouteContext<"/api/admin/settings/sources/[id]">) {
  try {
    await requireAdmin();
    const body = sourceSchema.parse(await request.json());
    const { id } = await context.params;
    const source = await updateSource(id, body);

    return Response.json({ source });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext<"/api/admin/settings/sources/[id]">) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    await deleteSource(id);

    return Response.json({ ok: true });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
