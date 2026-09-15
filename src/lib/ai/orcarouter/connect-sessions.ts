/**
 * OrcaRouter connect sessions.
 *
 * One server-side "login already in progress" lock per model API config, with a
 * monotonically increasing generation. Every async completion must still belong
 * to the current generation before it may touch credentials or UI state — a
 * late success from an abandoned attempt must never appear under a new one.
 *
 * Terminal paths that release the lock: success, denial, exchange error,
 * timeout, explicit cancel, switching provider/auth method, modal close,
 * unmount, reload/window close and `pagehide`.
 */

import crypto from "node:crypto";

import {
  AUTH_CODE_TTL_MS,
  createPkceAttempt,
  exchangeAuthCode,
  type OrcaRouterCallbackMode,
  type OrcaRouterScope,
} from "./pkce";
import { resolveOrcaRouterOrigins, type OrcaRouterOrigins } from "./origins";
import type { OrcaRouterCredentialResult } from "./credentials";

export type OrcaRouterConnectStatus =
  | "idle"
  | "pending"
  | "exchange-error"
  | "denied"
  | "timeout"
  | "cancelled"
  | "success";

export type OrcaRouterConnectSession = {
  attemptId: string;
  generation: number;
  status: OrcaRouterConnectStatus;
  authorizeUrl: string;
  requestedScope: OrcaRouterScope;
  callbackMode: OrcaRouterCallbackMode;
  startedAt: number;
  expiresAt: number;
  credential: OrcaRouterCredentialResult | null;
  error: string | null;
};

export type ConnectSessionsDependencies = {
  origins?: OrcaRouterOrigins;
  appName?: string;
  now?: () => number;
  /** Injected in tests to exercise the exchange without network access. */
  exchange?: typeof exchangeAuthCode;
};

const DEFAULT_APP_NAME = "Infinitum";

export class ConnectSessions {
  private readonly sessions = new Map<string, OrcaRouterConnectSession>();
  private generation = 0;

  constructor(private readonly dependencies: ConnectSessionsDependencies = {}) {}

  private now(): number {
    return this.dependencies.now ? this.dependencies.now() : Date.now();
  }

  private origins(): OrcaRouterOrigins {
    return this.dependencies.origins ?? resolveOrcaRouterOrigins(process.env);
  }

  get(configId: string): OrcaRouterConnectSession | null {
    const session = this.sessions.get(configId) ?? null;
    if (!session) {
      return null;
    }

    if (session.status === "pending" && session.expiresAt <= this.now()) {
      // An expired authorization window is terminal: the lock is released so a
      // new attempt can start rather than leaving the UI stuck busy.
      const expired: OrcaRouterConnectSession = {
        ...session,
        status: "timeout",
        credential: null,
        error: "授权窗口已过期，请重新发起。",
      };
      this.sessions.set(configId, expired);
      return expired;
    }

    return session;
  }

  /** Cancels any in-flight attempt and marks it terminal. Idempotent. */
  cancel(configId: string, status: OrcaRouterConnectStatus = "cancelled"): void {
    const session = this.sessions.get(configId);
    if (!session || session.status !== "pending") {
      return;
    }

    this.sessions.set(configId, {
      ...session,
      status,
      credential: null,
      error: status === "denied" ? "授权被拒绝。" : null,
    });
  }

  /** Starts a fresh attempt, superseding any previous generation. */
  start(input: {
    configId: string;
    callbackMode?: OrcaRouterCallbackMode;
    callbackUrl?: string;
    scope?: OrcaRouterScope;
  }): OrcaRouterConnectSession {
    // Superseding an in-flight attempt must not leave the old one pending.
    this.cancel(input.configId);

    this.generation += 1;
    const callbackMode = input.callbackMode ?? "out-of-band";
    const attempt = createPkceAttempt({
      origins: this.origins(),
      callbackMode,
      callbackUrl: input.callbackUrl,
      appName: this.dependencies.appName ?? DEFAULT_APP_NAME,
      scope: input.scope,
    });

    const startedAt = this.now();
    const session: OrcaRouterConnectSession = {
      attemptId: attempt.attemptId,
      generation: this.generation,
      status: "pending",
      authorizeUrl: attempt.authorizeUrl,
      requestedScope: attempt.requestedScope,
      callbackMode,
      startedAt,
      expiresAt: startedAt + AUTH_CODE_TTL_MS,
      credential: null,
      error: null,
    };

    this.sessions.set(input.configId, session);
    // The verifier stays in a private side table; it is never serialized to the
    // client, logged, or echoed in an error message.
    this.verifiers.set(input.configId, {
      generation: session.generation,
      verifier: attempt.verifier,
      state: attempt.state,
    });

    return session;
  }

