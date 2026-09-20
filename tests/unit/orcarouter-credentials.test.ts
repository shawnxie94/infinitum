import { describe, expect, it } from "vitest";

import {
  apiKeyCredentialAdapter,
  decideReauth,
  getOrcaRouterCredentialAdapter,
  looksLikeOrcaRouterKey,
  maskOrcaRouterKey,
  nextCredentialGeneration,
  pkceCredentialAdapter,
  resolveOrcaRouterCredential,
  type OrcaRouterStoredCredential,
} from "@/lib/ai/orcarouter/credentials";

const FAKE_API_KEY = "sk-orca-testonly0000000000000000000000000000";
const FAKE_PKCE_KEY = "sk-orca-pkcetestonly00000000000000000000000000";

function stored(overrides: Partial<OrcaRouterStoredCredential> = {}): OrcaRouterStoredCredential {
  return {
    authMethod: "api-key",
    apiKey: "",
    accountId: "",
    scope: "",
    needsReauth: false,
    credentialGeneration: 1,
    ...overrides,
  };
}

describe("OrcaRouter credential seam", () => {
  it("both adapters produce the same credential result shape", () => {
    const fromApiKey = apiKeyCredentialAdapter.read({
      stored: stored({ authMethod: "api-key", apiKey: FAKE_API_KEY }),
    });
    const fromPkce = pkceCredentialAdapter.read({
      stored: stored({
        authMethod: "pkce",
        apiKey: FAKE_PKCE_KEY,
        accountId: "12345",
        scope: "api",
      }),
    });

    expect(fromApiKey).not.toBeNull();
    expect(fromPkce).not.toBeNull();

    // Same keys, same downstream meaning — only the provenance differs.
    expect(Object.keys(fromApiKey!).sort()).toEqual(Object.keys(fromPkce!).sort());
    expect(fromApiKey!.source).toBe("api-key");
    expect(fromPkce!.source).toBe("pkce");
    expect(fromApiKey!.apiKey).toBe(FAKE_API_KEY);
    expect(fromPkce!.apiKey).toBe(FAKE_PKCE_KEY);
  });

  it("resolves through the adapter selected by the stored auth method", () => {
    const resolved = resolveOrcaRouterCredential({
      stored: stored({ authMethod: "pkce", apiKey: FAKE_PKCE_KEY, accountId: "42", scope: "api" }),
    });

    expect(resolved!.source).toBe("pkce");
    expect(resolved!.accountId).toBe("42");
    expect(resolved!.scope).toBe("api");
    expect(getOrcaRouterCredentialAdapter("pkce")).toBe(pkceCredentialAdapter);
  });

  it("API-key adapter falls back to the project env key only when nothing is stored", () => {
    const fromEnv = apiKeyCredentialAdapter.read({
      stored: stored(),
      envApiKey: FAKE_API_KEY,
    });
    expect(fromEnv!.apiKey).toBe(FAKE_API_KEY);

    const storedWins = apiKeyCredentialAdapter.read({
      stored: stored({ apiKey: FAKE_PKCE_KEY }),
      envApiKey: FAKE_API_KEY,
    });
    expect(storedWins!.apiKey).toBe(FAKE_PKCE_KEY);
  });

  it("never lets the PKCE adapter fall back to an env key", () => {
    const result = pkceCredentialAdapter.read({
      stored: stored({ authMethod: "pkce", apiKey: "" }),
      envApiKey: FAKE_API_KEY,
    });
    expect(result).toBeNull();
  });

  it("returns null when no credential of any kind is available", () => {
    expect(resolveOrcaRouterCredential({ stored: stored() })).toBeNull();
  });

  it("masks keys without revealing them", () => {
    const masked = maskOrcaRouterKey(FAKE_API_KEY);
    expect(masked).not.toContain(FAKE_API_KEY);
    expect(masked).toMatch(/^sk-orca-\*+/);
    expect(maskOrcaRouterKey("")).toBe("");
  });

  it("treats the sk-orca- prefix as a format hint, not proof of validity", () => {
    expect(looksLikeOrcaRouterKey(FAKE_API_KEY)).toBe(true);
    expect(looksLikeOrcaRouterKey("sk-orca-x")).toBe(false);
    expect(looksLikeOrcaRouterKey("sk-other-000000000000")).toBe(false);
  });
});

describe("terminal 401 reauthentication is generation-safe", () => {
  it("marks only the exact account and generation that made the rejected request", () => {
    const decision = decideReauth({
      rejectedAccountId: "12345",
      rejectedGeneration: 3,
      current: stored({ authMethod: "pkce", accountId: "12345", credentialGeneration: 3 }),
    });

    expect(decision).toEqual({ shouldMark: true, accountId: "12345", generation: 3 });
  });

  it("does not let a late failure poison a newly reauthorised credential", () => {
    // The user reconnected while the old request was still in flight.
    const decision = decideReauth({
      rejectedAccountId: "12345",
      rejectedGeneration: 3,
      current: stored({ authMethod: "pkce", accountId: "12345", credentialGeneration: 4 }),
    });

    expect(decision.shouldMark).toBe(false);
  });

  it("does not mark a different account that happens to share the generation", () => {
    const decision = decideReauth({
      rejectedAccountId: "12345",
      rejectedGeneration: 1,
      current: stored({ authMethod: "pkce", accountId: "99999", credentialGeneration: 1 }),
    });

    expect(decision.shouldMark).toBe(false);
  });

  it("advances the generation on each successful authentication", () => {
    expect(nextCredentialGeneration(1)).toBe(2);
    expect(nextCredentialGeneration(0)).toBe(1);
  });
});
