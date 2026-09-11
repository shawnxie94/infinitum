/**
 * OrcaRouter origin resolution.
 *
 * OrcaRouter splits authentication from inference across two public origins:
 *   - auth / code exchange: https://www.orcarouter.ai
 *   - inference + model catalog: https://api.orcarouter.ai/v1
 *
 * The two must never be derived from one another by swapping a hostname or by
 * blindly appending `/v1`: `https://api.orcarouter.ai/v1/auth/keys` is a 404.
 * Self-hosted deployments may run both on one shared origin, so a shared
 * `ORCA_BASE_URL` fallback is supported next to the explicit per-origin
 * overrides. Explicit overrides always win.
 */

export const ORCAROUTER_PUBLIC_AUTH_BASE = "https://www.orcarouter.ai";
export const ORCAROUTER_PUBLIC_API_BASE = "https://api.orcarouter.ai/v1";

export type OrcaRouterOrigins = {
  authBase: string;
  apiBase: string;
  authSource: "override" | "shared" | "public";
  apiSource: "override" | "shared" | "public";
};

export type OrcaRouterOriginEnv = {
  [key: string]: string | undefined;
  ORCA_AUTH_BASE_URL?: string;
  ORCA_API_BASE_URL?: string;
  ORCA_BASE_URL?: string;
};

export class OrcaRouterOriginError extends Error {}

function stripTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Remote origins must be HTTPS. Plain HTTP is tolerated only for loopback
 * development, matching the callback_url policy of the consent endpoint.
 */
export function assertUsableOrigin(raw: string, label: string): string {
  const value = stripTrailingSlash(raw);
  if (!value) {
    throw new OrcaRouterOriginError(`${label} 不能为空。`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OrcaRouterOriginError(`${label} 不是合法 URL。`);
  }

  if (parsed.protocol === "https:") {
    return value;
  }

  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
    return value;
  }

  throw new OrcaRouterOriginError(`${label} 必须使用 HTTPS（仅回环地址允许 HTTP）。`);
}

/**
 * A shared self-hosted base serves both roles. The inference API keeps the
 * `/v1` suffix; the auth surface stays at the origin root, which is why the
 * suffix is applied here explicitly rather than by hostname substitution.
 */
function apiBaseFromSharedBase(shared: string): string {
  return /\/v1$/.test(shared) ? shared : `${shared}/v1`;
}

export function resolveOrcaRouterOrigins(env: OrcaRouterOriginEnv = {}): OrcaRouterOrigins {
  const authOverride = stripTrailingSlash(env.ORCA_AUTH_BASE_URL ?? "");
  const apiOverride = stripTrailingSlash(env.ORCA_API_BASE_URL ?? "");
  const shared = stripTrailingSlash(env.ORCA_BASE_URL ?? "");

  const sharedUsable = shared ? assertUsableOrigin(shared, "ORCA_BASE_URL") : "";

  const authBase = authOverride
    ? assertUsableOrigin(authOverride, "ORCA_AUTH_BASE_URL")
    : sharedUsable || ORCAROUTER_PUBLIC_AUTH_BASE;

  const apiBase = apiOverride
    ? assertUsableOrigin(apiOverride, "ORCA_API_BASE_URL")
    : sharedUsable
      ? apiBaseFromSharedBase(sharedUsable)
      : ORCAROUTER_PUBLIC_API_BASE;

  return {
    authBase,
    apiBase,
    authSource: authOverride ? "override" : sharedUsable ? "shared" : "public",
    apiSource: apiOverride ? "override" : sharedUsable ? "shared" : "public",
  };
}

/** `/auth` on the auth origin. Never built from the inference origin. */
export function buildAuthorizeEndpoint(authBase: string): string {
  return `${stripTrailingSlash(authBase)}/auth`;
}

/** `/api/v1/auth/keys` on the auth origin — not `/v1/auth/keys` on the relay. */
export function buildKeyExchangeEndpoint(authBase: string): string {
  return `${stripTrailingSlash(authBase)}/api/v1/auth/keys`;
}

export function buildModelsEndpoint(apiBase: string, capability?: string): string {
  const url = new URL(`${stripTrailingSlash(apiBase)}/models`);
  if (capability) {
    url.searchParams.set("capability", capability);
  }
  return url.toString();
}
