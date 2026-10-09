import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import {
  MAX_FULL_TEXT_FETCH_THRESHOLD,
  MAX_SOURCE_CONCURRENCY,
  MAX_AGGREGATION_SPLIT_MAX_EVENTS,
  MIN_FULL_TEXT_FETCH_THRESHOLD,
  MIN_SOURCE_CONCURRENCY,
  MIN_AGGREGATION_SPLIT_MAX_EVENTS,
  MAX_PER_SOURCE_ITEM_LIMIT,
  MIN_PER_SOURCE_ITEM_LIMIT,
  MIN_PROCESSING_WINDOW_DAYS,
  MAX_PROCESSING_WINDOW_DAYS,
} from "@/lib/tasks/scheduler";
import { toTaskScheduleSnapshot, updateDefaultIngestionSchedule } from "@/lib/tasks/service";

const scheduleUpdateSchema = z.object({
  enabled: z.boolean(),
  cronExpression: z.string().trim().min(1),
  sourceConcurrency: z.number().int().min(MIN_SOURCE_CONCURRENCY).max(MAX_SOURCE_CONCURRENCY),
  fullTextFetchThreshold: z
    .number()
    .int()
    .min(MIN_FULL_TEXT_FETCH_THRESHOLD)
    .max(MAX_FULL_TEXT_FETCH_THRESHOLD),
  perSourceItemLimit: z.number().int().min(MIN_PER_SOURCE_ITEM_LIMIT).max(MAX_PER_SOURCE_ITEM_LIMIT),
  aggregationSplitMaxEvents: z
    .number()
    .int()
    .min(MIN_AGGREGATION_SPLIT_MAX_EVENTS)
    .max(MAX_AGGREGATION_SPLIT_MAX_EVENTS)
    .optional(),
  processingWindowDays: z.number().int().min(MIN_PROCESSING_WINDOW_DAYS).max(MAX_PROCESSING_WINDOW_DAYS),
});

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const body = scheduleUpdateSchema.parse(await request.json());
    const schedule = await updateDefaultIngestionSchedule(body);

    return Response.json({
      schedule: toTaskScheduleSnapshot(schedule),
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
