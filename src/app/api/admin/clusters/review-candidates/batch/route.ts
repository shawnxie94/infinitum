import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { assertBatchSize, runAdminBatch } from "@/lib/admin/batch";
import { requireAdmin } from "@/lib/admin/session";
import { applyClusterReviewIgnore, applyClusterReviewMerge } from "@/lib/clusters/review-actions";

const reviewBatchSchema = z.object({
  action: z.enum(["merge", "ignore"]),
  ids: z.array(z.string().min(1)),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = reviewBatchSchema.parse(await request.json());
    const ids = assertBatchSize(body.ids);

    const result = await runAdminBatch(ids, (id) => id, async (id) => {
      if (body.action === "merge") {
        await applyClusterReviewMerge(id);
        return;
      }
      await applyClusterReviewIgnore(id);
    });

    return Response.json({ success: result.failed.length === 0, ...result });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
