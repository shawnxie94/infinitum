import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/provider-next", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createAiProvider: () => new Proxy({}, { get: () => vi.fn(async () => null) }),
}));

// vitest 环境下 Mastra step 内读取 settings 会悬挂（真实 worker 无此问题），
// cluster 摘要用例改为注入 stub provider，只验证 tracker + 用量投影接线。
vi.mock("@/lib/clusters/service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveClusterSummaryProvider: vi.fn(async () => ({ summarizeCluster: vi.fn(async () => null) })),
}));

import { prisma } from "@/lib/db";
import { triggerTaskWorkflow } from "@/lib/ai-orchestration/runtime";

describe("Mastra staged task workflows", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.backgroundTaskRun.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();
    await prisma.taskSchedule.deleteMany();
  });

  it("executes every item-cleanup stage and persists the framework checkpoint", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_cleanup",
        triggerType: "manual",
        status: "queued",
        label: "清理过期条目",
      },
    });

    const result = await triggerTaskWorkflow("item_cleanup", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    const checkpoint = JSON.parse(stored.pipelineCheckpointJson ?? "{}");

    expect(result.status).toBe("succeeded");
    expect(stored.status).toBe("succeeded");
    expect(checkpoint.__mastra.step.stepId).toBe("item_cleanup-cluster_finalize");
    expect(checkpoint.__mastra.lifecycle.event).toBe("finish");
    expect(stored.progressLabel).toContain("cluster_finalize");
  });

  it("does not resume a terminal task row through a Mastra workflow", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_cleanup",
        triggerType: "manual",
        status: "failed",
        label: "已失败任务",
        progressLabel: "已结束",
        errorSummary: "prior failure",
        finishedAt: new Date(),
      },
    });

    const result = await triggerTaskWorkflow("item_cleanup", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });

    expect(result.status).toBe("failed");
    expect(stored.status).toBe("failed");
    expect(stored.progressLabel).toBe("已结束");
    expect(stored.errorSummary).toBe("prior failure");
    expect(stored.pipelineCheckpointJson).toBeNull();
  });

  it("does not resume a terminal staged daily report task", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "cancelled",
        label: "已取消日报",
        finishedAt: new Date(),
      },
    });

    const result = await triggerTaskWorkflow("daily_report_generate", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });

    expect(result.status).toBe("cancelled");
    expect(stored.status).toBe("cancelled");
    expect(stored.pipelineCheckpointJson).toBeNull();
  });

  it("persists cancellation for a queued staged task before business side effects", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_cleanup",
        triggerType: "manual",
        status: "queued",
        label: "清理过期条目",
        cancelRequestedAt: new Date(),
      },
    });

    const result = await triggerTaskWorkflow("item_cleanup", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    const checkpoint = JSON.parse(stored.pipelineCheckpointJson ?? "{}");

    expect(result.status).toBe("cancelled");
    expect(stored.status).toBe("cancelled");
    expect(checkpoint.__mastra.lifecycle.event).toBe("cancel");
  });

  it("runs recovery through batch and persist stages when no candidates are due", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_processing_recovery",
        triggerType: "manual",
        status: "queued",
        label: "抓取失败补偿",
      },
    });

    const result = await triggerTaskWorkflow("item_processing_recovery", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    const checkpoint = JSON.parse(stored.pipelineCheckpointJson ?? "{}");

    expect(result.status).toBe("succeeded");
    expect(stored.status).toBe("succeeded");
    expect(checkpoint.__mastra.step.stepId).toBe("item_processing_recovery-recovery_persist");
  });

  it("runs ingestion through the four declared stages with an empty source set", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "ingestion",
        triggerType: "manual",
        status: "queued",
        label: "默认抓取任务",
      },
    });

    const result = await triggerTaskWorkflow("ingestion", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    const fetchRun = await prisma.fetchRun.findFirst({ where: { taskRunId: taskRun.id } });

    expect(result.status).toBe("succeeded");
    expect(stored.status).toBe("succeeded");
    expect(fetchRun?.status).toBe("succeeded");
    expect(JSON.parse(stored.pipelineCheckpointJson ?? "{}").__mastra.step.stepId).toBe("ingestion-cluster_finalize");
  });

  it("projects cluster summary AI usage onto the task run", async () => {
    const clusterId = "staged-cluster-summary-usage";
    const publishedAt = new Date("2026-06-30T00:00:00.000Z");
    await prisma.contentCluster.deleteMany({ where: { id: clusterId } });
    const source = await prisma.source.create({
      data: {
        id: `${clusterId}-source`,
        name: clusterId,
        rssUrl: `https://staged.example.com/${clusterId}/rss`,
        siteUrl: `https://staged.example.com/${clusterId}`,
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    await prisma.contentCluster.create({
      data: {
        id: clusterId,
        kind: "topic",
        title: "staged 聚类摘要",
        summary: "staged 聚类摘要备选",
        score: 60,
        itemCount: 2,
        latestPublishedAt: publishedAt,
        createdAt: publishedAt,
        updatedAt: publishedAt,
        status: "active",
        fingerprint: `fp-${clusterId}`,
      },
    });
    await prisma.item.createMany({
      data: [0, 1].map((index) => ({
        id: `${clusterId}-item-${index}`,
        sourceId: source.id,
        clusterId,
        originalUrl: `https://staged.example.com/${clusterId}/item-${index}`,
        canonicalUrl: `https://staged.example.com/${clusterId}/item-${index}`,
        urlHash: `${clusterId}-item-${index}-hash`,
        originalTitle: `staged 聚类条目 ${index + 1}`,
        status: "processed",
        moderationStatus: "allowed",
        publishedAt,
        createdAt: publishedAt,
      })),
    });

    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "cluster_regenerate_summary",
        triggerType: "manual",
        status: "queued",
        label: "重新生成聚类摘要",
        entityId: clusterId,
      },
    });

    const result = await triggerTaskWorkflow("cluster_regenerate_summary", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });

    expect(result.status).toBe("succeeded");
    expect(stored.status).toBe("succeeded");
    // mock provider 返回 null 也完成了 summarizeCluster 委派——计数必须在委派前记录
    expect(stored.aiCallCountActual).toBe(1);
    expect(stored.aiCallCountEstimated).toBe(1);
    const breakdown = JSON.parse(stored.aiCallBreakdownJson ?? "[]") as Array<{ key: string; actual: number }>;
    expect(breakdown.find((entry) => entry.key === "cluster_summary")?.actual).toBe(1);

    await prisma.contentCluster.deleteMany({ where: { id: clusterId } });
  });
});
