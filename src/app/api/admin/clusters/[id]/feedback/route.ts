import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { flagClusterForReview } from "@/lib/clusters/feedback";

const feedbackSchema = z
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
      const body = feedbackSchema.parse(await request.json());
      note = body.note;
    } catch {
      // 空请求体也允许：一键反馈不强制填写说明
    }

    const result = await flagClusterForReview({ clusterId: id, note });
    return Response.json(result);
  } catch (error) {
    return adminErrorResponse(error);
  }
}
