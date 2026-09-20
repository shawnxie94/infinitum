/**
 * OrcaRouter model catalog: live discovery, capability filtering, and the
 * verified cold-start seed.
 *
 * The only source of truth for what a workspace can actually call is
 * `GET <apiBase>/models` on the configured inference origin. The seed below is
 * a small, explicitly-labelled outage fallback — never mixed into a successful
 * live result.
 *
 * Capability filtering is fail-closed: a record that does not declare the
 * capability an entry point needs is not offered there.
 */

import { buildModelsEndpoint } from "./origins";

export type OrcaRouterCapability = "chat" | "embedding" | "image" | "video" | "rerank";

export type OrcaRouterModelEntry = {
  id: string;
  name: string | null;
  contextLength: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportedEndpointTypes: string[];
  maxCompletionTokens: number | null;
  /** Only ever true for hand-verified seed entries; never inferred from a name. */
  reasoning: boolean;
  reasoningEfforts: string[];
  source: "live" | "seed";
};

export type OrcaRouterCatalogResult = {
  models: OrcaRouterModelEntry[];
  /** `live` is authoritative; `seed` means discovery failed and this is the verified fallback. */
  source: "live" | "seed";
  degraded: boolean;
  error: string | null;
  capability: OrcaRouterCapability;
};

/** Endpoint types a text chat/agent entry point can actually speak. */
const TEXT_ENDPOINT_TYPES = ["openai", "anthropic", "gemini", "openai-response"] as const;

/** Models dedicated to a non-text capability must never appear in a text list. */
const NON_TEXT_ENDPOINT_TYPES = ["image-generation", "openai-video", "jina-rerank", "embeddings"];

export const MAX_CATALOG_ITEMS = 2000;
export const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Verified outage fallback. Capabilities here were confirmed against the live
 * catalog on 2026-09-11; `openai/gpt-5.5` carries the verified reasoning-effort
 * ladder. Live discovery always replaces this when it succeeds.
 */
export const ORCAROUTER_SEED_MODELS: readonly OrcaRouterModelEntry[] = [
  {
    id: "openai/gpt-5.5",
    name: "OpenAI: GPT-5.5",
    contextLength: 1_000_000,
    inputModalities: ["text", "image", "file"],
    outputModalities: ["text"],
    supportedEndpointTypes: ["openai", "openai-response"],
    maxCompletionTokens: 128_000,
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    source: "seed",
  },
  {
    id: "anthropic/claude-opus-4.8",
    name: "Anthropic: Claude Opus 4.8",
    contextLength: 200_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportedEndpointTypes: ["anthropic", "openai"],
    maxCompletionTokens: 64_000,
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    source: "seed",
  },
  {
    id: "google/gemini-3.5-flash",
    name: "Google: Gemini 3.5 Flash",
    contextLength: 1_000_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportedEndpointTypes: ["gemini", "openai"],
    maxCompletionTokens: 65_536,
    reasoning: false,
    reasoningEfforts: [],
    source: "seed",
  },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek: V4 Pro",
    contextLength: 128_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedEndpointTypes: ["openai"],
    maxCompletionTokens: 32_768,
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    source: "seed",
  },
  {
    id: "orcarouter/auto",
    name: "OrcaRouter: Auto",
    contextLength: null,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedEndpointTypes: ["openai", "anthropic", "gemini", "openai-response"],
    maxCompletionTokens: null,
    reasoning: false,
    reasoningEfforts: [],
    source: "seed",
  },
];

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** One record, bounded and shape-checked. Returns null for anything unusable. */
export function parseCatalogModel(raw: unknown): OrcaRouterModelEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const id = asString(record.id);
  if (!id) {
    return null;
  }

  const architecture = (record.architecture ?? {}) as Record<string, unknown>;

  return {
    id,
    name: asString(record.name),
    contextLength: asNumber(record.context_length),
    inputModalities: asStringArray(architecture.input_modalities),
    outputModalities: asStringArray(architecture.output_modalities),
    supportedEndpointTypes: asStringArray(record.supported_endpoint_types),
    maxCompletionTokens: asNumber(record.max_completion_tokens),
    reasoning: false,
    reasoningEfforts: [],
    source: "live",
  };
}

export function parseOrcaRouterCatalog(payload: unknown): OrcaRouterModelEntry[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    return [];
  }

  const models: OrcaRouterModelEntry[] = [];
  for (const item of data.slice(0, MAX_CATALOG_ITEMS)) {
    const model = parseCatalogModel(item);
    if (model) {
      models.push(model);
    }
  }
  return models;
}

/**
 * Capability filter. `requiredInputModalities` is the fail-closed gate for
 * multimodal entry points: a model that does not *declare* the modality an
 * entry point actually uploads is excluded.
 */
