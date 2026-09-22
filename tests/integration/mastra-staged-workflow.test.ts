import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/provider", () => ({
  createAiProvider: () => new Proxy({}, { get: () => vi.fn(async () => null) }),
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
});
