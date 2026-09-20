/**
 * OrcaRouter OAuth 2.0 + PKCE (RFC 7636) primitives.
 *
 * Flow B (out-of-band code) is the flow this repository uses: Infinitum is
 * self-hosted and its install address differs on every deployment, so there is
 * no predictable address a redirect could come back to. Flow A (loopback) is
 * implemented as well for deployments that reach the server on loopback.
 *
 * S256 is always sent. Even on Flow A the user may choose "Show me a code" on
 * the consent screen, so the challenge must never be the verifier itself.
 *
 * The verifier is a secret: it is never logged, never placed in a URL, and
 * never included in an error message. Only its SHA-256 challenge travels on
 * the authorize URL.
 */

import crypto from "node:crypto";

import {
  buildAuthorizeEndpoint,
  buildKeyExchangeEndpoint,
  type OrcaRouterOrigins,
} from "./origins";
import type { OrcaRouterCredentialResult } from "./credentials";

export const PKCE_CODE_CHALLENGE_METHOD = "S256" as const;
/** Auth codes are single-use with a 10 minute TTL. */
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_EXCHANGE_TIMEOUT_MS = 30_000;

export type OrcaRouterScope = "api" | "connector";
export type OrcaRouterCallbackMode = "loopback" | "out-of-band";

export type RandomBytes = (size: number) => Buffer;

export type PkceAttempt = {
  attemptId: string;
  verifier: string;
  challenge: string;
  state: string;
  callbackMode: OrcaRouterCallbackMode;
  authorizeUrl: string;
  requestedScope: OrcaRouterScope;
};

/** Terminal vs retryable classification for the code exchange. */
export type ExchangeFailureKind =
  | "invalid-grant"
  | "downgrade-defence"
  | "rate-limited"
  | "denied"
  | "network"
  | "timeout"
  | "malformed-response";

export class OrcaRouterPkceError extends Error {
  readonly kind: ExchangeFailureKind;
  readonly statusCode: number | null;
  /** Safe, user-actionable hint. Never contains the verifier, code, or key. */
  readonly hint: string;

