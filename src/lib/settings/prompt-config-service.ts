import { prisma } from "@/lib/db";
import {
  coerceNullableNumber,
  ensureRuntimeConfigSeeded,
  resolveTemplateJsonForSave,
  type SavePromptConfigInput,
  serializeAdminPromptConfig,
  validatePromptConfigInput,
} from "@/lib/settings/core";
import { normalizeText } from "@/lib/utils/text";

type DefaultModelConfigReader = Pick<typeof prisma, "modelApiConfig">;

async function getDefaultModelConfigSummary(reader: DefaultModelConfigReader = prisma) {
  return reader.modelApiConfig.findFirst({
    where: { isDefault: true, isEnabled: true },
    select: { id: true, name: true },
  });
}

export async function listPromptConfigs() {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: false });

  const [configs, defaultModelConfig] = await Promise.all([
    prisma.promptConfig.findMany({
      include: {
        modelApiConfig: {
          select: {
            name: true,
          },
        },
      },
      orderBy: [{ type: "asc" }, { isDefault: "desc" }, { createdAt: "desc" }],
    }),
    getDefaultModelConfigSummary(),
  ]);

  return configs.map((config) => serializeAdminPromptConfig(config, defaultModelConfig));
}

export async function getPromptConfig(id: string) {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: false });

  const [config, defaultModelConfig] = await Promise.all([
    prisma.promptConfig.findUnique({
      where: { id },
      include: {
        modelApiConfig: {
          select: {
            name: true,
          },
        },
      },
    }),
    getDefaultModelConfigSummary(),
  ]);

  if (!config) {
    throw new Error("提示词配置不存在。");
  }

  return serializeAdminPromptConfig(config, defaultModelConfig);
}

export async function createPromptConfig(input: SavePromptConfigInput) {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: false });
  await validatePromptConfigInput(input);
  const templateSave = resolveTemplateJsonForSave(input);

  return prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.promptConfig.updateMany({
        where: {
          type: input.type,
          isDefault: true,
        },
        data: {
          isDefault: false,
        },
      });
    }

    const config = await tx.promptConfig.create({
      data: {
        name: normalizeText(input.name),
        type: input.type,
        prompt: input.prompt.trim(),
        systemPrompt: templateSave?.systemPrompt ?? (input.systemPrompt?.trim() || null),
        templateJson: templateSave?.templateJson ?? null,
        temperature: coerceNullableNumber(input.temperature),
        maxTokens: coerceNullableNumber(input.maxTokens),
        topP: coerceNullableNumber(input.topP),
        modelApiConfigId: input.modelApiConfigId || null,
        isEnabled: input.isEnabled,
        isDefault: input.isDefault,
      },
      include: {
        modelApiConfig: {
          select: {
            name: true,
          },
        },
      },
    });

    return serializeAdminPromptConfig(config, await getDefaultModelConfigSummary(tx));
  });
}

export async function updatePromptConfig(id: string, input: SavePromptConfigInput) {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: false });

  const current = await prisma.promptConfig.findUnique({
    where: { id },
  });

  if (!current) {
    throw new Error("提示词配置不存在。");
  }

  await validatePromptConfigInput(input, id);
  const templateSave = resolveTemplateJsonForSave(input);

  return prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.promptConfig.updateMany({
        where: {
          id: { not: id },
          type: input.type,
          isDefault: true,
        },
        data: {
          isDefault: false,
        },
      });
    }

    const config = await tx.promptConfig.update({
      where: { id },
      data: {
        name: normalizeText(input.name),
        type: input.type,
        prompt: input.prompt.trim(),
        systemPrompt: templateSave?.systemPrompt ?? (input.systemPrompt?.trim() || null),
        templateJson: templateSave?.templateJson ?? null,
        temperature: coerceNullableNumber(input.temperature),
        maxTokens: coerceNullableNumber(input.maxTokens),
        topP: coerceNullableNumber(input.topP),
        modelApiConfigId: input.modelApiConfigId || null,
        isEnabled: input.isEnabled,
        isDefault: input.isDefault,
      },
      include: {
        modelApiConfig: {
          select: {
            name: true,
          },
        },
      },
    });

    return serializeAdminPromptConfig(config, await getDefaultModelConfigSummary(tx));
  });
}

export async function deletePromptConfig(id: string) {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: false });

  const config = await prisma.promptConfig.findUnique({
    where: { id },
  });

  if (!config) {
    throw new Error("提示词配置不存在。");
  }

  if (config.isDefault) {
    throw new Error("默认提示词配置不能删除。");
  }

  await prisma.promptConfig.delete({
    where: { id },
  });
}
