import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { listDailyReportRevisions } from "@/lib/daily-report/history";

export async function GET(_request: Request, context: { params: Promise<{ date: string }> }) {
  try {
    await requireAdmin();
    const { date } = await context.params;
    return Response.json({ revisions: await listDailyReportRevisions(date) });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
