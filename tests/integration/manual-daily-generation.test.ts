import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { startIngestionTask } from "@/lib/ingestion/service";
import { getManualDailyGeneration, reconcileManualDailyGeneration, startManualDailyGeneration } from "@/lib/daily-report/manual-generation";

describe("manual daily generation handoff", () => {
  beforeEach(async () => { await prisma.backgroundTaskRun.deleteMany({ where: { OR: [{ label: { startsWith: "手动日报" } }, { label: "测试普通抓取" }] } }); });

  it("persists a single handoff, waits for success, and reconciles idempotently", async () => {
    const first = await startManualDailyGeneration("2020-04-24");
    await expect(startManualDailyGeneration("2020-04-23")).rejects.toMatchObject({ status: 409 });
    await reconcileManualDailyGeneration();
    expect(await prisma.backgroundTaskRun.count({ where: { kind: "daily_report_generate", label: `手动日报生成 ${first.id}` } })).toBe(0);
    await prisma.backgroundTaskRun.update({ where: { id: first.id }, data: { status: "succeeded" } });
    expect((await getManualDailyGeneration())?.status).toBe("queued");
    await reconcileManualDailyGeneration();
    await reconcileManualDailyGeneration();
    const report = await prisma.backgroundTaskRun.findMany({ where: { kind: "daily_report_generate", label: `手动日报生成 ${first.id}` } });
    expect(report).toHaveLength(1);
    expect(report[0]?.entityId).toBe("2020-04-24");
    await expect(startManualDailyGeneration("2020-04-23")).rejects.toMatchObject({ status: 409 });
    await prisma.backgroundTaskRun.update({ where: { id: report[0]!.id }, data: { status: "succeeded" } });
    expect((await getManualDailyGeneration())?.phase).toBe("report");
    expect((await startManualDailyGeneration("2020-04-23")).id).not.toBe(first.id);
  });

  it.each(["queued", "running"] as const)("rejects an existing %s ordinary ingestion and allows retry after completion", async (status) => {
    const ordinary = await prisma.backgroundTaskRun.create({ data: { kind: "ingestion", triggerType: "manual", status, label: "测试普通抓取" } });
    await expect(startManualDailyGeneration("2020-05-02")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("已有抓取") });
    expect(await prisma.backgroundTaskRun.count({ where: { kind: "ingestion", status: { in: ["queued", "running"] } } })).toBe(1);
    await prisma.backgroundTaskRun.update({ where: { id: ordinary.id }, data: { status: "succeeded" } });
    expect((await startManualDailyGeneration("2020-05-02")).entityId).toBe("2020-05-02");
  });

  it("does not create duplicate fetches under concurrent starts", async () => {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => startManualDailyGeneration("2020-05-01")));
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await prisma.backgroundTaskRun.count({ where: { kind: "ingestion", label: "手动日报抓取 2020-05-01" } })).toBe(1);
  });

  it("arbitrates a simultaneous normal ingestion and manual daily request", async () => {
    const results = await Promise.allSettled([startIngestionTask(), startManualDailyGeneration("2020-05-03")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.backgroundTaskRun.count({ where: { kind: "ingestion", status: { in: ["queued", "running"] } } })).toBe(1);
    await prisma.backgroundTaskRun.updateMany({ where: { kind: "ingestion", status: { in: ["queued", "running"] } }, data: { status: "succeeded" } });
  });

  it("continues after a partial fetch and preserves the warning through report completion", async () => {
    const fetch = await startManualDailyGeneration("2020-04-24");
    await prisma.backgroundTaskRun.update({ where: { id: fetch.id }, data: { status: "partial", errorSummary: "源 A 获取失败" } });
    expect(await getManualDailyGeneration()).toMatchObject({ status: "queued", fetchWarning: "源 A 获取失败" });
    await reconcileManualDailyGeneration();
    const report = await prisma.backgroundTaskRun.findFirstOrThrow({ where: { label: `手动日报生成 ${fetch.id}` } });
    expect(report).toMatchObject({ status: "queued", entityId: "2020-04-24" });
    await prisma.backgroundTaskRun.update({ where: { id: report.id }, data: { status: "succeeded" } });
    expect(await getManualDailyGeneration()).toMatchObject({ phase: "report", status: "succeeded", fetchWarning: "源 A 获取失败" });
  });

  it.each(["failed", "cancelled"] as const)("does not generate after %s fetch", async (status) => {
    const fetch = await startManualDailyGeneration("2020-04-24");
    await prisma.backgroundTaskRun.update({ where: { id: fetch.id }, data: { status } });
    await reconcileManualDailyGeneration();
    expect(await prisma.backgroundTaskRun.count({ where: { kind: "daily_report_generate", label: `手动日报生成 ${fetch.id}` } })).toBe(0);
    expect((await getManualDailyGeneration())?.status).toBe(status);
    expect((await startManualDailyGeneration("2020-04-24")).id).not.toBe(fetch.id);
  });
});
