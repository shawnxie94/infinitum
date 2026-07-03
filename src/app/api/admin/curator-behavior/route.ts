import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { recordCuratorBehavior } from "@/lib/curator-behavior/service";

const behaviorSchema = z.object({
  eventType: z.enum([
    "event_detail_opened",
    "feed_item_opened",
    "event_source_clicked",
    "manual_boost",
    "item_filtered",
    "cluster_hidden",
    "manual_penalty",
  ]),
  targetType: z.enum(["event", "item", "cluster"]),
  targetId: z.string().min(1),
  entryType: z.enum(["single", "cluster"]).nullable().optional(),
  entryId: z.string().nullable().optional(),
  itemId: z.string().nullable().optional(),
  clusterId: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = behaviorSchema.parse(await request.json());
    const event = await recordCuratorBehavior(body);

    return Response.json({ ok: true, eventId: event.id });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
