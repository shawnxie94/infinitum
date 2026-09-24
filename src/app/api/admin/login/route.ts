import {
  getLoginThrottleState,
  registerLoginFailure,
  resetLoginFailures,
} from "@/lib/admin/login-throttle";
import { loginAsAdmin, validateAdminPassword } from "@/lib/admin/session";

function getClientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const throttle = getLoginThrottleState(ip);

  if (throttle.throttled) {
    return Response.json(
      { error: `尝试过于频繁，请 ${throttle.retryAfterSeconds} 秒后再试。` },
      { status: 429, headers: { "retry-after": String(throttle.retryAfterSeconds) } },
    );
  }

  const body = (await request.json().catch(() => null)) as { password?: string } | null;
  const password = body?.password ?? "";

  if (!validateAdminPassword(password)) {
    registerLoginFailure(ip);
    return Response.json(
      {
        error: "Invalid password",
      },
      { status: 401 },
    );
  }

  resetLoginFailures(ip);
  await loginAsAdmin();

  return Response.json({
    authenticated: true,
  });
}
