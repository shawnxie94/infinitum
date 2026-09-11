import { describe, expect, it, vi } from "vitest";

import {
  ORCAROUTER_SEED_MODELS,
  discoverOrcaRouterModels,
  filterModelsForCapability,
  parseCatalogModel,
  parseOrcaRouterCatalog,
  type OrcaRouterModelEntry,
} from "@/lib/ai/orcarouter/catalog";
import {
  apiKeyCredentialAdapter,
  pkceCredentialAdapter,
} from "@/lib/ai/orcarouter/credentials";

const FAKE_KEY = "sk-orca-catalogtest00000000000000000000000";

/** Fixtures covering every capability the entry points can ask for. */
function fixtureModels(): OrcaRouterModelEntry[] {
  return parseOrcaRouterCatalog({
    data: [
      {
        id: "vendor/text-only",
        supported_endpoint_types: ["openai"],
        context_length: 128000,
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      },
      {
        id: "vendor/vision-chat",
        supported_endpoint_types: ["openai", "anthropic"],
        context_length: 200000,
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      },
      {
        id: "vendor/audio-chat",
        supported_endpoint_types: ["openai"],
        architecture: { input_modalities: ["text", "audio"], output_modalities: ["text"] },
      },
      {
        id: "vendor/embed",
        supported_endpoint_types: ["embeddings"],
        architecture: { input_modalities: ["text"], output_modalities: ["embedding"] },
      },
      {
        id: "vendor/image-gen",
        supported_endpoint_types: ["image-generation"],
        architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      },
      {
        id: "vendor/video-gen",
        supported_endpoint_types: ["openai-video"],
        architecture: { input_modalities: ["text"], output_modalities: ["video"] },
      },
      {
        id: "vendor/rerank",
        supported_endpoint_types: ["jina-rerank"],
        architecture: { input_modalities: ["text"], output_modalities: ["score"] },
      },
      {
        id: "vendor/no-architecture",
        supported_endpoint_types: ["openai"],
      },
    ],
  });
}

describe("catalog parsing is bounded and shape-checked", () => {
  it("keeps the vendor/model namespace verbatim", () => {
    const models = fixtureModels();
    expect(models.map((model) => model.id)).toContain("vendor/vision-chat");
    expect(models.every((model) => model.id.includes("/"))).toBe(true);
  });

  it("rejects records without a usable id", () => {
    expect(parseCatalogModel({ name: "no id" })).toBeNull();
    expect(parseCatalogModel(null)).toBeNull();
    expect(parseCatalogModel("vendor/text-only")).toBeNull();
    expect(parseCatalogModel({ id: "   " })).toBeNull();
  });

  it("tolerates a missing architecture block instead of throwing", () => {
    const parsed = parseCatalogModel({ id: "vendor/x", supported_endpoint_types: ["openai"] });
    expect(parsed).not.toBeNull();
    expect(parsed!.inputModalities).toEqual([]);
  });

  it("returns an empty list for a malformed payload", () => {
    expect(parseOrcaRouterCatalog({})).toEqual([]);
    expect(parseOrcaRouterCatalog({ data: "nope" })).toEqual([]);
  });
});

