import { z } from "zod";
import { requireAdmin } from "@/lib/admin/session";
import { adminErrorResponse } from "@/lib/admin/http";
import { migrateAdapterSource, rollbackAdapterSource } from "@/lib/adapter/migration";

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("migrate"), providerId: z.string().regex(/^[a-z0-9_-]{1,40}$/), account: z.object({ accountId: z.string().min(1).max(180), name: z.string().min(1).max(100), description: z.string().max(300).optional(), siteUrl: z.httpUrl().nullish(), avatarUrl: z.httpUrl().nullish() }) }),
  z.object({ action: z.literal("rollback") }),
]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const input = requestSchema.parse(await request.json());
    const { id } = await context.params;
    const source = input.action === "rollback" ? await rollbackAdapterSource(id) : await migrateAdapterSource(id, input.providerId, input.account);
    return Response.json({ source });
  } catch (error) { return adminErrorResponse(error); }
}
