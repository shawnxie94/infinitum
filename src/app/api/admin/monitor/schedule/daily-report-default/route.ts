import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { toTaskScheduleSnapshot, updateDefaultDailyReportSchedule } from "@/lib/tasks/service";

const scheduleUpdateSchema = z.object({
  enabled: z.boolean(),
  cronExpression: z.string().trim().min(1),
  dailyReportCandidateLimit: z.number().int().min(2).max(500),
  dailyReportPlanningBatchSize: z.number().int().positive().nullable().optional(),
  dailyReportOffsetDays: z.number().int().min(0).max(365),
  dailyReportAutoPublish: z.boolean(),
  dailyReportChannelIds: z.array(z.string().trim().min(1)).min(1).max(12),
});

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const body = scheduleUpdateSchema.parse(await request.json());
    const schedule = await updateDefaultDailyReportSchedule(body);

    return Response.json({
      schedule: toTaskScheduleSnapshot(schedule),
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
