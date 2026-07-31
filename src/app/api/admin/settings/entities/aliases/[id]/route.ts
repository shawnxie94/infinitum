import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { deleteEntityAlias } from "@/lib/entities/service";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    await deleteEntityAlias(id);

    return Response.json({ ok: true });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
