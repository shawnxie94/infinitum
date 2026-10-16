import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { listAdminAiRequests } from "@/lib/ai/request-audit";

const MAX_PAGE_SIZE = 100;

/**
 * 管理端 AI 请求回执诊断（只读）：有界分页、按任务过滤、预算摘要。
 * 不返回原始 prompt、密钥、认证头或未脱敏错误值。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const taskRunId = url.searchParams.get("taskRunId") || null;
    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const rawOffset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
    const limit = Number.isInteger(rawLimit) ? Math.min(MAX_PAGE_SIZE, Math.max(1, rawLimit)) : undefined;
    const offset = Number.isInteger(rawOffset) ? Math.max(0, rawOffset) : undefined;

    const result = await listAdminAiRequests({ taskRunId, limit, offset });
    return Response.json(result);
  } catch (error) {
    return adminErrorResponse(error, 401, "Unauthorized");
  }
}
