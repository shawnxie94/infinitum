import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { listAdminEntities } from "@/lib/entities/service";

const entityListQuerySchema = z.object({
  search: z.string().nullable().optional(),
  sort: z.string().nullable().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const searchParams = new URL(request.url).searchParams;
    const query = entityListQuerySchema.parse({
      search: searchParams.get("search"),
      sort: searchParams.get("sort"),
      page: searchParams.get("page") ?? undefined,
      pageSize: searchParams.get("pageSize") ?? undefined,
    });

    return Response.json(await listAdminEntities(query));
  } catch (error) {
    return adminErrorResponse(error);
  }
}
