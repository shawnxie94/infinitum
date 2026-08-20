import type { DailyReport } from "@prisma/client";

import { prisma } from "@/lib/db";
import { getDailyReportClosingThought, getDailyReportOpeningSummary } from "@/lib/daily-report/content";
import { DailyReportCancellationError } from "@/lib/daily-report/errors";
import type {
  DailyReportContent,
  DailyReportSourceRegistryEntry,
} from "@/lib/daily-report/types";
import { DAILY_REPORT_TIMEZONE } from "@/lib/daily-report/types";
import type { TaskAiUsageSnapshot } from "@/lib/tasks/ai-usage";
import type { TaskPipelineCheckpoint } from "@/lib/tasks/types";

type DailyReportSourceRow = {
  sectionName: string;
  topic: string;
  sourceId: number;
};

function toPersistedSource(source: DailyReportSourceRegistryEntry, extra: { dailyReportId?: string; sectionName?: string; topic?: string } = {}) {
  return {
    ...(extra.dailyReportId ? { dailyReportId: extra.dailyReportId } : {}),
    sourceNumber: source.sourceNumber,
    sourceKey: source.sourceKey,
    itemId: source.itemId,
    clusterId: source.clusterId,
    sourceName: source.sourceName,
    title: source.title,
    url: source.url,
    sourceSummary: source.summary,
    sourcePublishedAt: source.publishedAt ? new Date(source.publishedAt) : null,
    sourceQualityScore: source.qualityScore,
    eventType: source.eventType,
    eventSubject: source.eventSubject,
    eventAction: source.eventAction,
    eventObject: source.eventObject,
    eventDate: source.eventDate,
    ...(extra.sectionName !== undefined ? { sectionName: extra.sectionName } : {}),
    ...(extra.topic !== undefined ? { topic: extra.topic } : {}),
  };
}

function expandPersistedSources(
  sourceRows: DailyReportSourceRow[],
  expandedSourcesByNumber: Map<number, DailyReportSourceRegistryEntry[]>,
) {
  return sourceRows.flatMap((row) => {
    const sources = expandedSourcesByNumber.get(row.sourceId);
    if (!sources) return [];
    return sources.map((source) => toPersistedSource(source, {
      sectionName: row.sectionName,
      topic: row.topic,
    }));
  });
}

