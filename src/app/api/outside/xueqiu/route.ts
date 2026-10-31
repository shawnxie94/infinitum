import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { followXueqiuUser, lookupXueqiuUser, parseXueqiuUid, searchXueqiuUsers, markXueqiuFollowed } from "@/lib/sources/xueqiu";

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json() as { query?: unknown; action?: unknown };
    if (typeof body.query !== "string" || body.query.trim().length === 0 || body.query.length > 200) {
      return Response.json({ error: "请输入雪球昵称、UID 或主页链接。" }, { status: 400 });
    }
    if (body.action === "search") return Response.json({ candidates: await markXueqiuFollowed(parseXueqiuUid(body.query) || /[:/]/.test(body.query) || /^\d/.test(body.query.trim()) ? [await lookupXueqiuUser(body.query)] : await searchXueqiuUsers(body.query)) });
    if (body.action === "follow") return Response.json({ source: await followXueqiuUser(body.query) });
    return Response.json({ error: "操作无效。" }, { status: 400 });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
