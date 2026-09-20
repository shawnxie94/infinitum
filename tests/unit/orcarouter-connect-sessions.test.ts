import { describe, expect, it, vi } from "vitest";

import { ConnectSessions } from "@/lib/ai/orcarouter/connect-sessions";
import { OrcaRouterPkceError } from "@/lib/ai/orcarouter/pkce";
import { resolveOrcaRouterOrigins } from "@/lib/ai/orcarouter/origins";
import type { OrcaRouterCredentialResult } from "@/lib/ai/orcarouter/credentials";

const FAKE_KEY = "sk-orca-sessiontest00000000000000000000000";
const AUTH_BASE = "https://www.orcarouter.ai";

const FAKE_CREDENTIAL: OrcaRouterCredentialResult = {
  source: "pkce",
  apiKey: FAKE_KEY,
  accountId: "12345",
  scope: "api",
  needsReauth: false,
};

function createSessions(overrides: { now?: () => number; exchange?: ReturnType<typeof vi.fn> } = {}) {
  let currentNow = 1_000;
  const now = overrides.now ?? (() => currentNow);

  const sessions = new ConnectSessions({
    origins: resolveOrcaRouterOrigins({}),
    appName: "Infinitum",
    now,
    exchange:
      (overrides.exchange as never) ??
      (vi.fn(async () => FAKE_CREDENTIAL) as never),
  });

  return { sessions, advance: (ms: number) => (currentNow += ms) };
}

