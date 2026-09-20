/**
 * The OrcaRouter credential seam.
 *
 * Both user-facing authentication choices — a pasted `sk-orca-…` API key and
 * the OAuth 2.0 + PKCE connect flow — are adapters over one small interface.
 * They produce the same `OrcaRouterCredentialResult`, so provider requests,
 * model discovery, and every AI call site consume a credential without ever
 * branching on where it came from.
 *
 * A PKCE-issued key is a durable key: it is reused until OrcaRouter revokes
 * it. It is not a refresh token — there is no refresh grant, and none is
 * attempted here.
 */

export type OrcaRouterCredentialSource = "api-key" | "pkce";

export type OrcaRouterCredentialResult = {
  source: OrcaRouterCredentialSource;
  apiKey: string;
  /** Stable identity of the account the key belongs to, when known. */
  accountId: string | null;
  /** Scope actually granted by the server. */
  scope: string | null;
  needsReauth: boolean;
};

/** Persisted shape of one model API configuration's OrcaRouter credential. */
export type OrcaRouterStoredCredential = {
  authMethod: OrcaRouterCredentialSource;
  apiKey: string;
  accountId: string;
  scope: string;
  needsReauth: boolean;
  /**
   * Monotonic per-account credential generation. A `401` may only mark the
   * exact account+generation that issued the rejected request.
   */
  credentialGeneration: number;
};

export type OrcaRouterCredentialContext = {
  stored: OrcaRouterStoredCredential;
  /** Project-level fallback (`ORCAROUTER_API_KEY`), used only by the API-key adapter. */
  envApiKey?: string;
};

export interface OrcaRouterCredentialAdapter {
  readonly source: OrcaRouterCredentialSource;
  /** Returns null when this adapter has no usable credential. */
  read(context: OrcaRouterCredentialContext): OrcaRouterCredentialResult | null;
}

/** Loose format check only — an `sk-orca-` prefix is not proof of validity. */
export function looksLikeOrcaRouterKey(value: string): boolean {
  return /^sk-orca-[A-Za-z0-9._-]{8,}$/.test(value.trim());
}

export function maskOrcaRouterKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 8) {
    return "****";
  }
  return `${trimmed.slice(0, 8)}****${trimmed.slice(-4)}`;
}

/**
 * API-key choice: a key the user pasted, or the project-level env fallback.
 * Independent of PKCE; usable without a browser and without an account login.
 */
export const apiKeyCredentialAdapter: OrcaRouterCredentialAdapter = {
  source: "api-key",
  read(context) {
    const stored = context.stored.apiKey.trim();
    const fallback = (context.envApiKey ?? "").trim();
    const apiKey = stored || fallback;

    if (!apiKey) {
      return null;
    }

    return {
      source: "api-key",
      apiKey,
      accountId: context.stored.accountId || null,
      scope: context.stored.scope || null,
      needsReauth: context.stored.needsReauth,
    };
  },
};

/**
 * Connect-with-OrcaRouter choice: the durable key minted by the PKCE exchange.
 * Reused across restarts; never refreshed, never re-authorised on launch.
 */
export const pkceCredentialAdapter: OrcaRouterCredentialAdapter = {
  source: "pkce",
  read(context) {
    const apiKey = context.stored.apiKey.trim();
    if (!apiKey) {
      return null;
    }

    return {
      source: "pkce",
      apiKey,
      accountId: context.stored.accountId || null,
      scope: context.stored.scope || null,
      needsReauth: context.stored.needsReauth,
    };
  },
};

const ADAPTERS: Record<OrcaRouterCredentialSource, OrcaRouterCredentialAdapter> = {
  "api-key": apiKeyCredentialAdapter,
  pkce: pkceCredentialAdapter,
};

export function getOrcaRouterCredentialAdapter(
  source: OrcaRouterCredentialSource,
): OrcaRouterCredentialAdapter {
  return ADAPTERS[source];
}

/**
 * Resolves the credential for a configuration through its selected adapter.
 * Callers downstream of this function do not know which choice was used.
 */
export function resolveOrcaRouterCredential(
  context: OrcaRouterCredentialContext,
): OrcaRouterCredentialResult | null {
  return getOrcaRouterCredentialAdapter(context.stored.authMethod).read(context);
}

export type OrcaRouterReauthDecision = {
  shouldMark: boolean;
  accountId: string | null;
  generation: number | null;
};

/**
 * Terminal `401` handling: only the exact account and credential generation
 * that made the rejected request is marked `needsReauth`. A late failure from
 * an older request can never poison a freshly reauthorised credential.
 */
export function decideReauth(input: {
  rejectedAccountId: string | null;
  rejectedGeneration: number;
  current: OrcaRouterStoredCredential;
}): OrcaRouterReauthDecision {
  const sameAccount = (input.current.accountId || null) === (input.rejectedAccountId || null);
  const sameGeneration = input.current.credentialGeneration === input.rejectedGeneration;

  if (!sameAccount || !sameGeneration) {
    return { shouldMark: false, accountId: null, generation: null };
  }

  return {
    shouldMark: true,
    accountId: input.rejectedAccountId,
    generation: input.rejectedGeneration,
  };
}

/** Advances the generation after a successful (re)authentication. */
export function nextCredentialGeneration(current: number): number {
  return Number.isFinite(current) && current > 0 ? Math.floor(current) + 1 : 1;
}