describe("capability filtering", () => {
  const models = fixtureModels();

  it("offers only text-capable chat models to a text entry point", () => {
    const chat = filterModelsForCapability(models, "chat");
    const ids = chat.map((model) => model.id);

    expect(ids).toContain("vendor/text-only");
    expect(ids).toContain("vendor/vision-chat");
    // Non-text dedicated models must never appear in a chat list.
    expect(ids).not.toContain("vendor/embed");
    expect(ids).not.toContain("vendor/image-gen");
    expect(ids).not.toContain("vendor/video-gen");
    expect(ids).not.toContain("vendor/rerank");
  });

  it("fails closed on multimodal: a text-only model is excluded once image input is required", () => {
    const multimodal = filterModelsForCapability(models, "chat", {
      requiredInputModalities: ["image"],
    });
    const ids = multimodal.map((model) => model.id);

    expect(ids).toContain("vendor/vision-chat");
    // Declares text but not image — must not be offered.
    expect(ids).not.toContain("vendor/text-only");
    // Missing architecture entirely — fail closed, not "assume it works".
    expect(ids).not.toContain("vendor/no-architecture");
  });

  it("excludes an audio-only model when image input is required", () => {
    const ids = filterModelsForCapability(models, "chat", {
      requiredInputModalities: ["image"],
    }).map((model) => model.id);

    expect(ids).not.toContain("vendor/audio-chat");
  });

  it("routes each dedicated capability to its own endpoint type", () => {
    expect(filterModelsForCapability(models, "embedding").map((m) => m.id)).toEqual(["vendor/embed"]);
    expect(filterModelsForCapability(models, "image").map((m) => m.id)).toEqual(["vendor/image-gen"]);
    expect(filterModelsForCapability(models, "video").map((m) => m.id)).toEqual(["vendor/video-gen"]);
    expect(filterModelsForCapability(models, "rerank").map((m) => m.id)).toEqual(["vendor/rerank"]);
  });

  it("never mixes an embedding or image model into a chat list by name guessing", () => {
    const onlyNonText = parseOrcaRouterCatalog({
      data: [
        { id: "vendor/chat-like-embedding", supported_endpoint_types: ["embeddings"] },
        { id: "vendor/gpt-image-9", supported_endpoint_types: ["image-generation"] },
      ],
    });

    expect(filterModelsForCapability(onlyNonText, "chat")).toEqual([]);
  });
});

describe("discovery is independent of which authentication choice produced the key", () => {
  it("returns the same catalog for an API-key credential and a PKCE credential", async () => {
    const apiKeyCredential = apiKeyCredentialAdapter.read({
      stored: {
        authMethod: "api-key",
        apiKey: "sk-orca-apikey00000000000000000000000000",
        accountId: "",
        scope: "",
        needsReauth: false,
        credentialGeneration: 1,
      },
    })!;
    const pkceCredential = pkceCredentialAdapter.read({
      stored: {
        authMethod: "pkce",
        apiKey: "sk-orca-pkcekey000000000000000000000000000",
        accountId: "12345",
        scope: "api",
        needsReauth: false,
        credentialGeneration: 2,
      },
    })!;

    const payload = JSON.stringify({
      data: [
        {
          id: "vendor/live-chat",
          supported_endpoint_types: ["openai"],
          architecture: { input_modalities: ["text"] },
        },
      ],
    });

    // Discovery takes a credential, not a credential *source*: both choices
    // reach the same catalog through the same path.
    const responses: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      responses.push(String((init?.headers as Record<string, string>).Authorization));
      return new Response(payload, { status: 200 });
    }) as unknown as typeof fetch;

    const viaApiKey = await discoverOrcaRouterModels({
      apiBase: "https://api.orcarouter.ai/v1",
      apiKey: apiKeyCredential.apiKey,
      capability: "chat",
      fetchImpl,
    });
    const viaPkce = await discoverOrcaRouterModels({
      apiBase: "https://api.orcarouter.ai/v1",
      apiKey: pkceCredential.apiKey,
      capability: "chat",
      fetchImpl,
    });

    expect(viaApiKey.models).toEqual(viaPkce.models);
    expect(viaApiKey.source).toBe(viaPkce.source);
    expect(viaApiKey.degraded).toBe(viaPkce.degraded);
    // Only the bearer value differs — the request shape is identical.
    expect(responses[0]).toBe(`Bearer ${apiKeyCredential.apiKey}`);
    expect(responses[1]).toBe(`Bearer ${pkceCredential.apiKey}`);
  });
});