describe("connect sessions: one pending authorization per config", () => {
  it("starts a pending attempt with an authorize URL on the auth origin", () => {
    const { sessions } = createSessions();
    const session = sessions.start({ configId: "cfg-1" });

    expect(session.status).toBe("pending");
    expect(session.authorizeUrl.startsWith(`${AUTH_BASE}/auth?`)).toBe(true);
    expect(new URL(session.authorizeUrl).searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("supersedes a previous attempt so the lock is never left held", () => {
    const { sessions } = createSessions();
    const first = sessions.start({ configId: "cfg-1" });
    const second = sessions.start({ configId: "cfg-1" });

    expect(second.generation).toBeGreaterThan(first.generation);
    expect(sessions.get("cfg-1")!.status).toBe("pending");
  });

  it("exposes no verifier or key to the client projection", () => {
    const { sessions } = createSessions();
    const session = sessions.start({ configId: "cfg-1" });
    const publicView = sessions.toPublicSession(session);
    const serialized = JSON.stringify(publicView);

    const secret = sessions.getVerifier("cfg-1")!;
    // The verifier never leaves the process: not in the projection, and never
    // on the authorize URL either.
    expect(serialized).not.toContain(secret.verifier);
    expect(session.authorizeUrl).not.toContain(secret.verifier);
    expect(Object.keys(publicView)).not.toContain("verifier");
    expect(Object.keys(publicView)).not.toContain("state");
    expect(Object.keys(publicView)).not.toContain("apiKey");
    // `state` is the CSRF token and is expected on the authorize URL; it is
    // echoed back by the consent screen and compared before the code is used.
    expect(new URL(session.authorizeUrl).searchParams.get("state")).toBe(secret.state);
  });

  it("cancels idempotently and releases the lock", () => {
    const { sessions } = createSessions();
    sessions.start({ configId: "cfg-1" });

    sessions.cancel("cfg-1");
    sessions.cancel("cfg-1");

    expect(sessions.get("cfg-1")!.status).toBe("cancelled");
  });

  it("expires a pending attempt into a terminal timeout instead of hanging", () => {
    const { sessions, advance } = createSessions();
    sessions.start({ configId: "cfg-1" });

    advance(11 * 60 * 1000);

    expect(sessions.get("cfg-1")!.status).toBe("timeout");
    // A new attempt can start immediately after the timeout.
    const restarted = sessions.start({ configId: "cfg-1" });
    expect(restarted.status).toBe("pending");
  });
});

describe("connect sessions: completion is generation-safe", () => {
  it("persists the credential on a successful exchange", async () => {
    const { sessions } = createSessions();
    const started = sessions.start({ configId: "cfg-1" });
    const persist = vi.fn(async () => {});

    const result = await sessions.complete({
      configId: "cfg-1",
      generation: started.generation,
      code: "fake-code",
      persist,
    });

    expect(result.ok).toBe(true);
    expect(persist).toHaveBeenCalledWith(FAKE_CREDENTIAL);
    expect(sessions.get("cfg-1")!.status).toBe("success");
    // The verifier is dropped once the exchange completes.
    expect(sessions.getVerifier("cfg-1")).toBeNull();
  });

  it("refuses a stale generation without touching credentials", async () => {
    const { sessions } = createSessions();
    const first = sessions.start({ configId: "cfg-1" });
    // A second login supersedes the first while its exchange is in flight.
    sessions.start({ configId: "cfg-1" });

    const persist = vi.fn(async () => {});
    const result = await sessions.complete({
      configId: "cfg-1",
      generation: first.generation,
      code: "fake-code",
      persist,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("取代");
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not let a late failure overwrite a newer login", async () => {
    let releaseExchange: (() => void) | null = null;
    const exchange = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseExchange = resolve;
      });
      throw new OrcaRouterPkceError("invalid-grant", "过期", 403, "重新登录");
    });

    const { sessions } = createSessions({ exchange });
    const stale = sessions.start({ configId: "cfg-1" });

    const inFlight = sessions.complete({
      configId: "cfg-1",
      generation: stale.generation,
      code: "fake-code",
      persist: vi.fn(async () => {}),
    });

    // The user reconnects before the old exchange fails.
    const fresh = sessions.start({ configId: "cfg-1" });
    releaseExchange!();

    const result = await inFlight;
    expect(result.ok).toBe(false);
    // The fresh attempt is untouched: still pending, not marked failed.
    const current = sessions.get("cfg-1")!;
    expect(current.generation).toBe(fresh.generation);
    expect(current.status).toBe("pending");
  });

  it("marks a denied authorization as terminal rather than retrying", async () => {
    const exchange = vi.fn(async () => {
      throw new OrcaRouterPkceError("denied", "授权被拒绝", null, "重新发起");
    });
    const { sessions } = createSessions({ exchange });
    const started = sessions.start({ configId: "cfg-1" });

    const result = await sessions.complete({
      configId: "cfg-1",
      generation: started.generation,
      code: "fake-code",
      persist: vi.fn(async () => {}),
    });

    expect(result.ok).toBe(false);
    expect(sessions.get("cfg-1")!.status).toBe("denied");
  });

  it("classifies a timeout exchange as a timeout status", async () => {
    const exchange = vi.fn(async () => {
      throw new OrcaRouterPkceError("timeout", "交换超时", null, "重试");
    });
    const { sessions } = createSessions({ exchange });
    const started = sessions.start({ configId: "cfg-1" });

    await sessions.complete({
      configId: "cfg-1",
      generation: started.generation,
      code: "fake-code",
      persist: vi.fn(async () => {}),
    });

    expect(sessions.get("cfg-1")!.status).toBe("timeout");
  });

  it("refuses to complete an expired attempt", async () => {
    const { sessions, advance } = createSessions();
    const started = sessions.start({ configId: "cfg-1" });
    advance(11 * 60 * 1000);

    const persist = vi.fn(async () => {});
    const result = await sessions.complete({
      configId: "cfg-1",
      generation: started.generation,
      code: "fake-code",
      persist,
    });

    expect(result.ok).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps the old secret when persistence fails, so a transient error is recoverable", async () => {
    const { sessions } = createSessions();
    const started = sessions.start({ configId: "cfg-1" });

    // The credential write throws: the stored key must not have been cleared
    // beforehand, which is why persistence happens only on success.
    const persist = vi.fn(async () => {
      throw new Error("db unavailable");
    });

    await expect(
      sessions.complete({
        configId: "cfg-1",
        generation: started.generation,
        code: "fake-code",
        persist,
      }),
    ).rejects.toThrow("db unavailable");

    // The attempt did not report success.
    expect(sessions.get("cfg-1")!.status).toBe("pending");
  });

  it("allows a second login without remounting after a pagehide-style invalidation", () => {
    const { sessions } = createSessions();
    const first = sessions.start({ configId: "cfg-1" });

    // What the client's pagehide handler does: invalidate + cancel server-side.
    sessions.cancel("cfg-1");

    const second = sessions.start({ configId: "cfg-1" });
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second.status).toBe("pending");
    expect(second.authorizeUrl).not.toBe(first.authorizeUrl);
  });
});
