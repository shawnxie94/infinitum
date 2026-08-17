import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { restoreDailyReportRevision } from "@/lib/daily-report/history";

export async function POST(_request: Request, context: { params: Promise<{ date: string; revisionId: string }> }) {
  try {
    await requireAdmin();
    const { date, revisionId } = await context.params;
    const revision = await restoreDailyReportRevision(date, revisionId);
    return Response.json({ revision });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
