import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { mergeEntities } from "@/lib/entities/service";

const entityMergeSchema = z.object({
  targetEntityId: z.string().min(1),
  sourceEntityIds: z.array(z.string().min(1)).min(1),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = entityMergeSchema.parse(await request.json());

    return Response.json(await mergeEntities(body));
  } catch (error) {
    return adminErrorResponse(error);
  }
}
