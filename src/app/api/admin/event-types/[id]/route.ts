import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { deleteEventType, updateEventType } from "@/lib/event-types/registry";

const updateSchema = z.object({
  // key 不可变：不接受修改；传入与现值不同会返回 immutable_key。
  label: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const immutableKeySchema = z.object({
  key: z.string().optional(),
}).partial();

function errorStatus(error: unknown) {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  return code === "type_in_use" || code === "protected_key" || code === "immutable_key" ? 409 : 400;
}

export async function PATCH(request: Request, context: RouteContext<"/api/admin/event-types/[id]">) {
  try {
    await requireAdmin();
    const rawBody = await request.json();
    const { key } = immutableKeySchema.parse(rawBody);
    const body = updateSchema.parse(rawBody);
    const { id } = await context.params;
    const eventType = await updateEventType(id, { ...body, key });

    return Response.json({ eventType });
  } catch (error) {
    return adminErrorResponse(error, errorStatus(error));
  }
}

export async function DELETE(_request: Request, context: RouteContext<"/api/admin/event-types/[id]">) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    await deleteEventType(id);

    return Response.json({ ok: true });
  } catch (error) {
    return adminErrorResponse(error, errorStatus(error));
  }
}
