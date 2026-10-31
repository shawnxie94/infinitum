import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { followEastmoney, lookupEastmoney } from "@/lib/sources/eastmoney";
export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json() as { action?: unknown; query?: unknown };
    if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 200) return Response.json({ error: "请输入东方财富 UID 或主页链接。" }, { status: 400 });
    if (body.action === "search") return Response.json({ candidates: [await lookupEastmoney(body.query)] });
    if (body.action === "follow") return Response.json({ source: await followEastmoney(body.query) });
    return Response.json({ error: "操作无效。" }, { status: 400 });
  } catch (error) { return adminErrorResponse(error); }
}
