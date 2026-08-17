import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { normalizeDailyReportDate } from "@/lib/daily-report/date";
import { DAILY_REPORT_TIMEZONE } from "@/lib/daily-report/types";
import type {
  DailyReportRevisionDetailDTO,
  DailyReportRevisionListItemDTO,
  DailyReportSourceDTO,
} from "@/lib/daily-report/types";
import { invalidateDailyReportCache } from "@/lib/daily-report/cache";

const LOCK_TTL_MS = 5 * 60 * 1000;
const LOCK_RENEW_INTERVAL_MS = Math.max(1_000, Math.floor(LOCK_TTL_MS / 3));

export class DailyReportOperationInProgressError extends Error {
  readonly code = "daily_report_operation_in_progress";
  readonly status = 409;

  constructor(message = "该日期日报正在生成或恢复，请稍后再试。") {
    super(message);
    this.name = "DailyReportOperationInProgressError";
  }
}

function sourceToDTO(source: {
  id: string;
  sourceNumber: number | null;
  sourceSummary: string | null;
  sourceQualityScore: number | null;
  itemId: string | null;
  clusterId: string | null;
  sourceName: string;
  title: string;
  url: string;
  sectionName: string | null;
  topic: string | null;
}): DailyReportSourceDTO {
  return {
    id: source.id,
    sourceNumber: source.sourceNumber,
    sourceSummary: source.sourceSummary,
    sourceQualityScore: source.sourceQualityScore,
    itemId: source.itemId,
    clusterId: source.clusterId,
    sourceName: source.sourceName,
    title: source.title,
    url: source.url,
    sectionName: source.sectionName,
    topic: source.topic,
  };
}

async function acquireLock(date: string, operation: string) {
  const ownerId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  try {
    const lock = await prisma.$transaction(async (tx) => {
      const existing = await tx.dailyReportOperationLock.findUnique({
        where: { date_timezone: { date, timezone: DAILY_REPORT_TIMEZONE } },
      });
      if (!existing) {
        return tx.dailyReportOperationLock.create({
          data: { date, timezone: DAILY_REPORT_TIMEZONE, operation, ownerId, expiresAt },
        });
      }
      if (existing.expiresAt > now) {
        throw new DailyReportOperationInProgressError();
      }
      const replaced = await tx.dailyReportOperationLock.updateMany({
        where: { id: existing.id, expiresAt: { lte: now } },
        data: { operation, ownerId, expiresAt },
      });
      if (replaced.count !== 1) {
        throw new DailyReportOperationInProgressError();
      }
      return tx.dailyReportOperationLock.findUniqueOrThrow({ where: { id: existing.id } });
    });
    return { id: lock.id, ownerId };
  } catch (error) {
    if (error instanceof DailyReportOperationInProgressError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new DailyReportOperationInProgressError();
    }
    throw error;
  }
}

async function assertDailyReportLock(lock: { id: string; ownerId: string }) {
  const current = await prisma.dailyReportOperationLock.findUnique({ where: { id: lock.id } });
  if (!current || current.ownerId !== lock.ownerId || current.expiresAt <= new Date()) {
    throw new DailyReportOperationInProgressError("日报操作锁已失效，请重新发起操作。");
  }
}

async function renewDailyReportLock(lock: { id: string; ownerId: string }) {
  const expiresAt = new Date(Date.now() + LOCK_TTL_MS);
  const renewed = await prisma.dailyReportOperationLock.updateMany({
    where: { id: lock.id, ownerId: lock.ownerId },
    data: { expiresAt },
  });
  if (renewed.count !== 1) {
    throw new DailyReportOperationInProgressError("日报操作锁已失效，请重新发起操作。");
  }
}

async function withDailyReportLock<T>(
  date: string,
  operation: string,
  callback: (context: { assertLock: () => Promise<void> }) => Promise<T>,
) {
  const lock = await acquireLock(date, operation);
  let renewalError: unknown = null;
  const renewalTimer = setInterval(() => {
    void renewDailyReportLock(lock).catch((error) => {
      renewalError ??= error;
    });
  }, LOCK_RENEW_INTERVAL_MS);
  try {
    const assertLockAndRenewal = async () => {
      if (renewalError) throw renewalError;
      await assertDailyReportLock(lock);
    };
    const result = await callback({ assertLock: assertLockAndRenewal });
    if (renewalError) throw renewalError;
    return result;
  } finally {
    clearInterval(renewalTimer);
    await prisma.dailyReportOperationLock.deleteMany({ where: { id: lock.id, ownerId: lock.ownerId } });
  }
}

export async function listDailyReportRevisions(rawDate: string): Promise<DailyReportRevisionListItemDTO[]> {
  const date = normalizeDailyReportDate(rawDate);
  const report = await prisma.dailyReport.findUnique({
    where: { date_timezone: { date, timezone: DAILY_REPORT_TIMEZONE } },
    select: { id: true, currentRevisionId: true, status: true },
  });
  if (!report) return [];
  const revisions = await prisma.dailyReportRevision.findMany({
    where: { dailyReportId: report.id },
    orderBy: { revisionNo: "desc" },
  });
  return revisions.map((revision) => ({
    id: revision.id,
    revisionNo: revision.revisionNo,
    action: revision.action,
    status: revision.status,
    title: revision.title,
    createdAt: revision.createdAt.toISOString(),
    isCurrent: report.currentRevisionId === revision.id,
    canRestore: report.status === "draft" && report.currentRevisionId !== revision.id && report.currentRevisionId !== null,
  }));
}

