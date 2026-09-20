import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  OrcaRouterPkceError,
  computeCodeChallenge,
  createPkceAttempt,
  createPkceVerifier,
  exchangeAuthCode,
  isStateMatch,
  verifyLoopbackCallback,
} from "@/lib/ai/orcarouter/pkce";
import { resolveOrcaRouterOrigins } from "@/lib/ai/orcarouter/origins";

const FAKE_ISSUED_KEY = "sk-orca-faketestkey00000000000000000000000000";

type IssuedCode = { challenge: string; method: string; used: boolean };

/**
 * A local fake OrcaRouter auth origin. It implements the documented contract:
 * `/auth` mints a single-use code bound to the S256 challenge, and
 * `/api/v1/auth/keys` redeems it only when the verifier hashes to that
 * challenge. Notes which origin each request arrived on.
 */
function createFakeAuthServer(options: {
  failExchangeWith?: number;
  grantedScope?: string;
  omitScope?: boolean;
  omitKey?: boolean;
} = {}) {
  const codes = new Map<string, IssuedCode>();
  const seen: { authorize: string[]; exchange: string[] } = { authorize: [], exchange: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/auth") {
      seen.authorize.push(url.toString());
      const code = crypto.randomBytes(8).toString("base64url");
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        method: url.searchParams.get("code_challenge_method") ?? "",
        used: false,
      });

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<p>Consent. Code: ${code}</p>`);
      return;
    }

    if (url.pathname === "/api/v1/auth/keys" && req.method === "POST") {
      seen.exchange.push(url.pathname);

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const fail = (status: number, payload: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };

        if (options.failExchangeWith) {
          fail(options.failExchangeWith, { error: "server_error", error_description: "boom" });
          return;
        }

        const parsed = JSON.parse(body) as {
          code?: string;
          code_verifier?: string;
          code_challenge_method?: string;
        };

        if (parsed.code_challenge_method !== "S256") {
          fail(400, { error: "invalid_request" });
          return;
        }

        const issued = parsed.code ? codes.get(parsed.code) : undefined;
        // Unknown, expired, already used, or verifier/challenge mismatch.
        if (!issued || issued.used || issued.method !== "S256") {
          fail(403, { error: "invalid_grant" });
          return;
        }

        const expected = crypto
          .createHash("sha256")
          .update(parsed.code_verifier ?? "")
          .digest()
          .toString("base64url");

        if (expected !== issued.challenge) {
          fail(403, { error: "invalid_grant" });
          return;
        }

        issued.used = true;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ...(options.omitKey ? {} : { key: FAKE_ISSUED_KEY }),
            user_id: "12345",
            ...(options.omitScope ? {} : { scope: options.grantedScope ?? "api" }),
          }),
        );
      });
      return;
    }

    res.writeHead(404).end();
  });

  return { server, codes, seen };
}

let fake: ReturnType<typeof createFakeAuthServer>;
let authBase = "";

beforeAll(async () => {
  fake = createFakeAuthServer();
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  authBase = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});

function originsFor(base: string) {
  return resolveOrcaRouterOrigins({ ORCA_AUTH_BASE_URL: base });
}

describe("PKCE primitives", () => {
  it("builds a fresh verifier and state per attempt from a crypto RNG", () => {
    const first = createPkceAttempt({ origins: originsFor(authBase), callbackMode: "out-of-band", appName: "Infinitum" });
    const second = createPkceAttempt({ origins: originsFor(authBase), callbackMode: "out-of-band", appName: "Infinitum" });

    expect(first.verifier).not.toBe(second.verifier);
    expect(first.state).not.toBe(second.state);
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("derives an unpadded base64url S256 challenge from the verifier", () => {
    const verifier = createPkceVerifier();
    const challenge = computeCodeChallenge(verifier);

    expect(challenge).toBe(
      crypto.createHash("sha256").update(verifier).digest().toString("base64url"),
    );
    expect(challenge).not.toContain("=");
    expect(challenge).not.toBe(verifier);
  });

  it("sends S256 and the challenge on the authorize URL — never the verifier", () => {
    const attempt = createPkceAttempt({
      origins: originsFor(authBase),
      callbackMode: "out-of-band",
      appName: "Infinitum",
    });
    const url = new URL(attempt.authorizeUrl);

    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(attempt.challenge);
    expect(url.searchParams.get("callback_url")).toBe("oob");
    expect(url.searchParams.get("state")).toBe(attempt.state);
    expect(url.searchParams.get("app_name")).toBe("Infinitum");
    expect(url.searchParams.get("scope")).toBe("api");

    // The verifier must not appear anywhere on the URL or its serialization.
    expect(attempt.authorizeUrl).not.toContain(attempt.verifier);
  });

  it("refuses a loopback attempt with no callback address", () => {
    expect(() =>
      createPkceAttempt({ origins: originsFor(authBase), callbackMode: "loopback", appName: "Infinitum" }),
    ).toThrow(OrcaRouterPkceError);
  });

  it("compares state in constant time and rejects length mismatch", () => {
    expect(isStateMatch("abc123", "abc123")).toBe(true);
    expect(isStateMatch("abc123", "abc124")).toBe(false);
    expect(isStateMatch("abc123", "abc12")).toBe(false);
    expect(isStateMatch("abc123", null)).toBe(false);
  });
});

describe("Flow B — out-of-band authorize → exchange → persist", () => {
  it("completes the documented flow through the real auth contract", async () => {
    const attempt = createPkceAttempt({
      origins: originsFor(authBase),
      callbackMode: "out-of-band",
      appName: "Infinitum",
    });

    // 1. The user opens the authorize URL and approves.
    const consent = await fetch(attempt.authorizeUrl);
    const consentBody = await consent.text();
    const code = /Code: ([A-Za-z0-9_-]+)/.exec(consentBody)![1];

    // The authorize request went to the auth origin, not the inference relay.
    expect(fake.seen.authorize).toHaveLength(1);
    expect(fake.seen.authorize[0]).not.toContain("api.orcarouter.ai");

    // 2. The code is exchanged with the verifier.
    const credential = await exchangeAuthCode({
      origins: originsFor(authBase),
      code,
      verifier: attempt.verifier,
      requestedScope: "api",
    });

    expect(credential.source).toBe("pkce");
    expect(credential.apiKey).toBe(FAKE_ISSUED_KEY);
    expect(credential.accountId).toBe("12345");
    expect(credential.scope).toBe("api");
    expect(credential.needsReauth).toBe(false);

    // Exchange used the auth origin's `/api/v1/auth/keys`, not the relay's `/v1`.
    expect(fake.seen.exchange).toEqual(["/api/v1/auth/keys"]);
  });

  it("refuses a reused code as a terminal invalid-grant, not a retry", async () => {
    const attempt = createPkceAttempt({
      origins: originsFor(authBase),
      callbackMode: "out-of-band",
      appName: "Infinitum",
    });

    const consentBody = await (await fetch(attempt.authorizeUrl)).text();
    const code = /Code: ([A-Za-z0-9_-]+)/.exec(consentBody)![1];

    await exchangeAuthCode({
      origins: originsFor(authBase),
      code,
      verifier: attempt.verifier,
    });

    const reuse = await exchangeAuthCode({
      origins: originsFor(authBase),
      code,
      verifier: attempt.verifier,
    }).catch((error: unknown) => error);

    expect(reuse).toBeInstanceOf(OrcaRouterPkceError);
    expect((reuse as OrcaRouterPkceError).kind).toBe("invalid-grant");
    expect((reuse as OrcaRouterPkceError).statusCode).toBe(403);
  });

  it("refuses a verifier that does not match the stored challenge", async () => {
    const attempt = createPkceAttempt({
      origins: originsFor(authBase),
      callbackMode: "out-of-band",
      appName: "Infinitum",
    });

    const consentBody = await (await fetch(attempt.authorizeUrl)).text();
    const code = /Code: ([A-Za-z0-9_-]+)/.exec(consentBody)![1];

    const mismatch = await exchangeAuthCode({
      origins: originsFor(authBase),
      code,
      verifier: createPkceVerifier(),
    }).catch((error: unknown) => error);

    expect((mismatch as OrcaRouterPkceError).kind).toBe("invalid-grant");
  });
});

describe("PKCE failure classification is safe and actionable", () => {
  it("never leaks the verifier or the code in an error message", async () => {
    const attempt = createPkceAttempt({
      origins: originsFor(authBase),
      callbackMode: "out-of-band",
      appName: "Infinitum",
    });

    const consentBody = await (await fetch(attempt.authorizeUrl)).text();
    const code = /Code: ([A-Za-z0-9_-]+)/.exec(consentBody)![1];

    const failure = (await exchangeAuthCode({
      origins: originsFor(authBase),
      code,
      verifier: createPkceVerifier(),
    }).catch((error: unknown) => error)) as OrcaRouterPkceError;

    const serialized = `${failure.message} ${failure.hint} ${JSON.stringify(failure)}`;
    expect(serialized).not.toContain(attempt.verifier);
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain(FAKE_ISSUED_KEY);
  });

  it("treats a 400 as a challenge-method downgrade refusal", async () => {
    const server = createFakeAuthServer({ failExchangeWith: 400 });
    await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

    const failure = (await exchangeAuthCode({
      origins: originsFor(base),
      code: "any",
      verifier: createPkceVerifier(),
    }).catch((error: unknown) => error)) as OrcaRouterPkceError;

    expect(failure.kind).toBe("downgrade-defence");

    await new Promise<void>((resolve) => server.server.close(() => resolve()));
  });

  it("surfaces 429 as a rate limit with actionable guidance, not a crash", async () => {
    const server = createFakeAuthServer({ failExchangeWith: 429 });
    await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

    const failure = (await exchangeAuthCode({
      origins: originsFor(base),
      code: "any",
      verifier: createPkceVerifier(),
    }).catch((error: unknown) => error)) as OrcaRouterPkceError;

    expect(failure.kind).toBe("rate-limited");
    expect(failure.hint).toContain("API Key");

    await new Promise<void>((resolve) => server.server.close(() => resolve()));
  });

  it("classifies an unreachable auth origin as a network failure without the key", async () => {
    const failure = (await exchangeAuthCode({
      // Port 1 on loopback: no listener.
      origins: originsFor("http://127.0.0.1:1"),
      code: "any",
      verifier: createPkceVerifier(),
    }).catch((error: unknown) => error)) as OrcaRouterPkceError;

    expect(failure.kind).toBe("network");
    expect(failure.message).not.toContain(FAKE_ISSUED_KEY);
  });

  it("reads the granted scope back and refuses a downgrade", async () => {
    const server = createFakeAuthServer({ grantedScope: "api" });
    await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

    const attempt = createPkceAttempt({
      origins: originsFor(base),
      callbackMode: "out-of-band",
      appName: "Infinitum",
      scope: "connector",
    });

    const consentBody = await (await fetch(attempt.authorizeUrl)).text();
    const code = /Code: ([A-Za-z0-9_-]+)/.exec(consentBody)![1];

    // Requested `connector`, granted `api`: report it rather than assume.
    const failure = (await exchangeAuthCode({
      origins: originsFor(base),
      code,
      verifier: attempt.verifier,
      requestedScope: "connector",
    }).catch((error: unknown) => error)) as OrcaRouterPkceError;

    expect(failure.kind).toBe("denied");
    expect(failure.message).toContain("connector");

    await new Promise<void>((resolve) => server.server.close(() => resolve()));
  });

  it("treats a response with no key as malformed rather than persisting nothing", async () => {
    const server = createFakeAuthServer({ omitKey: true });
    await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

    const attempt = createPkceAttempt({
      origins: originsFor(base),
      callbackMode: "out-of-band",
      appName: "Infinitum",
    });

    const consentBody = await (await fetch(attempt.authorizeUrl)).text();
    const code = /Code: ([A-Za-z0-9_-]+)/.exec(consentBody)![1];

    const failure = (await exchangeAuthCode({
      origins: originsFor(base),
      code,
      verifier: attempt.verifier,
    }).catch((error: unknown) => error)) as OrcaRouterPkceError;

    expect(failure.kind).toBe("malformed-response");

    await new Promise<void>((resolve) => server.server.close(() => resolve()));
  });

  it("times out instead of hanging when the auth origin never answers", async () => {
    const failingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });

    const failure = (await exchangeAuthCode(
      { origins: originsFor(authBase), code: "any", verifier: createPkceVerifier() },
      { fetchImpl: failingFetch, timeoutMs: 10 },
    ).catch((error: unknown) => error)) as OrcaRouterPkceError;

    expect(failure.kind).toBe("timeout");
  });
});

describe("Flow A callback verification", () => {
  it("rejects a callback whose state does not match before reading the code", () => {
    const params = new URLSearchParams({ code: "abc", state: "wrong" });

    expect(() => verifyLoopbackCallback(params, "expected")).toThrow(OrcaRouterPkceError);
    try {
      verifyLoopbackCallback(params, "expected");
    } catch (error) {
      expect((error as OrcaRouterPkceError).message).toContain("state");
    }
  });

  it("accepts a matching state and returns the code", () => {
    const params = new URLSearchParams({ code: "abc", state: "expected" });
    expect(verifyLoopbackCallback(params, "expected")).toEqual({ code: "abc" });
  });

  it("reports a denial from the consent screen", () => {
    const params = new URLSearchParams({ error: "access_denied", state: "expected" });

    try {
      verifyLoopbackCallback(params, "expected");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as OrcaRouterPkceError).kind).toBe("denied");
    }
  });
});
