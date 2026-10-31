// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown as import("@prisma/client").PrismaClient, items: vi.fn(), ensure: vi.fn() }));
vi.mock("@/lib/db", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/feed/cache", async (original) => ({ ...await original<typeof import("@/lib/feed/cache")>(), invalidateFeedCache: vi.fn() }));
vi.mock("@/lib/adapter/client", async (original) => ({ ...await original<typeof import("@/lib/adapter/client")>(), readAdapterConfig: vi.fn().mockResolvedValue({ baseUrl: "http://adapter", token: "test", instanceId: "local" }), AdapterClient: class { items = state.items; ensure = state.ensure; } }));
import { analysisFingerprint, guardedAdapterWrite, prepareAdapterItem, recordAdapterProcessing, recordItemAnalysisBaseline } from "@/lib/adapter/items";
import { reanalyzeItem } from "@/lib/items/service";
import { executeIngestionWorkflowStage } from "@/lib/ingestion/workflow-stages";
import { legacyAccountId, migrateAdapterSource, rollbackAdapterSource } from "@/lib/adapter/migration";
import { buildAiProviderMock } from "../helpers/ai-provider";
import { getDailyReportByDate } from "@/lib/daily-report/repository";
import { updateSource } from "@/lib/settings/source-service";
import { startIngestionTask } from "@/lib/ingestion/service";

let directory: string;
beforeAll(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "adapter-items-"));
  const dbPath = path.join(directory, "test.sqlite");
  execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], { cwd: process.cwd(), stdio: "pipe" });
  state.db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
  await state.db.source.create({ data: { id: "adapter-source", name: "Source", transport: "adapter", rssUrl: null, siteUrl: "" } });
});
afterAll(async () => { await state.db.$disconnect(); rmSync(directory, { recursive: true, force: true }); });

