import { describe, expect, it } from "vitest";

import {
  OrcaRouterOriginError,
  buildAuthorizeEndpoint,
  buildKeyExchangeEndpoint,
  buildModelsEndpoint,
  resolveOrcaRouterOrigins,
} from "@/lib/ai/orcarouter/origins";

describe("OrcaRouter origins", () => {
  it("defaults to two distinct public origins", () => {
    const origins = resolveOrcaRouterOrigins({});

    expect(origins.authBase).toBe("https://www.orcarouter.ai");
    expect(origins.apiBase).toBe("https://api.orcarouter.ai/v1");
    expect(origins.authSource).toBe("public");
    expect(origins.apiSource).toBe("public");
  });

  it("keeps auth and inference on separate paths", () => {
    const origins = resolveOrcaRouterOrigins({});

    // `/auth` and `/api/v1/auth/keys` live on the auth origin...
    expect(buildAuthorizeEndpoint(origins.authBase)).toBe("https://www.orcarouter.ai/auth");
    expect(buildKeyExchangeEndpoint(origins.authBase)).toBe(
      "https://www.orcarouter.ai/api/v1/auth/keys",
    );
    // ...and the relay's `/v1` prefix never appears on the auth endpoint. The
    // common integration mistake is `api.orcarouter.ai/v1/auth/keys`, a 404.
    expect(buildKeyExchangeEndpoint(origins.authBase)).not.toContain("api.orcarouter.ai");
    expect(buildModelsEndpoint(origins.apiBase)).toBe("https://api.orcarouter.ai/v1/models");
  });

  it("appends the capability filter to the catalog endpoint", () => {
    expect(buildModelsEndpoint("https://api.orcarouter.ai/v1", "chat")).toBe(
      "https://api.orcarouter.ai/v1/models?capability=chat",
    );
  });

  it("prefers explicit overrides over the shared fallback", () => {
    const origins = resolveOrcaRouterOrigins({
      ORCA_BASE_URL: "https://shared.example.com",
      ORCA_AUTH_BASE_URL: "https://auth.example.com",
      ORCA_API_BASE_URL: "https://relay.example.com/v1",
    });

    expect(origins.authBase).toBe("https://auth.example.com");
    expect(origins.apiBase).toBe("https://relay.example.com/v1");
    expect(origins.authSource).toBe("override");
    expect(origins.apiSource).toBe("override");
  });

  it("supports one shared self-hosted origin for both roles", () => {
    const origins = resolveOrcaRouterOrigins({ ORCA_BASE_URL: "https://orca.internal" });

    expect(origins.authBase).toBe("https://orca.internal");
    expect(origins.apiBase).toBe("https://orca.internal/v1");
    expect(origins.authSource).toBe("shared");
    expect(origins.apiSource).toBe("shared");
  });

  it("does not double-append /v1 to a shared base that already has it", () => {
    const origins = resolveOrcaRouterOrigins({ ORCA_BASE_URL: "https://orca.internal/v1" });
    expect(origins.apiBase).toBe("https://orca.internal/v1");
  });

  it("requires HTTPS for remote origins and allows HTTP only on loopback", () => {
    expect(() => resolveOrcaRouterOrigins({ ORCA_AUTH_BASE_URL: "http://orca.example.com" })).toThrow(
      OrcaRouterOriginError,
    );

    const loopback = resolveOrcaRouterOrigins({ ORCA_AUTH_BASE_URL: "http://127.0.0.1:8787" });
    expect(loopback.authBase).toBe("http://127.0.0.1:8787");

    expect(resolveOrcaRouterOrigins({ ORCA_API_BASE_URL: "http://localhost:9000/v1" }).apiBase).toBe(
      "http://localhost:9000/v1",
    );
  });

  it("rejects a malformed origin instead of silently deriving one", () => {
    expect(() => resolveOrcaRouterOrigins({ ORCA_API_BASE_URL: "not a url" })).toThrow(
      OrcaRouterOriginError,
    );
  });
});