  private readonly verifiers = new Map<
    string,
    { generation: number; verifier: string; state: string }
  >();

  getVerifier(configId: string): { generation: number; verifier: string; state: string } | null {
    return this.verifiers.get(configId) ?? null;
  }

  /** Safe projection for the browser: no verifier, no key, no state. */
  toPublicSession(session: OrcaRouterConnectSession) {
    return {
      attemptId: session.attemptId,
      generation: session.generation,
      status: session.status,
      authorizeUrl: session.authorizeUrl,
      requestedScope: session.requestedScope,
      callbackMode: session.callbackMode,
      accountId: session.credential?.accountId ?? null,
      grantedScope: session.credential?.scope ?? null,
      error: session.error,
    };
  }

  /**
   * Redeems an auth code (Flow B paste, or a Flow A callback code) and persists
   * the durable key through `persist`. A generation check runs after the async
   * exchange so a superseded attempt cannot write credentials.
   */
  async complete(input: {
    configId: string;
    generation: number;
    code: string;
    persist: (credential: OrcaRouterCredentialResult) => Promise<void>;
  }): Promise<{ ok: boolean; session: OrcaRouterConnectSession | null; error?: string }> {
    const session = this.sessions.get(input.configId);
    const verifier = this.verifiers.get(input.configId);

    if (!session || !verifier) {
      return { ok: false, session: null, error: "没有进行中的授权请求。" };
    }

    if (session.generation !== input.generation || verifier.generation !== input.generation) {
      // A stale response from an older attempt: refuse without touching state.
      return { ok: false, session, error: "该授权请求已被新的登录取代。" };
    }

    if (session.status !== "pending") {
      return { ok: false, session, error: "该授权请求已结束。" };
    }

    if (session.expiresAt <= this.now()) {
      this.cancel(input.configId, "timeout");
      return { ok: false, session: this.get(input.configId), error: "授权窗口已过期，请重新发起。" };
    }

    const exchange = this.dependencies.exchange ?? exchangeAuthCode;

    let credential: OrcaRouterCredentialResult;
    try {
      credential = await exchange({
        origins: this.origins(),
        code: input.code,
        verifier: verifier.verifier,
        requestedScope: session.requestedScope,
      });
    } catch (error) {
      // Re-check: the attempt may have been superseded while the exchange was
      // in flight, in which case this failure must not overwrite the new state.
      const current = this.sessions.get(input.configId);
      if (!current || current.generation !== input.generation) {
        return { ok: false, session: current ?? null, error: "该授权请求已被新的登录取代。" };
      }

      const kind = (error as { kind?: string }).kind;
      const failed: OrcaRouterConnectSession = {
        ...current,
        status:
          kind === "denied" ? "denied" : kind === "timeout" ? "timeout" : "exchange-error",
        credential: null,
        error: error instanceof Error ? error.message : "授权失败。",
      };
      this.sessions.set(input.configId, failed);
      this.verifiers.delete(input.configId);
      return { ok: false, session: failed, error: failed.error ?? undefined };
    }

    const current = this.sessions.get(input.configId);
    if (!current || current.generation !== input.generation) {
      return { ok: false, session: current ?? null, error: "该授权请求已被新的登录取代。" };
    }

    await input.persist(credential);

    const succeeded: OrcaRouterConnectSession = {
      ...current,
      status: "success",
      credential,
      error: null,
    };
    this.sessions.set(input.configId, succeeded);
    this.verifiers.delete(input.configId);

    return { ok: true, session: succeeded };
  }

  /** Clears all sessions. Used by tests and by full app teardown. */
  reset(): void {
    this.sessions.clear();
    this.verifiers.clear();
    this.generation = 0;
  }
}

/**
 * A stable attempt id for the browser, so the client can send back exactly the
 * generation whose exchange it is completing.
 */
export function newAttemptId(): string {
  return crypto.randomBytes(9).toString("base64url");
}
