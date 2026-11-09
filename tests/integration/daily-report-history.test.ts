import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { normalizeDailyReportSourceDateCitations } from "@/lib/daily-report/renderer";
import {
  getDailyReportRevision,
  listDailyReportRevisions,
  restoreDailyReportRevision,
  withDailyReportLock,
} from "@/lib/daily-report/history";

const DATE = "2026-08-13";

async function createHistoryFixture(status: "draft" | "published" = "draft", withCurrent = false) {
  const report = await prisma.dailyReport.create({
    data: {
      date: DATE,
      timezone: "Asia/Shanghai",
      status,
      title: "当前日报",
      openingSummary: "当前摘要",
      closingThought: "当前观察",
      summaryJson: JSON.stringify({ blocks: [{ type: "text", title: "摘要", body: "当前正文" }] }),
      renderedMarkdown: "# 当前日报\n",
      inputHash: "current-input",
    },
  });
  const old = await prisma.dailyReportRevision.create({
    data: {
      dailyReportId: report.id,
      revisionNo: 1,
      action: "generated",
      status: "draft",
      title: "旧版本日报",
      openingSummary: "旧摘要",
      closingThought: "旧观察",
      summaryJson: JSON.stringify({ blocks: [{ type: "text", title: "摘要", body: "旧正文" }] }),
      renderedMarkdown: "# 旧版本日报\n",
      inputHash: "old-input",
      pipelineVersion: "legacy-pipeline-v0",
      idempotencyKey: "history-fixture-old",
      actorType: "system",
      actorLabel: "测试",
      sources: {
        create: [{
          sourceNumber: 1,
          sourceName: "旧来源",
          title: "旧事件",
          url: "https://example.com/old",
          sourceSummary: "旧来源摘要",
        }],
      },
    },
  });
  await prisma.dailyReport.update({ where: { id: report.id }, data: { currentRevisionId: old.id } });
  if (!withCurrent) return { report, old };
  const current = await prisma.dailyReportRevision.create({
    data: {
      dailyReportId: report.id,
      revisionNo: 2,
      action: "generated",
      status,
      title: "当前版本日报",
      openingSummary: "当前摘要",
      closingThought: "当前观察",
      summaryJson: JSON.stringify({ blocks: [{ type: "text", title: "摘要", body: "当前正文" }] }),
      renderedMarkdown: "# 当前日报\n",
      inputHash: "current-input",
      idempotencyKey: "history-fixture-current",
      actorType: "system",
      actorLabel: "测试",
    },
  });
  await prisma.dailyReport.update({ where: { id: report.id }, data: { currentRevisionId: current.id } });
  return { report, old, current };
}