export async function getDailyReportRevision(rawDate: string, revisionId: string): Promise<DailyReportRevisionDetailDTO | null> {
  const date = normalizeDailyReportDate(rawDate);
  const revision = await prisma.dailyReportRevision.findFirst({
    where: { id: revisionId, dailyReport: { date, timezone: DAILY_REPORT_TIMEZONE } },
    include: { dailyReport: { select: { currentRevisionId: true, status: true } }, sources: true },
  });
  if (!revision) return null;
  let content = { blocks: [] } as DailyReportRevisionDetailDTO["content"];
  try { content = JSON.parse(revision.summaryJson) as DailyReportRevisionDetailDTO["content"]; } catch { /* return the raw markdown with an empty content fallback */ }
  return {
    id: revision.id,
    revisionNo: revision.revisionNo,
    action: revision.action,
    status: revision.status,
    title: revision.title,
    createdAt: revision.createdAt.toISOString(),
    isCurrent: revision.dailyReport.currentRevisionId === revision.id,
    canRestore: revision.dailyReport.status === "draft"
      && revision.dailyReport.currentRevisionId !== null
      && revision.dailyReport.currentRevisionId !== revision.id,
    openingSummary: revision.openingSummary,
    closingThought: revision.closingThought,
    content,
    renderedMarkdown: revision.renderedMarkdown,
    inputHash: revision.inputHash,
    modelName: revision.modelName,
    templateSignature: revision.templateSignature,
    pipelineVersion: revision.pipelineVersion,
    sources: revision.sources.map(sourceToDTO),
    restoredFromRevisionId: revision.restoredFromRevisionId,
    actorType: revision.actorType,
    actorLabel: revision.actorLabel,
  };
}

export async function restoreDailyReportRevision(rawDate: string, revisionId: string) {
  const date = normalizeDailyReportDate(rawDate);
  return withDailyReportLock(date, "restore", async ({ assertLock }) => {
    await assertLock();
    const report = await prisma.dailyReport.findUnique({
      where: { date_timezone: { date, timezone: DAILY_REPORT_TIMEZONE } },
      include: { revisions: { orderBy: { revisionNo: "desc" }, take: 1 }, sources: true },
    });
    if (!report) throw new Error("日报不存在。");
    if (report.status !== "draft") throw new Error("只有草稿状态的日报支持恢复历史版本。");
    const revision = await prisma.dailyReportRevision.findFirst({ where: { id: revisionId, dailyReportId: report.id }, include: { sources: true } });
    if (!revision) throw new Error("日报历史版本不存在。");
    if (report.currentRevisionId === revision.id) throw new Error("当前版本无需恢复。");
    const nextRevisionNo = (report.revisions[0]?.revisionNo ?? 0) + 1;
    const restored = await prisma.$transaction(async (tx) => {
      const next = await tx.dailyReportRevision.create({
        data: {
          dailyReportId: report.id,
          revisionNo: nextRevisionNo,
          action: "restored",
          status: "draft",
          title: revision.title,
          openingSummary: revision.openingSummary,
          closingThought: revision.closingThought,
          summaryJson: revision.summaryJson,
          renderedMarkdown: revision.renderedMarkdown,
          inputHash: revision.inputHash,
          modelName: revision.modelName,
          templateSignature: revision.templateSignature,
          pipelineVersion: revision.pipelineVersion,
          taskRunId: null,
          candidateSnapshot: revision.candidateSnapshot,
          idempotencyKey: `restore:${report.id}:${revision.id}:${nextRevisionNo}`,
          actorType: "admin",
          actorLabel: "管理员恢复",
          restoredFromRevisionId: revision.id,
          sources: { create: revision.sources.map((source) => { const { id, revisionId, createdAt, ...rest } = source; void id; void revisionId; void createdAt; return rest; }) },
        },
      });
      await tx.dailyReport.update({
        where: { id: report.id },
        data: {
          status: "draft",
          title: revision.title,
          openingSummary: revision.openingSummary,
          closingThought: revision.closingThought,
          summaryJson: revision.summaryJson,
          renderedMarkdown: revision.renderedMarkdown,
          inputHash: revision.inputHash,
          modelName: revision.modelName,
          taskRunId: null,
          candidateSnapshot: revision.candidateSnapshot,
          currentRevisionId: next.id,
          publishedAt: null,
          errorMessage: null,
        },
      });
      await tx.dailyReportSource.deleteMany({ where: { dailyReportId: report.id } });
      await tx.dailyReportSource.createMany({ data: revision.sources.map((source) => { const { id, revisionId, createdAt, ...rest } = source; void id; void revisionId; void createdAt; return { dailyReportId: report.id, ...rest }; }) });
      return next;
    });
    invalidateDailyReportCache();
    return restored;
  });
}

export { withDailyReportLock };