describe("live discovery with a verified seed fallback", () => {
  it("uses the live catalog as authoritative when the request succeeds", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "vendor/live-chat",
              supported_endpoint_types: ["openai"],
              architecture: { input_modalities: ["text"] },
            },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await discoverOrcaRouterModels({
      apiBase: "https://api.orcarouter.ai/v1",
      apiKey: FAKE_KEY,
      capability: "chat",
      fetchImpl,
    });

    expect(result.source).toBe("live");
    expect(result.degraded).toBe(false);
    expect(result.models.map((model) => model.id)).toEqual(["vendor/live-chat"]);
    // A successful live result is authoritative: no seed entries are mixed in.
    expect(result.models.some((model) => model.id === "openai/gpt-5.5")).toBe(false);
  });

  it("requests the capability-scoped catalog URL with Bearer auth", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ) as unknown as typeof fetch;

    await discoverOrcaRouterModels({
      apiBase: "https://api.orcarouter.ai/v1",
      apiKey: FAKE_KEY,
      capability: "chat",
      fetchImpl,
    });

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("https://api.orcarouter.ai/v1/models?capability=chat");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("falls back to the verified seed, clearly marked degraded, when discovery fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

    const result = await discoverOrcaRouterModels({
      apiBase: "https://api.orcarouter.ai/v1",
      apiKey: FAKE_KEY,
      capability: "chat",
      fetchImpl,
    });

    expect(result.source).toBe("seed");
    expect(result.degraded).toBe(true);
    expect(result.error).toContain("503");
    expect(result.models.map((model) => model.id)).toEqual(
      ORCAROUTER_SEED_MODELS.map((model) => model.id),
    );
  });

  it("does not leak the API key into a degraded result", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED for Bearer ${FAKE_KEY}`);
    }) as unknown as typeof fetch;

    const result = await discoverOrcaRouterModels({
      apiBase: "https://api.orcarouter.ai/v1",
      apiKey: FAKE_KEY,
      capability: "chat",
      fetchImpl,
    });

    expect(result.degraded).toBe(true);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it("fails closed to the seed when there is no credential at all", async () => {
    const result = await discoverOrcaRouterModels({
      apiBase: "https://api.orcarouter.ai/v1",
      apiKey: "",
      capability: "chat",
    });

    expect(result.source).toBe("seed");
    expect(result.degraded).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("preserves the verified reasoning ladder and input modalities of a seed model", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "openai/gpt-5.5",
              supported_endpoint_types: ["openai", "openai-response"],
              context_length: 1_000_000,
              architecture: { input_modalities: ["file", "image", "text"] },
            },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await discoverOrcaRouterModels({
      apiBase: "https://api.orcarouter.ai/v1",
      apiKey: FAKE_KEY,
      capability: "chat",
      fetchImpl,
    });

    const gpt = result.models.find((model) => model.id === "openai/gpt-5.5")!;
    // Live discovery must not erase verified reasoning metadata.
    expect(gpt.reasoning).toBe(true);
    expect(gpt.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(gpt.inputModalities).toContain("image");
  });

  it("applies the multimodal filter to the seed fallback too", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 500 })) as unknown as typeof fetch;

    const textOnly = await discoverOrcaRouterModels({
      apiBase: "https://api.orcarouter.ai/v1",
      apiKey: FAKE_KEY,
      capability: "chat",
      fetchImpl,
    });
    const multimodal = await discoverOrcaRouterModels({
      apiBase: "https://api.orcarouter.ai/v1",
      apiKey: FAKE_KEY,
      capability: "chat",
      requiredInputModalities: ["image"],
      fetchImpl,
    });

    expect(textOnly.models.map((model) => model.id)).toContain("deepseek/deepseek-v4-pro");
    expect(multimodal.models.map((model) => model.id)).not.toContain("deepseek/deepseek-v4-pro");
    expect(multimodal.models.map((model) => model.id)).toContain("openai/gpt-5.5");
  });

  it("bounds the catalog request with a timeout", async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });

    const result = await discoverOrcaRouterModels({
      apiBase: "https://api.orcarouter.ai/v1",
      apiKey: FAKE_KEY,
      capability: "chat",
      fetchImpl: hangingFetch,
      timeoutMs: 10,
    });

    expect(result.degraded).toBe(true);
    expect(result.error).toContain("超时");
  });
});
