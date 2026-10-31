import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import {
  getDailyReportByDate,
  getLatestDailyReportDate,
  listDailyReports,
} from "@/lib/daily-report/repository";
import { normalizeDailyReportDate } from "@/lib/daily-report/date";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const rawDate = searchParams.get("date")?.trim() ?? "";

    let date = "";
    if (rawDate) {
      date = normalizeDailyReportDate(rawDate);
    } else {
      date = await getLatestDailyReportDate();
    }

    const [report, history] = await Promise.all([
      date ? getDailyReportByDate(date, true) : Promise.resolve(null),
      listDailyReports({ isAdmin: true, status: "all", page: 1, pageSize: 30 }),
    ]);

    return Response.json({
      report,
      history: history.reports ?? history,
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
