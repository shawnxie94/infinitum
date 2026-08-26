export type ModelApiProviderId = "custom" | "orcarouter";

export type ModelApiProviderPreset = {
  id: ModelApiProviderId;
  label: string;
  name: string;
  baseUrl: string;
  modelName: string;
  apiKeyEnv: string | null;
  customHeaders: Record<string, string>;
};

export const MODEL_API_PROVIDER_PRESETS: readonly ModelApiProviderPreset[] = [
  {
    id: "custom",
    label: "自定义（OpenAI 兼容）",
    name: "",
    baseUrl: "https://api.openai.com/v1",
    modelName: "gpt-4.1-mini",
    apiKeyEnv: null,
    customHeaders: {},
  },
  {
    id: "orcarouter",
    label: "OrcaRouter",
    name: "OrcaRouter",
    baseUrl: "https://api.orcarouter.ai/v1",
    modelName: "orcarouter/auto",
    apiKeyEnv: "ORCAROUTER_API_KEY",
    customHeaders: {},
  },
];

export function getModelApiProviderPreset(providerId: ModelApiProviderId) {
  return MODEL_API_PROVIDER_PRESETS.find((preset) => preset.id === providerId) ?? MODEL_API_PROVIDER_PRESETS[0];
}

export function inferModelApiProvider(baseUrl: string): ModelApiProviderId {
  return baseUrl.trim().replace(/\/+$/, "") === "https://api.orcarouter.ai/v1" ? "orcarouter" : "custom";
}
