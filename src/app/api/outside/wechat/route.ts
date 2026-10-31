import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { followWechat, searchWechat } from "@/lib/sources/wechat";
export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json() as { action?: unknown; query?: unknown };
    if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 200) return Response.json({ error: "请输入公众号名称。" }, { status: 400 });
    if (body.action === "search") return Response.json(await searchWechat(body.query));
    if (body.action === "follow") return Response.json({ source: await followWechat(body.query) });
    return Response.json({ error: "操作无效。" }, { status: 400 });
  } catch (error) { return adminErrorResponse(error); }
}
