import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { createEventType, listEventTypesForAdmin, reorderEventTypes } from "@/lib/event-types/registry";

const createSchema = z.object({
  key: z.string().trim().min(1).max(64).nullable().optional(),
  label: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const reorderSchema = z.object({
  keys: z.array(z.string().min(1)).max(200),
});

function errorStatus(error: unknown) {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  return code === "type_in_use" || code === "protected_key" ? 409 : 400;
}

export async function GET() {
  try {
    await requireAdmin();
    const eventTypes = await listEventTypesForAdmin();

    return Response.json({ eventTypes });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = createSchema.parse(await request.json());
    const eventType = await createEventType(body);

    return Response.json({ eventType }, { status: 201 });
  } catch (error) {
    return adminErrorResponse(error, errorStatus(error));
  }
}

/** 批量排序：按传入 key 顺序重排 sortOrder。 */
export async function PUT(request: Request) {
  try {
    await requireAdmin();
    const body = reorderSchema.parse(await request.json());
    const eventTypes = await reorderEventTypes(body.keys);

    return Response.json({ eventTypes });
  } catch (error) {
    return adminErrorResponse(error, errorStatus(error));
  }
}
