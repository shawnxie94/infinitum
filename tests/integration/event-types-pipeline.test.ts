import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";
import { createAiProvider } from "@/lib/ai/provider-next";
import { buildEventFingerprint } from "@/lib/clusters/identity";
import { normalizeStoredEventType } from "@/lib/clusters/normalization";
import {
  createEventType,
  getEventTypeRegistrySnapshot,
  invalidateEventTypeRegistryCache,
  updateEventType,
} from "@/lib/event-types/registry";

type CapturedBody = {
  messages: Array<{ content: string }>;
};

function understandingOutput(eventType: unknown) {
  return JSON.stringify({
    summary: "这是一个足够长的示例摘要，覆盖主体、动作和关键结果，用于通过校验的完整输出。",
    translatedTitle: "",
    moderationStatus: "allowed",
    moderationReason: null,
    moderationDetail: null,
    qualityScore: 80,
    qualityBreakdown: [{ name: "事实密度", score: 80 }],
    qualityRationale: "事实充分",
    eventSignature: {
      eventType,
      eventSubject: "某公司",
      eventAction: "披露",
      eventObject: "经济数据",
      eventDate: null,
    },
    aggregation: { isAggregation: false, mainEvent: null, events: [] },
  });
}

async function resetRegistryAndData() {
  await prisma.contentCluster.deleteMany();
  await prisma.item.deleteMany();
  await prisma.source.deleteMany();
  await prisma.eventType.deleteMany();
  invalidateEventTypeRegistryCache();
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetRegistryAndData();
});

afterEach(async () => {
  await resetRegistryAndData();
  vi.restoreAllMocks();
});

describe("event types pipeline with captured provider request", () => {
  it("sends the configured registry enum in the actual request, resolves the model alias, and persists the key through item and cluster", async () => {
    const finance = await createEventType({ key: "economic_data", label: "经济数据", aliases: ["经济数据"] });
    const snapshot = await getEventTypeRegistrySnapshot();

    const bodies: CapturedBody[] = [];
    const create = vi.fn().mockImplementation(async (body: CapturedBody) => {
      bodies.push(body);
      return { choices: [{ message: { content: understandingOutput("经济数据") } }] };
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      null,
      { chat: { completions: { create } } },
      { eventTypeRegistry: snapshot, requestAudit: null },
    );

    const result = await provider.understandItem("正文内容", { title: "标题", translateTitle: false });

    // 实际请求包含配置的枚举与快照指纹，而非封闭默认之外的任意集合。
    const systemPrompt = bodies[0]!.messages[0]!.content;
    expect(systemPrompt).toContain("可用事件类型");
    expect(systemPrompt).toContain("economic_data");
    expect(systemPrompt).toContain(snapshot.fingerprint);
    // 别名规则随定义进入请求：模型可用别名输出，服务端归一为 key。
    expect(systemPrompt).toContain("别名：经济数据");

    // 模型返回别名 → 规范 key。
    expect(result.eventSignature.eventType).toBe("economic_data");

    // 条目与聚类持久化保留配置 key；历史读取不抹除。
    const source = await prisma.source.create({
      data: { name: "源", rssUrl: "https://et.example.com/feed.xml", siteUrl: "https://et.example.com", enabled: true },
    });
    const stored = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://et.example.com/a",
        canonicalUrl: "https://et.example.com/a",
        urlHash: "hash-et-1",
        originalTitle: "标题",
        publishedAt: new Date(),
        eventType: result.eventSignature.eventType,
        eventSubject: result.eventSignature.eventSubject,
      },
    });
    expect(stored.eventType).toBe("economic_data");

    const fingerprint = buildEventFingerprint(result.eventSignature)!;
    await prisma.contentCluster.create({
      data: {
        title: "聚类",
        summary: "聚类摘要",
        latestPublishedAt: new Date(),
        fingerprint: `fp:${fingerprint}`,
        eventFingerprint: fingerprint,
        eventBucket: "week:2026-01-05",
        eventType: result.eventSignature.eventType,
      },
    });
    const cluster = await prisma.contentCluster.findUnique({ where: { fingerprint: `fp:${fingerprint}` } });
    expect(cluster?.eventType).toBe("economic_data");
    expect(normalizeStoredEventType(cluster?.eventType)).toBe("economic_data");

    // 停用后：历史条目/聚类的配置 key 与展示 label 不受影响。
    await updateEventType(finance.id, { enabled: false });
    const reloaded = await prisma.item.findUnique({ where: { id: stored.id } });
    expect(reloaded?.eventType).toBe("economic_data");
    const disabledSnapshot = await getEventTypeRegistrySnapshot();
    const financeLabel = disabledSnapshot.types.find((type) => type.key === "economic_data");
    expect(financeLabel).toMatchObject({ label: "经济数据", enabled: false });
  });

  it("stores unknown model output as other with the raw value kept for diagnosis", async () => {
    await createEventType({ key: "economic_data", label: "经济数据" });
    const snapshot = await getEventTypeRegistrySnapshot();

    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: understandingOutput("funding_round") } }],
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      null,
      { chat: { completions: { create } } },
      { eventTypeRegistry: snapshot, requestAudit: null },
    );

    const result = await provider.understandItem("正文内容", { title: "标题", translateTitle: false });
    expect(result.eventSignature.eventType).toBe("other");
    expect(result.eventSignature.eventTypeRaw).toBe("funding_round");

    const source = await prisma.source.create({
      data: { name: "源", rssUrl: "https://et2.example.com/feed.xml", siteUrl: "https://et2.example.com", enabled: true },
    });
    const stored = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://et2.example.com/a",
        canonicalUrl: "https://et2.example.com/a",
        urlHash: "hash-et-2",
        originalTitle: "标题",
        publishedAt: new Date(),
        eventType: result.eventSignature.eventType,
        eventTypeRaw: result.eventSignature.eventTypeRaw ?? null,
      },
    });
    expect(stored.eventType).toBe("other");
    expect(stored.eventTypeRaw).toBe("funding_round");
  });

  it("changes the actual request prompt identity after a registry edit", async () => {
    const finance = await createEventType({ key: "economic_data", label: "经济数据" });
    const before = await getEventTypeRegistrySnapshot();

    const bodies: CapturedBody[] = [];
    const create = vi.fn().mockImplementation(async (body: CapturedBody) => {
      bodies.push(body);
      return { choices: [{ message: { content: understandingOutput("economic_data") } }] };
    });
    const buildProvider = (fingerprintSnapshot: Awaited<ReturnType<typeof getEventTypeRegistrySnapshot>>) =>
      createAiProvider(
        { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
        null,
        { chat: { completions: { create } } },
        { eventTypeRegistry: fingerprintSnapshot, requestAudit: null },
      );

    await buildProvider(before).understandItem("正文", { title: "标题", translateTitle: false });
    await updateEventType(finance.id, { description: "财经与经济事件" });
    invalidateEventTypeRegistryCache();
    const after = await getEventTypeRegistrySnapshot();

    await buildProvider(after).understandItem("正文", { title: "标题", translateTitle: false });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.messages[0]!.content).toContain(before.fingerprint);
    expect(bodies[1]!.messages[0]!.content).toContain(after.fingerprint);
    expect(before.fingerprint).not.toBe(after.fingerprint);
    expect(bodies[0]!.messages[0]!.content).not.toBe(bodies[1]!.messages[0]!.content);
  });
});
