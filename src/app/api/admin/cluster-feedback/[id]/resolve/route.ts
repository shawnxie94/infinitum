import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { resolveClusterFeedback } from "@/lib/clusters/feedback";

const resolveSchema = z
  .object({
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    let note: string | undefined;
    try {
      const body = resolveSchema.parse(await request.json());
      note = body.note;
    } catch {
      // 无说明也可解决
    }

    const item = await resolveClusterFeedback({ id, note });
    return Response.json({ item });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
