import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptConfigType } from "@prisma/client";
import { createCompatClientTransport } from "@infinitum/ai/provider/transports";

afterEach(() => vi.doUnmock("@/lib/db"));

describe("custom params runtime loading", () => {
  it("projects default model params into actual transport requests", async () => {
    const defaultRow = { type: "chat", name: "default", baseUrl: "https://default.test/v1", apiKey: "default-key", modelName: "default-model", customHeaders: "", customRequestParams: '{"reasoning_effort":"low"}', ingestionItemConcurrency: 3, dimensions: null, batchSize: null, timeoutMs: null, isEnabled: true, isDefault: true };
    const prisma = {
      source: { findMany: vi.fn(async () => []) },
      blacklistKeyword: { findMany: vi.fn(async () => []) },
      modelApiConfig: { findFirst: vi.fn(async ({ where }: { where: { type: string } }) => where.type === "chat" ? defaultRow : null) },
      promptConfig: { findMany: vi.fn(async () => Object.values(PromptConfigType).map(type => ({ type, name: "p", prompt: "", userPrompt: "", systemPrompt: null, templateJson: null, temperature: 0, maxTokens: 500, topP: null, isEnabled: true, isDefault: true, modelApiConfig: null }))) },
    };
    vi.doMock("@/lib/db", () => ({ prisma }));
    vi.doMock("@/lib/settings/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/settings/core")>()), ensureRuntimeConfigSeeded: vi.fn(async () => undefined) }));
    vi.doMock("@/lib/settings/content-extraction-service", () => ({ ensureContentExtractionConfig: async () => ({}), serializeRuntimeContentExtractionConfig: () => ({}) }));
    vi.doMock("@/lib/settings/event-briefing-service", () => ({ ensureEventBriefingConfig: async () => ({}), serializeAdminEventBriefingConfig: () => ({}) }));
    vi.doMock("@/lib/settings/header-link-service", () => ({ listAdminHeaderLinks: async () => [] }));
    vi.doMock("@/lib/settings/ai-requests-service", () => ({ getAiRequestsSettings: async () => ({}) }));
    vi.doMock("@/lib/tasks/service", () => ({ ensureDefaultIngestionSchedule: async () => ({ sourceConcurrency: 2, fullTextFetchThreshold: 80, perSourceItemLimit: 100, aggregationSplitMaxEvents: 20, processingStartAt: null }), ensureDefaultDailyReportSchedule: async () => ({}), ensureDefaultItemCleanupSchedule: async () => ({}), toTaskScheduleSnapshot: () => ({}) }));
    const { getIngestionRuntimeConfig } = await import("@/lib/settings/runtime-service");
    const config = await getIngestionRuntimeConfig();
    expect(config.modelApi.customRequestParams).toEqual({ reasoning_effort: "low" });
    const create = vi.fn(async (_wire: Record<string, unknown>) => { void _wire; return { choices: [{ message: { content: '{"ok":true}' } }] }; });
    const transport = createCompatClientTransport({ chat: { completions: { create } } }, { maxRetries: 0 });
    await transport({ messages: [{ role: "user", content: "x" }] }, config.modelApi);
    expect(create.mock.calls[0][0]).toMatchObject({ model: "default-model", reasoning_effort: "low" });
  });
});
