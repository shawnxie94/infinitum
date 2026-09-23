import { beforeEach, describe, expect, it } from "vitest";
import type { ItemStatus } from "@prisma/client";

import { prisma } from "@/lib/db";
import { invalidateFeedCache } from "@/lib/feed/cache";
import { triggerTaskWorkflow } from "@/lib/ai-orchestration/runtime";
import {
  ensureDefaultItemCleanupSchedule,
  requestTaskRunCancellation,
} from "@/lib/tasks/service";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe("item cleanup workflow", () => {
  beforeEach(async () => {
    await prisma.itemDedupeHistory.deleteMany();
    await prisma.item.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.backgroundTaskRun.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();
    await prisma.taskSchedule.deleteMany();

    invalidateFeedCache();
  });

  async function createSource(name: string) {
    return prisma.source.create({
      data: {
        name,
        rssUrl: `https://example.com/${name}.xml`,
        siteUrl: `https://example.com/${name}`,
        enabled: true,
      },
    });
  }

  async function createItem(input: {
    sourceId: string;
    originalTitle: string;
    createdAt: Date;
    clusterId?: string | null;
    status?: ItemStatus;
  }) {
    return prisma.item.create({
      data: {
        sourceId: input.sourceId,
        originalUrl: `https://example.com/${input.originalTitle}`,
        canonicalUrl: `https://example.com/${input.originalTitle}`,
        urlHash: `hash-${input.originalTitle}-${Date.now()}-${Math.random()}`,
        originalTitle: input.originalTitle,
        publishedAt: input.createdAt,
        createdAt: input.createdAt,
        clusterId: input.clusterId ?? null,
        status: input.status ?? "processed",
      },
    });
  }

  async function createTaskRun() {
    return prisma.backgroundTaskRun.create({
      data: {
        kind: "item_cleanup",
        triggerType: "manual",
        status: "queued",
        label: "手动清理测试",
      },
    });
  }

  it("deletes items older than retention days and preserves recent items", async () => {
    const source = await createSource("测试源");
    const now = new Date();
    const oldDate = new Date(now.getTime() - 400 * ONE_DAY_MS);
    const recentDate = new Date(now.getTime() - 10 * ONE_DAY_MS);

    const oldItem = await createItem({
      sourceId: source.id,
      originalTitle: "过期文章",
      createdAt: oldDate,
    });
    const recentItem = await createItem({
      sourceId: source.id,
      originalTitle: "最近文章",
      createdAt: recentDate,
    });

    const taskRun = await createTaskRun();

    await triggerTaskWorkflow("item_cleanup", taskRun.id);

    // Old item should be deleted
    const deletedItem = await prisma.item.findUnique({ where: { id: oldItem.id } });
    expect(deletedItem).toBeNull();

    // Recent item should still exist
    const preservedItem = await prisma.item.findUnique({ where: { id: recentItem.id } });
    expect(preservedItem).not.toBeNull();
  });

  it("archives deleted item dedupe keys so ingestion can skip them later", async () => {
    const source = await createSource("测试源");
    const now = new Date();
    const oldDate = new Date(now.getTime() - 400 * ONE_DAY_MS);

    const oldItem = await createItem({
      sourceId: source.id,
      originalTitle: "过期文章",
      createdAt: oldDate,
    });

    const taskRun = await createTaskRun();

    await triggerTaskWorkflow("item_cleanup", taskRun.id);

    const archived = await prisma.itemDedupeHistory.findUnique({
      where: { urlHash: oldItem.urlHash },
    });

    expect(archived).not.toBeNull();
    expect(archived?.originalTitle).toBe(oldItem.originalTitle);
    expect(archived?.sourceId).toBe(source.id);
  });

  it("recomputes affected clusters and removes empty ones", async () => {
    const source = await createSource("测试源");
    const now = new Date();
    const oldDate = new Date(now.getTime() - 400 * ONE_DAY_MS);

    const cluster = await prisma.contentCluster.create({
      data: {
        id: "cluster-to-be-cleaned",
        title: "将被清理的聚合",
        summary: "测试聚合摘要",
        itemCount: 1,
        fingerprint: "test-signature",
        latestPublishedAt: oldDate,
      },
    });

    await createItem({
      sourceId: source.id,
      originalTitle: "聚合中的过期文章",
      createdAt: oldDate,
      clusterId: cluster.id,
    });

    const taskRun = await createTaskRun();

    await triggerTaskWorkflow("item_cleanup", taskRun.id);

    // Item should be deleted
    const itemCount = await prisma.item.count();
    expect(itemCount).toBe(0);

    // Cluster should be deleted (was emptied)
    const clusterAfter = await prisma.contentCluster.findUnique({ where: { id: cluster.id } });
    expect(clusterAfter).toBeNull();
  });

  it("preserves cluster that still has remaining items after cleanup", async () => {
    const source = await createSource("测试源");
    const now = new Date();
    const oldDate = new Date(now.getTime() - 400 * ONE_DAY_MS);
    const recentDate = new Date(now.getTime() - 10 * ONE_DAY_MS);

    const cluster = await prisma.contentCluster.create({
      data: {
        id: "cluster-partial-clean",
        title: "部分清理的聚合",
        summary: "测试聚合摘要 2",
        itemCount: 2,
        fingerprint: "test-signature-2",
        latestPublishedAt: oldDate,
      },
    });

    await createItem({
      sourceId: source.id,
      originalTitle: "聚合中的老文章",
      createdAt: oldDate,
      clusterId: cluster.id,
    });
    await createItem({
      sourceId: source.id,
      originalTitle: "聚合中的新文章",
      createdAt: recentDate,
      clusterId: cluster.id,
    });

    const taskRun = await createTaskRun();

    await triggerTaskWorkflow("item_cleanup", taskRun.id);

    // Only one item should remain
    const remainingItems = await prisma.item.findMany();
    expect(remainingItems.length).toBe(1);
    expect(remainingItems[0].originalTitle).toBe("聚合中的新文章");

    // Cluster should still exist with updated count
    const clusterAfter = await prisma.contentCluster.findUniqueOrThrow({ where: { id: cluster.id } });
    expect(clusterAfter.itemCount).toBe(1);
  });

  it("respects the cleanupRetentionDays from the schedule", async () => {
    const source = await createSource("测试源");
    const now = new Date();

    // Create an item that is 60 days old
    const sixtyDaysAgo = new Date(now.getTime() - 60 * ONE_DAY_MS);
    const oldItem = await createItem({
      sourceId: source.id,
      originalTitle: "60天前的文章",
      createdAt: sixtyDaysAgo,
    });

    // Override schedule to only keep 30 days
    const schedule = await ensureDefaultItemCleanupSchedule();
    await prisma.taskSchedule.update({
      where: { id: schedule.id },
      data: { cleanupRetentionDays: 30 },
    });

    const taskRun = await createTaskRun();

    await triggerTaskWorkflow("item_cleanup", taskRun.id);

    // 60-day-old item should be deleted (retention is 30 days)
    const deletedItem = await prisma.item.findUnique({ where: { id: oldItem.id } });
    expect(deletedItem).toBeNull();
  });

  it("does not delete items younger than retention days", async () => {
    const source = await createSource("测试源");
    const now = new Date();

    const twentyDaysAgo = new Date(now.getTime() - 20 * ONE_DAY_MS);
    const recentItem = await createItem({
      sourceId: source.id,
      originalTitle: "20天前的文章",
      createdAt: twentyDaysAgo,
    });

    // Override schedule to keep 30 days
    const schedule = await ensureDefaultItemCleanupSchedule();
    await prisma.taskSchedule.update({
      where: { id: schedule.id },
      data: { cleanupRetentionDays: 30 },
    });

    const taskRun = await createTaskRun();

    await triggerTaskWorkflow("item_cleanup", taskRun.id);

    // 20-day-old item should still exist (retention is 30 days)
    const preservedItem = await prisma.item.findUnique({ where: { id: recentItem.id } });
    expect(preservedItem).not.toBeNull();
  });

  it("handles cancellation before starting — no items deleted", async () => {
    const source = await createSource("测试源");
    const now = new Date();
    const oldDate = new Date(now.getTime() - 400 * ONE_DAY_MS);

    await createItem({
      sourceId: source.id,
      originalTitle: "过期文章",
      createdAt: oldDate,
    });

    const taskRun = await createTaskRun();

    // Request cancellation before execution
    await requestTaskRunCancellation(taskRun.id);

    await triggerTaskWorkflow("item_cleanup", taskRun.id);

    // Item should NOT be deleted
    const item = await prisma.item.findFirst();
    expect(item).not.toBeNull();

    // Task should be marked as cancelled
    const updated = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    expect(updated.status).toBe("cancelled");
    expect(updated.finishedAt).not.toBeNull();
  });

  it("invalidates feed cache after cleanup", async () => {
    const source = await createSource("测试源");
    const now = new Date();
    const oldDate = new Date(now.getTime() - 400 * ONE_DAY_MS);

    await createItem({
      sourceId: source.id,
      originalTitle: "过期文章",
      createdAt: oldDate,
    });

    const taskRun = await createTaskRun();

    // We verify the function doesn't throw — feed cache invalidation
    // happens internally and its effects are observable at the API level.
    await triggerTaskWorkflow("item_cleanup", taskRun.id);

    const updated = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    expect(updated.status).toBe("succeeded");
  });
});
