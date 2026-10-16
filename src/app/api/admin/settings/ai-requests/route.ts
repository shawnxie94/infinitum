import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { getAiRequestsSettings } from "@/lib/settings/ai-requests-service";
import { AI_DAILY_CHAT_REQUEST_LIMIT_ENV } from "@/lib/ai/request-budget-env";

/** 只读诊断：预算唯一生效来源是环境变量，DB 配置不再参与。 */
export async function GET() {
  try {
    await requireAdmin();
    return Response.json(getAiRequestsSettings());
  } catch (error) {
    return adminErrorResponse(error, 401, "Unauthorized");
  }
}

export async function PUT() {
  try {
    await requireAdmin();
    return Response.json(
      { error: `每日聊天请求预算仅通过环境变量 ${AI_DAILY_CHAT_REQUEST_LIMIT_ENV} 配置，不再支持在线修改。` },
      { status: 405 },
    );
  } catch (error) {
    return adminErrorResponse(error, 401, "Unauthorized");
  }
}