describe("adapter item identity", () => {
  const input = { sourceId: "adapter-source", instanceId: "local", providerId: "xueqiu", now: new Date("2026-10-31T00:00:00Z"), item: { externalId: "one", title: "First", url: "https://example.com/one", content: { text: "Body", status: "partial" as const } } };
  it("keeps one item, detects changes and preserves manually modified analysis", async () => {
    const first = await prepareAdapterItem(input);
    expect(first.isNew).toBe(true);
    const generated = await state.db.item.update({ where: { id: first.item.id }, data: { status: "processed", summaryStatus: "succeeded", analysisStatus: "succeeded", summaryText: "Generated" } });
    await recordAdapterProcessing(first.identityId, first.item.id, analysisFingerprint(generated));
    const same = await prepareAdapterItem(input);
    expect(same.shouldProcess).toBe(false);
    const changed = await prepareAdapterItem({ ...input, item: { ...input.item, content: { text: "New body", status: "full" } } });
    expect(changed.item.id).toBe(first.item.id);
    expect(changed.shouldProcess).toBe(true);
    const generatedAgain = await state.db.item.update({ where: { id: first.item.id }, data: { status: "processed", summaryStatus: "succeeded", analysisStatus: "succeeded", summaryText: "Generated again" } });
    await recordAdapterProcessing(first.identityId, first.item.id, analysisFingerprint(generatedAgain));
    await state.db.item.update({ where: { id: first.item.id }, data: { summaryText: "Human edit" } });
    const manual = await prepareAdapterItem({ ...input, item: { ...input.item, content: { text: "Third body", status: "full" } } });
    expect(manual.needsManualReview).toBe(true);
    expect(manual.shouldProcess).toBe(false);
    expect(manual.item.summaryText).toBe("Human edit");
    expect(await state.db.item.count()).toBe(1);
  });
  it("refuses a URL already owned by a different item", async () => {
    const other = await prepareAdapterItem({ ...input, item: { ...input.item, externalId: "two", url: "https://example.com/two" } });
    await expect(prepareAdapterItem({ ...input, item: { ...input.item, url: other.item.originalUrl } })).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
    expect((await state.db.item.findUniqueOrThrow({ where: { id: other.item.id } })).originalUrl).toBe("https://example.com/two");
  });
  it("links and completes an unprocessed shared URL while keeping the original source", async () => {
    await state.db.source.create({ data: { id: "rss-source", name: "RSS", rssUrl: "https://example.com/feed", siteUrl: "https://example.com" } });
    const rss = await state.db.item.create({ data: { sourceId: "rss-source", originalUrl: "https://example.com/shared", canonicalUrl: "https://example.com/shared", urlHash: (await import("@/lib/ingestion/dedupe")).buildDedupeKeys({ canonicalUrl: "https://example.com/shared" }).urlHash, originalTitle: "RSS title", publishedAt: input.now } });
    const result = await prepareAdapterItem({ ...input, item: { ...input.item, externalId: "shared", url: "https://example.com/shared", title: "Adapter title" } });
    expect(result.item.id).toBe(rss.id);
    expect(result.item.originalTitle).toBe("Adapter title");
    expect(result.item.sourceId).toBe("rss-source");
    expect(result.shouldProcess).toBe(true);
    expect(result.needsManualReview).toBe(false);
  });
  it("automatically completes a processed shared URL with an unchanged analysis baseline", async () => {
    const rss = await state.db.item.create({ data: { sourceId: "rss-source", originalUrl: "https://example.com/processed-shared", canonicalUrl: "https://example.com/processed-shared", urlHash: (await import("@/lib/ingestion/dedupe")).buildDedupeKeys({ canonicalUrl: "https://example.com/processed-shared" }).urlHash, originalTitle: "RSS", publishedAt: input.now, status: "processed", summaryStatus: "succeeded", analysisStatus: "succeeded", summaryText: "Generated" } });
    await recordItemAnalysisBaseline(rss.id, analysisFingerprint(rss));
    const updated = await prepareAdapterItem({ ...input, item: { ...input.item, externalId: "processed-shared", url: rss.originalUrl, content: { text: "More complete", status: "full" } } });
    expect(updated.item.id).toBe(rss.id);
    expect(updated.item.sourceId).toBe("rss-source");
    expect(updated.item.rssContent).toBe("More complete");
    expect(updated.shouldProcess).toBe(true);
    expect(updated.needsManualReview).toBe(false);
  });
  it("links identical cross-source content without repeating analysis", async () => {
    const url = "https://example.com/identical-shared";
    const rss = await state.db.item.create({ data: { sourceId: "rss-source", originalUrl: url, canonicalUrl: url, urlHash: (await import("@/lib/ingestion/dedupe")).buildDedupeKeys({ canonicalUrl: url }).urlHash, originalTitle: "First", rssContent: "Body", publishedAt: input.now, status: "processed", summaryStatus: "succeeded", analysisStatus: "succeeded", summaryText: "Generated" } });
    await recordItemAnalysisBaseline(rss.id, analysisFingerprint(rss));
    const result = await prepareAdapterItem({ ...input, item: { ...input.item, externalId: "identical-shared", url } });
    expect(result.item.id).toBe(rss.id);
    expect(result.shouldProcess).toBe(false);
    expect(result.needsManualReview).toBe(false);
  });
  it("clears review after explicit successful reanalysis and accepts the next update", async () => {
    const itemInput = { ...input, item: { ...input.item, externalId: "manual-review", url: "https://example.com/manual-review" } };
    const first = await prepareAdapterItem(itemInput);
    const generated = await state.db.item.update({ where: { id: first.item.id }, data: { status: "processed", summaryStatus: "succeeded", analysisStatus: "succeeded", summaryText: "Generated" } });
    await recordAdapterProcessing(first.identityId, first.item.id, analysisFingerprint(generated));
    await state.db.item.update({ where: { id: first.item.id }, data: { summaryText: "Human edit" } });
    const pending = await prepareAdapterItem({ ...itemInput, item: { ...itemInput.item, content: { text: "Updated", status: "full" } } });
    expect(pending.needsManualReview).toBe(true);
    const failingProvider = buildAiProviderMock();
    vi.mocked(failingProvider.understandItem).mockRejectedValueOnce(new Error("temporary failure"));
    await expect(reanalyzeItem(first.item.id, { aiProvider: failingProvider, confirmAdapterReview: true })).rejects.toThrow("temporary failure");
    expect((await state.db.adapterItemIdentity.findUniqueOrThrow({ where: { id: first.identityId } })).needsManualReview).toBe(true);
    const provider = buildAiProviderMock();
    const outcome = await reanalyzeItem(first.item.id, { aiProvider: provider, confirmAdapterReview: true });
    expect(outcome.failedFields).toEqual([]);
    expect(vi.mocked(provider.understandItem).mock.calls[0][0]).toContain("Updated");
    const identity = await state.db.adapterItemIdentity.findUniqueOrThrow({ where: { id: first.identityId } });
    expect(identity.needsManualReview).toBe(false);
    const next = await prepareAdapterItem({ ...itemInput, item: { ...itemInput.item, content: { text: "Another update", status: "full" } } });
    expect(next.shouldProcess).toBe(true);
    expect(next.needsManualReview).toBe(false);
  });
  it("does not bless a manual edit made after the processor write", async () => {
    const prepared = await prepareAdapterItem({ ...input, item: { ...input.item, externalId: "race", url: "https://example.com/race" } });
    const generated = await state.db.item.update({ where: { id: prepared.item.id }, data: { status: "processed", summaryStatus: "succeeded", analysisStatus: "succeeded", summaryText: "Generated" } });
    await state.db.item.update({ where: { id: prepared.item.id }, data: { summaryText: "Human edit" } });
    await recordAdapterProcessing(prepared.identityId, prepared.item.id, analysisFingerprint(generated));
    expect((await state.db.adapterItemIdentity.findUniqueOrThrow({ where: { id: prepared.identityId } })).needsManualReview).toBe(true);
  });
  it("rejects a model write when analysis was edited concurrently", async () => {
    const prepared = await prepareAdapterItem({ ...input, item: { ...input.item, externalId: "cas", url: "https://example.com/cas" } });
    await state.db.item.update({ where: { id: prepared.item.id }, data: { summaryText: "Human edit" } });
    await expect(guardedAdapterWrite(prepared.item, { sourceId: input.sourceId, originalUrl: input.item.url, canonicalUrl: input.item.url, urlHash: "not-used", originalTitle: "Overwrite", publishedAt: input.now, summaryText: "Model result" })).rejects.toMatchObject({ code: "MANUAL_CHANGED" });
    expect((await state.db.item.findUniqueOrThrow({ where: { id: prepared.item.id } })).summaryText).toBe("Human edit");
  });
  it("processes adapter content older than the RSS window and deduplicates repeated pulls", async () => {
    await state.db.source.update({ where: { id: "adapter-source" }, data: { enabled: true, aiParsingEnabled: true, aggregationEnabled: false } });
    await state.db.adapterSourceBinding.create({ data: { sourceId: "adapter-source", adapterInstanceId: "local", providerId: "xueqiu", accountId: "123", subscriptionId: "sub" } });
    await state.db.source.updateMany({ where: { id: { not: "adapter-source" } }, data: { enabled: false } });
    const upstream = { externalId: "old", title: "Old article updated", url: "https://example.com/old", publishedAt: "2020-01-01T00:00:00Z", content: { text: "Article body sufficiently useful for analysis.", status: "full" as const } };
    state.items.mockResolvedValue({ items: [upstream], latestFetchedAt: "2026-10-31T00:00:00Z", upstreamStatus: { state: "ok" } });
    const ai = buildAiProviderMock();
    const understand = vi.mocked(ai.understandItem);
    const options = { trigger: "manual" as const, sourceConfigs: [], blacklist: [], aiProvider: ai, parser: { parseURL: vi.fn() }, articleFetcher: vi.fn(), fullTextFetchThreshold: 0, processingStartAt: new Date("2026-10-01T00:00:00Z"), now: new Date("2026-10-31T00:00:00Z") };
    const run = async () => {
      const task = await state.db.backgroundTaskRun.create({ data: { kind: "ingestion", triggerType: "manual", status: "queued", label: "Adapter test" } });
      const controller = new AbortController();
      const context = { signal: controller.signal, taskRunId: task.id, workflowId: "test", runId: "test", stepId: "test", retryCount: 0, attempt: 1, checkpoint: { version: 1, taskRunId: task.id, workflowId: "test", workflowRunId: "test", stepId: "test", attempt: 1, retryCount: 0, status: "running", startedAt: new Date().toISOString() }, checkCancellation: async () => {} } as import("@infinitum/ai/orchestration/task-definition").DomainTaskContext;
      const sourcePayload = await executeIngestionWorkflowStage("source_sync", task, context, options);
      return executeIngestionWorkflowStage("item_processing", sourcePayload, context, options);
    };
    await run();
    await run();
    const identities = await state.db.adapterItemIdentity.findMany({ where: { externalId: "old" }, include: { item: true } });
    expect(identities).toHaveLength(1);
    expect(identities[0].item.publishedAt.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(identities[0].item.status).toBe("processed");
    expect(ai.understandItem).toHaveBeenCalledTimes(1);
    state.items.mockResolvedValue({ items: [{ ...upstream, content: { text: "A revised and fuller article body.", status: "full" } }], latestFetchedAt: "2026-10-31T00:00:00Z", upstreamStatus: { state: "ok" } });
    await run();
    const updated = await state.db.adapterItemIdentity.findUniqueOrThrow({ where: { adapterInstanceId_providerId_externalId: { adapterInstanceId: "local", providerId: "xueqiu", externalId: "old" } }, include: { item: true } });
    expect(updated.itemId).toBe(identities[0].itemId);
    expect(updated.item.rssContent).toBe("A revised and fuller article body.");
    expect(ai.understandItem).toHaveBeenCalledTimes(2);
    state.items.mockResolvedValue({ items: [{ ...upstream, content: { text: "A revised and fuller article body.", status: "full" } }], latestFetchedAt: "2026-10-31T00:00:00Z", upstreamStatus: { state: "rate_limited", code: "RATE_LIMITED" } });
    await run();
    const sourceHealth = await state.db.source.findUniqueOrThrow({ where: { id: "adapter-source" } });
    expect(sourceHealth.healthStatus).toBe("failed");
    expect(sourceHealth.healthMessage).toContain("限流");
    expect(ai.understandItem).toHaveBeenCalledTimes(2);
    const retryItem = { ...upstream, externalId: "retry", url: "https://example.com/retry" };
    state.items.mockResolvedValue({ items: [retryItem], latestFetchedAt: "2026-10-31T00:00:00Z", upstreamStatus: { state: "ok" } });
    understand.mockRejectedValueOnce(new Error("temporary failure"));
    await run();
    const failed = await state.db.adapterItemIdentity.findUniqueOrThrow({ where: { adapterInstanceId_providerId_externalId: { adapterInstanceId: "local", providerId: "xueqiu", externalId: "retry" } }, include: { item: true } });
    expect(failed.item.analysisStatus).toBe("failed");
    await run();
    const recovered = await state.db.adapterItemIdentity.findUniqueOrThrow({ where: { id: failed.id }, include: { item: true } });
    expect(recovered.item.id).toBe(failed.item.id);
    expect(recovered.item.analysisStatus).toBe("succeeded");
    state.items.mockResolvedValue({ items: [{ ...upstream, content: { text: "A third article version.", status: "full" } }], latestFetchedAt: "2026-10-31T00:00:00Z", upstreamStatus: { state: "ok" } });
    const originalUnderstand = understand.getMockImplementation()!;
    understand.mockImplementationOnce(async (...args: Parameters<typeof ai.understandItem>) => {
      await state.db.item.update({ where: { id: identities[0].itemId }, data: { summaryText: "人工修改" } });
      return originalUnderstand(...args);
    });
    await run();
    const guarded = await state.db.adapterItemIdentity.findUniqueOrThrow({ where: { id: identities[0].id }, include: { item: true } });
    expect(guarded.item.summaryText).toBe("人工修改");
    expect(guarded.needsManualReview).toBe(true);
    const sharedUrl = "https://example.com/shared-stage";
    const shared = await state.db.item.create({ data: { sourceId: "rss-source", originalUrl: sharedUrl, canonicalUrl: sharedUrl, urlHash: (await import("@/lib/ingestion/dedupe")).buildDedupeKeys({ canonicalUrl: sharedUrl }).urlHash, originalTitle: "RSS original", publishedAt: options.now } });
    state.items.mockResolvedValue({ items: [{ ...upstream, externalId: "shared-stage", url: sharedUrl, content: { text: "Completed cross-source content", status: "full" } }], latestFetchedAt: "2026-10-31T00:00:00Z", upstreamStatus: { state: "ok" } });
    await run();
    const linked = await state.db.adapterItemIdentity.findUniqueOrThrow({ where: { adapterInstanceId_providerId_externalId: { adapterInstanceId: "local", providerId: "xueqiu", externalId: "shared-stage" } }, include: { item: true } });
    expect(linked.item.id).toBe(shared.id);
    expect(linked.item.sourceId).toBe("rss-source");
    expect(linked.item.rssContent).toBe("Completed cross-source content");
    expect(linked.item.status).toBe("processed");
  });
  it("migrates and rolls back one verified source without changing IDs or follows", async () => {
    await state.db.backgroundTaskRun.updateMany({ where: { kind: "ingestion" }, data: { status: "succeeded" } });
    const previousBase = process.env.RSSHUB_BASE_URL;
    process.env.RSSHUB_BASE_URL = "http://rsshub:1200";
    try {
      const oldUrl = "http://rsshub:1200/xueqiu/user/987";
      const source = await state.db.source.create({ data: { id: "legacy-adapter", name: "Legacy", rssUrl: oldUrl, siteUrl: "https://xueqiu.com/u/987", follow: { create: {} } } });
      const item = await state.db.item.create({ data: { sourceId: source.id, originalUrl: "https://example.com/legacy", canonicalUrl: "https://example.com/legacy", urlHash: "legacy-adapter-hash", originalTitle: "Legacy", publishedAt: input.now } });
      const account = { accountId: "987", name: "Legacy" };
      state.ensure.mockResolvedValue({ subscription: { id: "existing-sub", providerId: "xueqiu", accountId: "987", account, status: { state: "pending" } } });
      expect(legacyAccountId("http://other/xueqiu/user/987", "xueqiu", "http://rsshub:1200")).toBeNull();
      const migrated = await migrateAdapterSource(source.id, "xueqiu", account);
      expect(migrated.id).toBe(source.id);
      expect(migrated.rssUrl).toBeNull();
      expect(await state.db.sourceFollow.count({ where: { sourceId: source.id } })).toBe(1);
      expect((await state.db.item.findUniqueOrThrow({ where: { id: item.id } })).sourceId).toBe(source.id);
      const restored = await rollbackAdapterSource(source.id);
      expect(restored.rssUrl).toBe(oldUrl);
      expect(restored.transport).toBe("rss");
      expect(await state.db.adapterSourceBinding.count({ where: { sourceId: source.id } })).toBe(1);
      const active = await state.db.backgroundTaskRun.create({ data: { kind: "ingestion", triggerType: "manual", status: "queued", label: "active" } });
      await expect(migrateAdapterSource(source.id, "xueqiu", account)).rejects.toMatchObject({ code: "INGESTION_ACTIVE" });
      expect((await state.db.source.findUniqueOrThrow({ where: { id: source.id } })).rssUrl).toBe(oldUrl);
      await state.db.backgroundTaskRun.update({ where: { id: active.id }, data: { status: "succeeded" } });
    } finally {
      if (previousBase === undefined) delete process.env.RSSHUB_BASE_URL;
      else process.env.RSSHUB_BASE_URL = previousBase;
    }
  });
  it("keeps published report snapshots after source content changes", async () => {
    const inputItem = { ...input, item: { ...input.item, externalId: "report-item", url: "https://example.com/report-item" } };
    const prepared = await prepareAdapterItem(inputItem);
    await state.db.dailyReport.create({ data: { date: "2026-10-30", status: "published", title: "日报", openingSummary: "原摘要", closingThought: "", summaryJson: JSON.stringify({ blocks: [] }), renderedMarkdown: "原日报", inputHash: "test", publishedAt: input.now, sources: { create: { itemId: prepared.item.id, sourceNumber: 1, sourceName: "来源", title: "原标题", url: inputItem.item.url, sourceSummary: "原文章摘要" } } } });
    const before = await getDailyReportByDate("2026-10-30", true);
    await prepareAdapterItem({ ...inputItem, item: { ...inputItem.item, title: "新标题", content: { text: "新正文", status: "full" } } });
    const after = await getDailyReportByDate("2026-10-30", true);
    expect(after?.renderedMarkdown).toBe(before?.renderedMarkdown);
    expect(after?.sources).toEqual(before?.sources);
  });
  it("updates adapter source settings without introducing an RSS URL", async () => {
    const updated = await updateSource("adapter-source", { name: "Adapter updated", rssUrl: null, siteUrl: "", enabled: true, aiParsingEnabled: true, aggregationEnabled: false, aggregationDetectionEnabled: false });
    expect(updated.rssUrl).toBeNull();
    expect(updated.transport).toBe("adapter");
    await expect(updateSource("adapter-source", { name: "A", rssUrl: "https://example.com/feed", siteUrl: "https://example.com", enabled: true, aiParsingEnabled: true })).rejects.toThrow("传输配置无效");
  });
  it("does not enqueue two concurrent ingestion runs", async () => {
    await state.db.backgroundTaskRun.updateMany({ where: { kind: "ingestion" }, data: { status: "succeeded" } });
    const results = await Promise.allSettled([startIngestionTask(), startIngestionTask()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await state.db.backgroundTaskRun.count({ where: { kind: "ingestion", status: { in: ["queued", "running"] } } })).toBe(1);
  }, 20_000);
});
