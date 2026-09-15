import type {
  AdminModelApiConfig,
  AdminModelApiConfigDetail,
  AdminPromptConfig,
  OrcaRouterConnectSessionView,
  OrcaRouterModelOption,
  PromptConfigType,
} from "@/lib/settings/types";

export type ModelApiConfigPayload = {
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeyMode: "replace" | "clear" | "keep";
  modelName: string;
  ingestionItemConcurrency: number;
  customHeaders: Record<string, string>;
  isEnabled: boolean;
  isDefault: boolean;
};

export type PromptConfigPayload = {
  name: string;
  type: PromptConfigType;
  prompt?: string;
  userPrompt: string | null;
  systemPrompt?: string | null;
  templateJson: string | null;
  temperature: number | null;
  maxTokens: number | null;
  topP: number | null;
  modelApiConfigId: string | null;
  isEnabled: boolean;
  isDefault: boolean;
};

async function requestAiSettingsJson<T>(
  url: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers:
      method === "GET"
        ? undefined
        : {
            "content-type": "application/json",
          },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? "请求失败");
  }

  return payload;
}

export function getModelApiConfig(configId: string) {
  return requestAiSettingsJson<AdminModelApiConfigDetail>(
    `/api/admin/settings/model-api-configs/${configId}`,
    "GET",
  );
}

export function fetchModelApiConfigModels(input: {
  baseUrl: string;
  apiKey: string;
  configId?: string;
  apiKeyMode: "replace" | "clear" | "keep";
  customHeaders: Record<string, string>;
}) {
  return requestAiSettingsJson<{
    success: boolean;
    models: string[];
    message?: string;
  }>("/api/admin/settings/model-api-configs/models", "POST", input);
}

export function createModelApiConfig(input: ModelApiConfigPayload) {
  return requestAiSettingsJson<{ config: AdminModelApiConfig }>(
    "/api/admin/settings/model-api-configs",
    "POST",
    input,
  );
}

export type OrcaRouterCatalogResponse = {
  success: boolean;
  source: "live" | "seed";
  degraded: boolean;
  error: string | null;
  capability: string;
  credentialSource: "api-key" | "pkce" | null;
  models: OrcaRouterModelOption[];
};

/**
 * Live OrcaRouter catalog. The server holds the API key; the browser only
 * receives minimal model metadata.
 */
export function fetchOrcaRouterModels(input: {
  configId: string;
  capability: "chat" | "embedding" | "image" | "video" | "rerank";
  requiredInputModalities?: string[];
}) {
  return requestAiSettingsJson<OrcaRouterCatalogResponse>(
    "/api/admin/settings/orcarouter/models",
    "POST",
    input,
  );
}

export function startOrcaRouterConnect(input: {
  configId: string;
  callbackMode?: "loopback" | "out-of-band";
  callbackUrl?: string;
}) {
  return requestAiSettingsJson<{ success: boolean; session: OrcaRouterConnectSessionView }>(
    "/api/admin/settings/orcarouter/connect",
    "POST",
    input,
  );
}

export function completeOrcaRouterConnect(input: {
  configId: string;
  generation: number;
  code: string;
}) {
  return requestAiSettingsJson<{
    success: boolean;
    session: OrcaRouterConnectSessionView;
    error: string | null;
  }>("/api/admin/settings/orcarouter/connect", "PUT", input);
}

export function cancelOrcaRouterConnect(configId: string) {
  return requestAiSettingsJson<{ success: boolean; session: OrcaRouterConnectSessionView }>(
    "/api/admin/settings/orcarouter/connect",
    "DELETE",
    { configId },
  );
}

export function updateModelApiConfig(configId: string, input: ModelApiConfigPayload) {
  return requestAiSettingsJson<{ config: AdminModelApiConfig }>(
    `/api/admin/settings/model-api-configs/${configId}`,
    "PUT",
    input,
  );
}

export function deleteModelApiConfig(configId: string) {
  return requestAiSettingsJson(`/api/admin/settings/model-api-configs/${configId}`, "DELETE");
}

export function testModelApiConfig(configId: string, prompt: string) {
  return requestAiSettingsJson<{
    success: boolean;
    message: string;
    content: string;
    rawResponse: string;
  }>(`/api/admin/settings/model-api-configs/${configId}/test`, "POST", { prompt });
}

export function createPromptConfig(input: PromptConfigPayload) {
  return requestAiSettingsJson<{ config: AdminPromptConfig }>(
    "/api/admin/settings/prompt-configs",
    "POST",
    input,
  );
}

export function updatePromptConfig(configId: string, input: PromptConfigPayload) {
  return requestAiSettingsJson<{ config: AdminPromptConfig }>(
    `/api/admin/settings/prompt-configs/${configId}`,
    "PUT",
    input,
  );
}

export function deletePromptConfig(configId: string) {
  return requestAiSettingsJson(`/api/admin/settings/prompt-configs/${configId}`, "DELETE");
}
