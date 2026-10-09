import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { assertBatchSize, runAdminBatch } from "@/lib/admin/batch";
import { requireAdmin } from "@/lib/admin/session";
import { enqueueItemReanalyzeTask, restoreFilteredItem } from "@/lib/items/service";

const filteredItemsBatchSchema = z.object({
  action: z.enum(["restore", "reanalyze"]),
  ids: z.array(z.string().min(1)),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = filteredItemsBatchSchema.parse(await request.json());
    const ids = assertBatchSize(body.ids);

    const result = await runAdminBatch(ids, (id) => id, async (id) => {
      if (body.action === "restore") {
        await restoreFilteredItem(id);
        return;
      }
      await enqueueItemReanalyzeTask(id);
    });

    return Response.json({ success: result.failed.length === 0, ...result });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