export function filterModelsForCapability(
  models: readonly OrcaRouterModelEntry[],
  capability: OrcaRouterCapability,
  options: { requiredInputModalities?: string[] } = {},
): OrcaRouterModelEntry[] {
  const required = (options.requiredInputModalities ?? []).map((item) => item.toLowerCase());

  return models.filter((model) => {
    const endpointTypes = model.supportedEndpointTypes.map((item) => item.toLowerCase());

    if (capability === "chat") {
      // Must be able to speak a text chat wire format...
      if (!endpointTypes.some((type) => (TEXT_ENDPOINT_TYPES as readonly string[]).includes(type))) {
        return false;
      }
      // ...and must not be a non-text-only model that leaked into the list.
      if (
        endpointTypes.length > 0
        && endpointTypes.every((type) => NON_TEXT_ENDPOINT_TYPES.includes(type))
      ) {
        return false;
      }
    } else if (capability === "embedding") {
      if (!endpointTypes.includes("embeddings")) {
        return false;
      }
    } else if (capability === "image") {
      if (!endpointTypes.includes("image-generation")) {
        return false;
      }
    } else if (capability === "video") {
      if (!endpointTypes.includes("openai-video")) {
        return false;
      }
    } else if (capability === "rerank") {
      if (!endpointTypes.includes("jina-rerank")) {
        return false;
      }
    }

    if (required.length > 0) {
      const declared = model.inputModalities.map((item) => item.toLowerCase());
      if (!required.every((modality) => declared.includes(modality))) {
        return false;
      }
    }

    return true;
  });
}

/** Keeps a verified seed entry's metadata when it survives a live refresh. */
function mergeSeedMetadata(
  live: OrcaRouterModelEntry[],
  seed: readonly OrcaRouterModelEntry[],
): OrcaRouterModelEntry[] {
  const seedById = new Map(seed.map((entry) => [entry.id, entry]));

  return live.map((model) => {
    const known = seedById.get(model.id);
    if (!known) {
      return model;
    }

    return {
      ...model,
      // Live context/modality metadata wins; reasoning metadata has no live
      // source, so the verified ladder is preserved rather than erased.
      contextLength: model.contextLength ?? known.contextLength,
      maxCompletionTokens: model.maxCompletionTokens ?? known.maxCompletionTokens,
      inputModalities: model.inputModalities.length > 0 ? model.inputModalities : known.inputModalities,
      reasoning: known.reasoning,
      reasoningEfforts: known.reasoningEfforts,
    };
  });
}

export type DiscoverOrcaRouterModelsInput = {
  apiBase: string;
  apiKey: string;
  capability: OrcaRouterCapability;
  requiredInputModalities?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  seed?: readonly OrcaRouterModelEntry[];
};

/**
 * Live discovery against `<apiBase>/models?capability=…`. On any failure the
 * verified seed is returned with `degraded: true` — never a free-text field,
 * and never a seed mixed into a successful live result.
 */
export async function discoverOrcaRouterModels(
  input: DiscoverOrcaRouterModelsInput,
): Promise<OrcaRouterCatalogResult> {
  const seed = input.seed ?? ORCAROUTER_SEED_MODELS;
  const seedForCapability = filterModelsForCapability(seed, input.capability, {
    requiredInputModalities: input.requiredInputModalities,
  });

  const fallback = (error: string): OrcaRouterCatalogResult => ({
    models: seedForCapability,
    source: "seed",
    degraded: true,
    error,
    capability: input.capability,
  });

  if (!input.apiKey.trim()) {
    return fallback("缺少 OrcaRouter 凭据。");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
  );

  try {
    const response = await fetchImpl(
      buildModelsEndpoint(input.apiBase, input.capability),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${input.apiKey.trim()}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      return fallback(`模型目录请求失败（${response.status}）。`);
    }

    const raw = await response.text();
    if (raw.length > MAX_CATALOG_BYTES) {
      return fallback("模型目录响应超出大小上限。");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return fallback("模型目录响应不是合法 JSON。");
    }

    const models = filterModelsForCapability(
      mergeSeedMetadata(parseOrcaRouterCatalog(payload), seed),
      input.capability,
      { requiredInputModalities: input.requiredInputModalities },
    );

    if (models.length === 0) {
      return fallback("模型目录为空或没有兼容该能力的模型。");
    }

    return {
      models: models.sort((left, right) => left.id.localeCompare(right.id)),
      source: "live",
      degraded: false,
      error: null,
      capability: input.capability,
    };
  } catch (error) {
    // A network failure or timeout must never surface the API key.
    return fallback(
      error instanceof Error && error.name === "AbortError"
        ? "模型目录请求超时。"
        : "模型目录网络请求失败。",
    );
  } finally {
    clearTimeout(timer);
  }
}
