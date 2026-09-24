import { ADMIN_SESSION_TTL_SECONDS } from "@/config/constants";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";

const ADMIN_SESSION_COOKIE_NAME = "infinitum_admin_session";

// docker-compose/.env 示例文件内置的占位值，照抄上线等于无密码，启动时直接拒绝。
const WEAK_ADMIN_CREDENTIAL_VALUES = new Set(["change-me", "replace-with-a-long-random-secret"]);

type AdminSessionPayload = {
  exp: number;
};

export class AdminAuthError extends Error {
  status: number;

  constructor(message = "Unauthorized", status = 401) {
    super(message);
    this.name = "AdminAuthError";
    this.status = status;
  }
}

function getAdminPassword(): string {
  const password = process.env.ADMIN_PASSWORD?.trim();

  if (!password) {
    throw new Error("Missing ADMIN_PASSWORD environment variable.");
  }

  return password;
}

function getAdminSessionSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET?.trim();

  if (!secret) {
    throw new Error("Missing ADMIN_SESSION_SECRET environment variable.");
  }

  return secret;
}

function signPayload(payload: string): string {
  return createHmac("sha256", getAdminSessionSecret()).update(payload).digest("base64url");
}

function encodeSessionToken(payload: AdminSessionPayload): string {
  const serializedPayload = JSON.stringify(payload);
  const encodedPayload = Buffer.from(serializedPayload, "utf8").toString("base64url");
  const signature = signPayload(encodedPayload);

  return `${encodedPayload}.${signature}`;
}

function decodeSessionToken(token: string): AdminSessionPayload | null {
  const [encodedPayload, signature] = token.split(".");

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signPayload(encodedPayload);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as AdminSessionPayload;

    if (typeof parsed.exp !== "number") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function buildCookieOptions(expiresAt: Date) {
  const secureOverride = process.env.ADMIN_SESSION_COOKIE_SECURE?.trim().toLowerCase();
  const secure =
    secureOverride === "true" ? true : secureOverride === "false" ? false : process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure,
    expires: expiresAt,
  };
}

export async function loginAsAdmin() {
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000);
  const token = encodeSessionToken({
    exp: Math.floor(expiresAt.getTime() / 1000),
  });
  const cookieStore = await cookies();

  cookieStore.set(ADMIN_SESSION_COOKIE_NAME, token, buildCookieOptions(expiresAt));

  return {
    isAdmin: true,
    expiresAt,
  };
}

export async function clearAdminSession() {
  const cookieStore = await cookies();

  cookieStore.set(ADMIN_SESSION_COOKIE_NAME, "", {
    ...buildCookieOptions(new Date(0)),
    maxAge: 0,
  });
}

export async function getAdminSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value;

  if (!token) {
    return {
      isAdmin: false,
      expiresAt: null,
    };
  }

  const payload = decodeSessionToken(token);

  if (!payload) {
    return {
      isAdmin: false,
      expiresAt: null,
    };
  }

  const expiresAt = new Date(payload.exp * 1000);

  if (expiresAt.getTime() <= Date.now()) {
    return {
      isAdmin: false,
      expiresAt: null,
    };
  }

  return {
    isAdmin: true,
    expiresAt,
  };
}

export async function requireAdmin() {
  const session = await getAdminSession();

  if (!session.isAdmin) {
    throw new AdminAuthError();
  }

  return session;
}

export function validateAdminPassword(password: string): boolean {
  // 双侧哈希后 timingSafeEqual：长度归一 + 常数时间比较
  const provided = createHash("sha256").update(password, "utf8").digest();
  const expected = createHash("sha256").update(getAdminPassword(), "utf8").digest();
  return timingSafeEqual(provided, expected);
}

export function assertDeployableAdminCredentials({ now = new Date() }: { now?: Date } = {}) {
  const password = process.env.ADMIN_PASSWORD?.trim();
  const secret = process.env.ADMIN_SESSION_SECRET?.trim();

  if (!password) {
    throw new Error("ADMIN_PASSWORD 未配置，拒绝启动。");
  }
  if (WEAK_ADMIN_CREDENTIAL_VALUES.has(password)) {
    throw new Error("ADMIN_PASSWORD 仍是示例值（change-me），拒绝启动。请改为强口令。");
  }

  if (!secret) {
    throw new Error("ADMIN_SESSION_SECRET 未配置，拒绝启动。");
  }
  if (WEAK_ADMIN_CREDENTIAL_VALUES.has(secret)) {
    throw new Error("ADMIN_SESSION_SECRET 仍是示例值，拒绝启动。请改为长随机串。");
  }
  if (secret.length < 32) {
    console.warn(
      `[${now.toISOString()}] [admin] ADMIN_SESSION_SECRET 短于 32 字符，建议更换为长随机串。`,
    );
  }
}
