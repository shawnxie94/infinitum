import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { assertBatchSize, runAdminBatch } from "@/lib/admin/batch";
import { requireAdmin } from "@/lib/admin/session";
import { dismissEntitySuggestion, mergeEntities } from "@/lib/entities/service";

const entitySuggestionBatchSchema = z.object({
  action: z.enum(["merge", "ignore"]),
  suggestions: z
    .array(
      z.object({
        sourceEntityId: z.string().min(1),
        targetEntityId: z.string().min(1),
      }),
    ),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = entitySuggestionBatchSchema.parse(await request.json());
    assertBatchSize(body.suggestions.map((entry) => `${entry.sourceEntityId}:${entry.targetEntityId}`));

    const result = await runAdminBatch(
      body.suggestions,
      (entry) => `${entry.sourceEntityId}:${entry.targetEntityId}`,
      async (entry) => {
        if (body.action === "merge") {
          await mergeEntities({
            targetEntityId: entry.targetEntityId,
            sourceEntityIds: [entry.sourceEntityId],
          });
          return;
        }

        await dismissEntitySuggestion({
          sourceEntityId: entry.sourceEntityId,
          targetEntityId: entry.targetEntityId,
          decision: "ignored",
        });
      },
    );

    return Response.json({ success: result.failed.length === 0, ...result });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
