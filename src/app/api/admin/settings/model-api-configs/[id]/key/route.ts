import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { getModelApiConfigSecret } from "@/lib/settings/service";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    await requireAdmin();
    const { id } = await context.params;

    return Response.json(await getModelApiConfigSecret(id));
  } catch (error) {
    return adminErrorResponse(error);
  }
}
