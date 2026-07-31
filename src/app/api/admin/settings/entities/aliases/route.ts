import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { addEntityAlias } from "@/lib/entities/service";

const entityAliasSchema = z.object({
  entityId: z.string().min(1),
  aliasName: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = entityAliasSchema.parse(await request.json());

    return Response.json({
      alias: await addEntityAlias(body),
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