  constructor(kind: ExchangeFailureKind, message: string, statusCode: number | null, hint: string) {
    super(message);
    this.name = "OrcaRouterPkceError";
    this.kind = kind;
    this.statusCode = statusCode;
    this.hint = hint;
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/** Fresh, cryptographically random verifier. 32 bytes -> 43 char base64url. */
export function createPkceVerifier(randomBytes: RandomBytes = crypto.randomBytes): string {
  return base64Url(randomBytes(32));
}

export function createPkceState(randomBytes: RandomBytes = crypto.randomBytes): string {
  return base64Url(randomBytes(16));
}

/** `base64url(sha256(verifier))` with no padding. */
export function computeCodeChallenge(verifier: string): string {
  return base64Url(crypto.createHash("sha256").update(verifier).digest());
}

/** Only S256 is ever produced; `plain` is refused by construction. */
export function buildAuthorizeUrl(input: {
  authBase: string;
  callbackUrl: string;
  challenge: string;
  state: string;
  appName: string;
  scope?: OrcaRouterScope;
}): string {
  const url = new URL(buildAuthorizeEndpoint(input.authBase));
  url.searchParams.set("callback_url", input.callbackUrl);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", PKCE_CODE_CHALLENGE_METHOD);
  url.searchParams.set("state", input.state);
  url.searchParams.set("app_name", input.appName);
  url.searchParams.set("scope", input.scope ?? "api");
  return url.toString();
}

export function createPkceAttempt(input: {
  origins: OrcaRouterOrigins;
  callbackMode: OrcaRouterCallbackMode;
  appName: string;
  scope?: OrcaRouterScope;
  /** Required for loopback; ignored for out-of-band. */
  callbackUrl?: string;
  randomBytes?: RandomBytes;
}): PkceAttempt {
  const verifier = createPkceVerifier(input.randomBytes);
  const challenge = computeCodeChallenge(verifier);
  const state = createPkceState(input.randomBytes);

  const callbackUrl =
    input.callbackMode === "out-of-band" ? "oob" : (input.callbackUrl ?? "").trim();

  if (input.callbackMode === "loopback" && !callbackUrl) {
    throw new OrcaRouterPkceError(
      "malformed-response",
      "缺少 loopback 回调地址。",
      null,
      "请先启动本地回调监听再发起授权。",
    );
  }

  return {
    attemptId: base64Url(crypto.randomBytes(9)),
    verifier,
    challenge,
    state,
    callbackMode: input.callbackMode,
    authorizeUrl: buildAuthorizeUrl({
      authBase: input.origins.authBase,
      callbackUrl,
      challenge,
      state,
      appName: input.appName,
      scope: input.scope,
    }),
    requestedScope: input.scope ?? "api",
  };
}

/** Constant-time state comparison. Length mismatch short-circuits as false. */
export function isStateMatch(expected: string, received: string | null): boolean {
  if (!expected || !received) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Verifies a loopback callback's query string before the code is used.
 * `state` is compared first; a mismatch is refused outright.
 */
export function verifyLoopbackCallback(
  searchParams: URLSearchParams,
  expectedState: string,
): { code: string } {
  if (!isStateMatch(expectedState, searchParams.get("state"))) {
    throw new OrcaRouterPkceError(
      "denied",
      "授权回调 state 不匹配。",
      null,
      "已拒绝本次回调，请重新发起授权。",
    );
  }

  const error = searchParams.get("error");
  if (error) {
    throw new OrcaRouterPkceError(
      error === "access_denied" ? "denied" : "invalid-grant",
      `授权未通过（${error}）。`,
      null,
      "授权被拒绝或无效，可重新发起并批准授权。",
    );
  }

  const code = (searchParams.get("code") ?? "").trim();
  if (!code) {
    throw new OrcaRouterPkceError(
      "malformed-response",
      "授权回调缺少 code。",
      null,
      "未收到授权码，请重新发起授权。",
    );
  }

  return { code };
}

type ExchangePayload = {
  key?: unknown;
  user_id?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
};

function classifyHttpFailure(status: number, payload: ExchangePayload | null): OrcaRouterPkceError {
  const description = typeof payload?.error_description === "string" ? payload.error_description : "";

  if (status === 400) {
    return new OrcaRouterPkceError(
      "downgrade-defence",
      "授权码交换被拒绝（400）。",
      status,
      "授权码校验方式不被接受，请重新发起授权。",
    );
  }

  if (status === 403) {
    return new OrcaRouterPkceError(
      "invalid-grant",
      "授权码无效、已过期或已被使用。",
      status,
      "请重新发起授权以获取新的授权码。",
    );
  }

  if (status === 429) {
    return new OrcaRouterPkceError(
      "rate-limited",
      "授权请求过于频繁（429）。",
      status,
      "每 24 小时最多签发 10 个授权密钥，请稍后重试或改用 API Key。",
    );
  }

  return new OrcaRouterPkceError(
    "network",
    `授权码交换失败（${status}）${description ? `：${description}` : ""}`,
    status,
    "网络或服务异常，请稍后重试。",
  );
}

export type ExchangeDependencies = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Exchanges an auth code for a durable OrcaRouter API key.
 *
 * The response `scope` is what was *granted*, not what was requested — it is
 * read back and surfaced rather than assumed.
 */
export async function exchangeAuthCode(
  input: {
    origins: OrcaRouterOrigins;
    code: string;
    verifier: string;
    requestedScope?: OrcaRouterScope;
  },
  dependencies: ExchangeDependencies = {},
): Promise<OrcaRouterCredentialResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(buildKeyExchangeEndpoint(input.origins.authBase), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        code_verifier: input.verifier,
        code_challenge_method: PKCE_CODE_CHALLENGE_METHOD,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    // The verifier and code are deliberately absent from this message.
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new OrcaRouterPkceError(
      aborted ? "timeout" : "network",
      aborted ? "授权码交换超时。" : "授权码交换网络请求失败。",
      null,
      "请检查网络后重新发起授权。",
    );
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();

  let payload: ExchangePayload | null = null;
  try {
    payload = raw ? (JSON.parse(raw) as ExchangePayload) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw classifyHttpFailure(response.status, payload);
  }

  const key = typeof payload?.key === "string" ? payload.key.trim() : "";
  if (!key) {
    throw new OrcaRouterPkceError(
      "malformed-response",
      "授权响应中没有可用的密钥。",
      response.status,
      "服务返回异常，请重新发起授权。",
    );
  }

  const grantedScope = typeof payload?.scope === "string" ? payload.scope : null;
  const requestedScope = input.requestedScope ?? "api";

  if (grantedScope && grantedScope !== requestedScope) {
    // Granted less than requested: report it instead of assuming the wider grant.
    throw new OrcaRouterPkceError(
      "denied",
      `授权范围不足：请求 ${requestedScope}，实际授权 ${grantedScope}。`,
      response.status,
      "当前账号权限不足，请使用 API Key 或联系工作区管理员。",
    );
  }

  return {
    source: "pkce",
    apiKey: key,
    accountId: typeof payload?.user_id === "string" || typeof payload?.user_id === "number"
      ? String(payload.user_id)
      : null,
    scope: grantedScope,
    needsReauth: false,
  };
}
