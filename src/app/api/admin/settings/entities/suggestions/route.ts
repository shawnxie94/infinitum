import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import {
  autoMergeHighConfidenceEntitySuggestions,
  dismissEntitySuggestion,
  listAdminEntitySuggestions,
  precomputeEntitySuggestionCandidates,
} from "@/lib/entities/service";

const entitySuggestionQuerySchema = z.object({
  search: z.string().nullable().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  sort: z.enum(["confidence_desc", "affected_desc"]).nullable().optional(),
});

const entitySuggestionDecisionSchema = z.object({
  sourceEntityId: z.string().min(1),
  targetEntityId: z.string().min(1),
  decision: z.enum(["ignored", "kept"]),
});

const entitySuggestionPostSchema = z.union([
  entitySuggestionDecisionSchema,
  z.object({
    action: z.literal("auto_merge_high_confidence"),
    limit: z.number().int().positive().optional(),
  }),
  z.object({
    action: z.literal("precompute"),
  }),
]);

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const searchParams = new URL(request.url).searchParams;
    const query = entitySuggestionQuerySchema.parse({
      search: searchParams.get("search"),
      page: searchParams.get("page") ?? undefined,
      pageSize: searchParams.get("pageSize") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
      sort: searchParams.get("sort"),
    });

    return Response.json(await listAdminEntitySuggestions(query));
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = entitySuggestionPostSchema.parse(await request.json());

    if ("sourceEntityId" in body) {
      return Response.json(await dismissEntitySuggestion(body));
    }

    if (body.action === "precompute") {
      return Response.json(await precomputeEntitySuggestionCandidates());
    }

    return Response.json(await autoMergeHighConfidenceEntitySuggestions({ limit: body.limit }));
  } catch (error) {
    return adminErrorResponse(error);
  }
}