export async function persistDailyReport(input: {
  date: string;
  existing: DailyReport | null;
  taskRunId?: string | null;
  content: DailyReportContent;
  title: string;
  renderedMarkdown: string;
  inputHash: string;
  candidateSnapshot: string;
  modelName: string | null;
  templateSignature: string;
  sourceRows: DailyReportSourceRow[];
  expandedSourcesByNumber: Map<number, DailyReportSourceRegistryEntry[]>;
  shouldAutoPublish: boolean;
  publishedAt: Date | null;
  idempotencyKey: string;
  aiUsage: TaskAiUsageSnapshot;
  buildCancellationCheckpoint: () => TaskPipelineCheckpoint | null;
}) {
  return prisma.$transaction(async (tx) => {
    const taskRun = input.taskRunId
      ? await tx.backgroundTaskRun.findUnique({
        where: { id: input.taskRunId },
        select: { cancelRequestedAt: true },
      })
      : null;
    if (taskRun?.cancelRequestedAt) {
      throw new DailyReportCancellationError(input.aiUsage, input.buildCancellationCheckpoint());
    }

    const saved = await tx.dailyReport.upsert({
      where: {
        date_timezone: {
          date: input.date,
          timezone: DAILY_REPORT_TIMEZONE,
        },
      },
      update: {
        status: input.shouldAutoPublish ? "published" : "draft",
        title: input.title,
        openingSummary: getDailyReportOpeningSummary(input.content),
        closingThought: getDailyReportClosingThought(input.content),
        summaryJson: JSON.stringify(input.content),
        renderedMarkdown: input.renderedMarkdown,
        inputHash: input.inputHash,
        modelName: input.modelName,
        taskRunId: input.taskRunId ?? null,
        candidateSnapshot: input.candidateSnapshot,
        errorMessage: null,
        publishedAt: input.publishedAt,
        generatedAt: new Date(),
      },
      create: {
        date: input.date,
        timezone: DAILY_REPORT_TIMEZONE,
        status: input.shouldAutoPublish ? "published" : "draft",
        title: input.title,
        openingSummary: getDailyReportOpeningSummary(input.content),
        closingThought: getDailyReportClosingThought(input.content),
        summaryJson: JSON.stringify(input.content),
        renderedMarkdown: input.renderedMarkdown,
        inputHash: input.inputHash,
        modelName: input.modelName,
        taskRunId: input.taskRunId ?? null,
        candidateSnapshot: input.candidateSnapshot,
        publishedAt: input.publishedAt,
      },
    });

    const existingGeneratedRevision = await tx.dailyReportRevision.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existingGeneratedRevision) {
      await tx.dailyReport.update({ where: { id: saved.id }, data: { currentRevisionId: existingGeneratedRevision.id } });
      return saved;
    }

    const previousSources = input.existing
      ? await tx.dailyReportSource.findMany({ where: { dailyReportId: saved.id } })
      : [];
    await tx.dailyReportSource.deleteMany({ where: { dailyReportId: saved.id } });
    await tx.dailyReportSource.createMany({
      data: expandPersistedSources(input.sourceRows, input.expandedSourcesByNumber).map((source) => ({
        dailyReportId: saved.id,
        ...source,
      })),
    });

    const latestRevision = await tx.dailyReportRevision.findFirst({
      where: { dailyReportId: saved.id },
      orderBy: { revisionNo: "desc" },
    });
    let nextRevisionNo = (latestRevision?.revisionNo ?? 0) + 1;
    if (!latestRevision && input.existing) {
      const baseline = await tx.dailyReportRevision.create({
        data: {
          dailyReportId: saved.id,
          revisionNo: nextRevisionNo,
          action: "baseline",
          status: input.existing.status,
          title: input.existing.title,
          openingSummary: input.existing.openingSummary,
          closingThought: input.existing.closingThought,
          summaryJson: input.existing.summaryJson,
          renderedMarkdown: input.existing.renderedMarkdown,
          inputHash: input.existing.inputHash,
          modelName: input.existing.modelName,
          taskRunId: input.existing.taskRunId,
          candidateSnapshot: input.existing.candidateSnapshot,
          idempotencyKey: `baseline:${saved.id}`,
          actorType: "system",
          actorLabel: "历史日报基线",
          sources: {
            create: previousSources.map(({ id, dailyReportId, createdAt, ...source }) => {
              void id;
              void dailyReportId;
              void createdAt;
              return source;
            }),
          },
        },
      });
      nextRevisionNo = baseline.revisionNo + 1;
    }

    const generatedRevision = await tx.dailyReportRevision.create({
      data: {
        dailyReportId: saved.id,
        revisionNo: nextRevisionNo,
        action: "generated",
        status: saved.status,
        title: saved.title,
        openingSummary: saved.openingSummary,
        closingThought: saved.closingThought,
        summaryJson: saved.summaryJson,
        renderedMarkdown: saved.renderedMarkdown,
        inputHash: saved.inputHash,
        modelName: saved.modelName,
        templateSignature: input.templateSignature,
        pipelineVersion: "daily-report-topic-first-review-v1",
        taskRunId: saved.taskRunId,
        candidateSnapshot: saved.candidateSnapshot,
        idempotencyKey: input.idempotencyKey,
        actorType: "system",
        actorLabel: "日报生成",
        sources: {
          create: expandPersistedSources(input.sourceRows, input.expandedSourcesByNumber),
        },
      },
    });
    await tx.dailyReport.update({ where: { id: saved.id }, data: { currentRevisionId: generatedRevision.id } });
    return saved;
  });
}
