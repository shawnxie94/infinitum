import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { getDailyReportRevision } from "@/lib/daily-report/history";

export async function GET(_request: Request, context: { params: Promise<{ date: string; revisionId: string }> }) {
  try {
    await requireAdmin();
    const { date, revisionId } = await context.params;
    const revision = await getDailyReportRevision(date, revisionId);
    if (!revision) return Response.json({ error: "日报历史版本不存在" }, { status: 404 });
    return Response.json({ revision });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
