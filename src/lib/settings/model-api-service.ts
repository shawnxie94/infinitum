import { prisma } from "@/lib/db";
import { normalizeModelResponseText } from "@/lib/ai/response-format";
import {
  ensureRuntimeConfigSeeded,
  type FetchModelApiModelsInput,
  normalizeCustomHeaders,
  parseCustomHeaders,
  type SaveModelApiConfigInput,
  serializeAdminModelApiConfig,
  validateModelApiInput,
} from "@/lib/settings/core";
import { normalizeText } from "@/lib/utils/text";

export async function listModelApiConfigs() {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: false });

  const configs = await prisma.modelApiConfig.findMany({
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });

  return configs.map(serializeAdminModelApiConfig);
}

export async function getModelApiConfig(id: string) {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: false });

  const config = await prisma.modelApiConfig.findUnique({
    where: { id },
  });

  if (!config) {
    throw new Error("模型配置不存在。");
  }

  return {
    ...serializeAdminModelApiConfig(config),
    apiKeyRaw: config.apiKey,
  };
}

export async function createModelApiConfig(input: SaveModelApiConfigInput) {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: false });
  validateModelApiInput(input);

  return prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.modelApiConfig.updateMany({
        where: {
          isDefault: true,
        },
        data: {
          isDefault: false,
        },
      });
    }

    const config = await tx.modelApiConfig.create({
      data: {
        name: normalizeText(input.name),
        baseUrl: normalizeText(input.baseUrl),
        apiKey: input.apiKey.trim(),
        modelName: normalizeText(input.modelName),
        ingestionItemConcurrency: input.ingestionItemConcurrency,
        customHeaders: JSON.stringify(normalizeCustomHeaders(input.customHeaders)),
        isEnabled: input.isEnabled,
        isDefault: input.isDefault,
      },
    });

    return serializeAdminModelApiConfig(config);
  });
}

export async function updateModelApiConfig(id: string, input: SaveModelApiConfigInput) {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: false });

  const current = await prisma.modelApiConfig.findUnique({
    where: { id },
  });

  if (!current) {
    throw new Error("模型配置不存在。");
  }

  validateModelApiInput(input, {
    isUpdate: true,
    currentHasApiKey: Boolean(current.apiKey),
  });

  const nextApiKey =
    input.apiKeyMode === "clear"
      ? ""
      : input.apiKeyMode === "keep"
        ? current.apiKey
        : input.apiKey.trim();

  return prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.modelApiConfig.updateMany({
        where: {
          id: { not: id },
          isDefault: true,
        },
        data: {
          isDefault: false,
        },
      });
    }

    const config = await tx.modelApiConfig.update({
      where: { id },
      data: {
        name: normalizeText(input.name),
        baseUrl: normalizeText(input.baseUrl),
        apiKey: nextApiKey,
        modelName: normalizeText(input.modelName),
        ingestionItemConcurrency: input.ingestionItemConcurrency,
        customHeaders: JSON.stringify(normalizeCustomHeaders(input.customHeaders)),
        isEnabled: input.isEnabled,
        isDefault: input.isDefault,
      },
    });

    return serializeAdminModelApiConfig(config);
  });
}

export async function deleteModelApiConfig(id: string) {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: false });

  const config = await prisma.modelApiConfig.findUnique({
    where: { id },
  });

  if (!config) {
    throw new Error("模型配置不存在。");
  }

  if (config.isDefault) {
    throw new Error("默认模型配置不能删除。");
  }

  await prisma.modelApiConfig.delete({
    where: { id },
  });
}

export async function fetchModelApiModels(input: FetchModelApiModelsInput) {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: false });

  const baseUrl = normalizeText(input.baseUrl);
  let apiKey = normalizeText(input.apiKey);

  if (!apiKey && input.configId && input.apiKeyMode !== "clear") {
    const existingConfig = await prisma.modelApiConfig.findUnique({
      where: { id: input.configId },
    });
    apiKey = existingConfig?.apiKey ?? "";
  }

  if (!baseUrl || !apiKey) {
    throw new Error("请先填写 API 地址与密钥。");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  if (input.configId) {
    const existingConfig = await prisma.modelApiConfig.findUnique({
      where: { id: input.configId },
    });
    Object.assign(headers, parseCustomHeaders(existingConfig?.customHeaders));
  }
  Object.assign(headers, normalizeCustomHeaders(input.customHeaders));

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    method: "GET",
    headers,
  });

  const rawResponse = await response.text();

  if (!response.ok) {
    return {
      success: false,
      message: `获取模型失败: ${response.status}`,
      models: [] as string[],
      rawResponse,
    };
  }

  let payload: { data?: Array<{ id?: string | null }> } | null = null;

  try {
    payload = JSON.parse(rawResponse) as { data?: Array<{ id?: string | null }> };
  } catch {
    return {
      success: false,
      message: "模型列表响应不是合法 JSON。",
      models: [] as string[],
      rawResponse,
    };
  }

  const models = (payload.data ?? [])
    .map((item) => normalizeText(item.id))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

  return {
    success: true,
    models,
    rawResponse,
  };
}

export async function testModelApiConfig(
  id: string,
  payload?: {
    prompt?: string;
    maxTokens?: number;
  },
) {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: false });

  const config = await prisma.modelApiConfig.findUnique({
    where: { id },
  });

  if (!config) {
    throw new Error("模型配置不存在。");
  }

  const prompt = normalizeText(payload?.prompt) || "请回复：OK";
  const maxTokens = payload?.maxTokens && payload.maxTokens > 0 ? payload.maxTokens : 200;

  if (!config.apiKey) {
    return {
      success: false,
      message: "当前模型配置没有 API Key。",
      content: "",
      rawResponse: "",
      statusCode: 400,
    };
  }

  const customHeaders = parseCustomHeaders(config.customHeaders);

  const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...customHeaders,
    },
    body: JSON.stringify({
      model: config.modelName,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.2,
    }),
  });

  try {
    const rawResponse = await response.text();

    if (!response.ok) {
      return {
        success: false,
        message: `调用失败: ${response.status}`,
        content: rawResponse,
        rawResponse,
        statusCode: response.status,
      };
    }

    let content = rawResponse;

    try {
      const data = JSON.parse(rawResponse) as {
        choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
      };
      const message = data.choices?.[0]?.message;
      content = normalizeModelResponseText(message?.content || message?.reasoning_content);
    } catch {
      // 保留原始文本作为回退。
    }

    return {
      success: true,
      message: "调用成功",
      content,
      rawResponse,
      statusCode: response.status,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "调用失败",
      content: "",
      rawResponse: "",
      statusCode: 500,
    };
  }
}
