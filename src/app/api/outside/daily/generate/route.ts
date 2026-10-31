import { z } from "zod";
import { requireAdmin } from "@/lib/admin/session";
import { adminErrorResponse } from "@/lib/admin/http";
import { getManualDailyGeneration, startManualDailyGeneration } from "@/lib/daily-report/manual-generation";

export async function GET() {
  try {
    await requireAdmin();
    return Response.json({ generation: await getManualDailyGeneration() });
  } catch (error) { return adminErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const { date } = z.object({ date: z.string() }).parse(await request.json());
    await startManualDailyGeneration(date);
    return Response.json({ generation: await getManualDailyGeneration() }, { status: 202 });
  } catch (error) { return adminErrorResponse(error); }
}