describe("daily report history", () => {
  beforeEach(async () => {
    await prisma.dailyReportOperationLock.deleteMany();
    await prisma.dailyReport.deleteMany();
  });

  it("lists and loads revision detail", async () => {
    const { old } = await createHistoryFixture();
    const revisions = await listDailyReportRevisions(DATE);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ id: old.id, revisionNo: 1, isCurrent: true, canRestore: false });
    await expect(getDailyReportRevision(DATE, old.id)).resolves.toMatchObject({ title: "旧版本日报", sources: [{ sourceNumber: 1 }] });
  });

  it("maps source provenance through revision preview and restore without inventing legacy dates", async () => {
    const { report, old } = await createHistoryFixture("draft", true);
    const originalMarkdown = [
      "# 旧版本日报",
      "- [已知发表](https://example.com/known)（Known source · 发表 2026-11-06）",
      "- [未知发表](https://example.com/unknown)（Unknown source · 收录 2026-11-06）",
      "- [旧数据](https://example.com/legacy-null)（Legacy source · 发表 2026-11-06）",
    ].join("\n");
    await prisma.dailyReportRevisionSource.deleteMany({ where: { revisionId: old.id } });
    await prisma.dailyReportRevisionSource.createMany({ data: [
      {
        revisionId: old.id,
        sourceNumber: 1,
        sourceName: "Known source",
        title: "已知发表",
        url: "https://example.com/known",
        sourcePublishedAt: new Date("2026-11-06T20:00:00.000Z"),
        sourceCapturedAt: new Date("2026-11-09T04:00:00.000Z"),
        sourcePublishedAtKnown: true,
      },
      {
        revisionId: old.id,
        sourceNumber: 2,
        sourceName: "Unknown source",
        title: "未知发表",
        url: "https://example.com/unknown",
        sourcePublishedAt: new Date("2026-11-06T20:00:00.000Z"),
        sourceCapturedAt: new Date("2026-11-06T20:00:00.000Z"),
        sourcePublishedAtKnown: false,
      },
      {
        revisionId: old.id,
        sourceNumber: 3,
        sourceName: "Legacy source",
        title: "旧数据",
        url: "https://example.com/legacy-null",
        sourcePublishedAt: new Date("2026-11-06T20:00:00.000Z"),
        sourceCapturedAt: null,
        sourcePublishedAtKnown: null,
      },
    ] });
    await prisma.dailyReportRevision.update({ where: { id: old.id }, data: { renderedMarkdown: originalMarkdown } });

    const preview = await getDailyReportRevision(DATE, old.id);
    expect(preview?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceNumber: 1,
        publishedAt: "2026-11-06T20:00:00.000Z",
        capturedAt: "2026-11-09T04:00:00.000Z",
        publishedAtKnown: true,
      }),
      expect.objectContaining({
        sourceNumber: 2,
        publishedAt: "2026-11-06T20:00:00.000Z",
        capturedAt: "2026-11-06T20:00:00.000Z",
        publishedAtKnown: false,
      }),
      expect.objectContaining({
        sourceNumber: 3,
        publishedAt: "2026-11-06T20:00:00.000Z",
        capturedAt: null,
        publishedAtKnown: null,
      }),
    ]));
    const previewMarkdown = normalizeDailyReportSourceDateCitations(originalMarkdown, preview!.sources);
    expect(previewMarkdown).toContain("Known source）");
    expect(previewMarkdown).toContain("Unknown source）");
    expect(previewMarkdown).toContain("Legacy source）");
    expect(previewMarkdown).not.toContain("Legacy source · 发表");

    const restored = await restoreDailyReportRevision(DATE, old.id);
    const restoredDetail = await getDailyReportRevision(DATE, restored.id);
    expect(restoredDetail?.action).toBe("restored");
    const sourceProvenance = (sources: NonNullable<typeof preview>["sources"]) => sources
      .map(({ sourceNumber, publishedAt, capturedAt, publishedAtKnown }) => ({ sourceNumber, publishedAt, capturedAt, publishedAtKnown }))
      .sort((left, right) => (left.sourceNumber ?? 0) - (right.sourceNumber ?? 0));
    expect(sourceProvenance(restoredDetail!.sources)).toEqual(sourceProvenance(preview!.sources));
    const persistedRestoredSources = await prisma.dailyReportRevisionSource.findMany({ where: { revisionId: restored.id }, orderBy: { sourceNumber: "asc" } });
    expect(persistedRestoredSources.map((source) => [source.sourcePublishedAtKnown, source.sourcePublishedAt?.toISOString(), source.sourceCapturedAt?.toISOString() ?? null])).toEqual([
      [true, "2026-11-06T20:00:00.000Z", "2026-11-09T04:00:00.000Z"],
      [false, "2026-11-06T20:00:00.000Z", "2026-11-06T20:00:00.000Z"],
      [null, "2026-11-06T20:00:00.000Z", null],
    ]);
    const persistedCurrentSources = await prisma.dailyReportSource.findMany({ where: { dailyReportId: report.id }, orderBy: { sourceNumber: "asc" } });
    expect(persistedCurrentSources.map((source) => [source.sourcePublishedAtKnown, source.sourcePublishedAt?.toISOString(), source.sourceCapturedAt?.toISOString() ?? null])).toEqual([
      [true, "2026-11-06T20:00:00.000Z", "2026-11-09T04:00:00.000Z"],
      [false, "2026-11-06T20:00:00.000Z", "2026-11-06T20:00:00.000Z"],
      [null, "2026-11-06T20:00:00.000Z", null],
    ]);
    expect(report.status).toBe("draft");
  });

  it("keeps published report content unchanged while reading provenance for preview", async () => {
    const { report, old } = await createHistoryFixture("published");
    const storedBefore = await prisma.dailyReport.findUniqueOrThrow({ where: { id: report.id } });
    const revision = await getDailyReportRevision(DATE, old.id);
    normalizeDailyReportSourceDateCitations(revision!.renderedMarkdown, revision!.sources);
    const storedAfter = await prisma.dailyReport.findUniqueOrThrow({ where: { id: report.id } });

    expect(storedAfter.status).toBe("published");
    expect(storedAfter.renderedMarkdown).toBe(storedBefore.renderedMarkdown);
    await expect(restoreDailyReportRevision(DATE, old.id)).rejects.toThrow("只有草稿状态");
  });

  it("restores only draft current reports and writes a new restored revision", async () => {
    const { report, old } = await createHistoryFixture("draft", true);
    const restored = await restoreDailyReportRevision(DATE, old.id);
    expect(restored.action).toBe("restored");
    const current = await prisma.dailyReport.findUniqueOrThrow({ where: { id: report.id } });
    expect(current.status).toBe("draft");
    expect(current.title).toBe("旧版本日报");
    expect(current.currentRevisionId).toBe(restored.id);
    await expect(prisma.dailyReportSource.findMany({ where: { dailyReportId: report.id } })).resolves.toHaveLength(1);
    expect(restored.pipelineVersion).toBe("legacy-pipeline-v0");
    await expect(prisma.dailyReportRevision.findMany({ where: { dailyReportId: report.id } })).resolves.toHaveLength(3);
  });

  it("does not restore the current revision", async () => {
    const { current } = await createHistoryFixture("draft", true);
    await expect(restoreDailyReportRevision(DATE, current!.id)).rejects.toThrow("当前版本无需恢复");
  });

  it("rejects restoring a published current report", async () => {
    const { old } = await createHistoryFixture("published");
    await expect(restoreDailyReportRevision(DATE, old.id)).rejects.toThrow("只有草稿状态");
  });

  it("serializes concurrent operations for one report date", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = withDailyReportLock(DATE, "generate", async () => {
      markStarted();
      await held;
      return "first";
    });
    await started;
    await expect(withDailyReportLock(DATE, "restore", async () => "second"))
      .rejects.toMatchObject({ status: 409, code: "daily_report_operation_in_progress" });
    release();
    await expect(first).resolves.toBe("first");
  });
});
