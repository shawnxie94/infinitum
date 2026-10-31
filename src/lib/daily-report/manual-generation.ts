import { prisma } from "@/lib/db";
import { assertDailyReportDateIsNotFuture } from "@/lib/daily-report/date";

// Labels are durable correlation keys, separate from workflow checkpoints.
const FETCH_LABEL = "手动日报抓取 ";
const REPORT_LABEL = "手动日报生成 ";
const active = ["queued", "running"] as const;
const completedFetch = ["succeeded", "partial"] as const;

class GenerationConflict extends Error {
  status = 409;
}


export async function getManualDailyGeneration() {
  const fetchRun = await prisma.backgroundTaskRun.findFirst({
    where: { kind: "ingestion", label: { startsWith: FETCH_LABEL } },
    orderBy: { createdAt: "desc" },
  });
  if (!fetchRun) return null;
  const reportRun = await prisma.backgroundTaskRun.findFirst({
    where: { kind: "daily_report_generate", label: `${REPORT_LABEL}${fetchRun.id}` },
  });
  const task = reportRun ?? fetchRun;
  return {
    id: fetchRun.id,
    date: fetchRun.entityId!,
    phase: reportRun ? "report" : "fetch",
    status: completedFetch.some((status) => status === fetchRun.status) && !reportRun ? "queued" : task.status,
    fetchWarning: fetchRun.status === "partial" ? (fetchRun.errorSummary || "部分信息源或文章抓取失败。") : null,
    progressLabel: task.progressLabel,
    error: task.errorSummary,
  };
}

export async function startManualDailyGeneration(date: string) {
  const normalized = assertDailyReportDateIsNotFuture(date);
  try {
    return await prisma.$transaction(async (tx) => {
    const latest = await tx.backgroundTaskRun.findFirst({
      where: { kind: "ingestion", label: { startsWith: FETCH_LABEL } },
      orderBy: { createdAt: "desc" },
    });
    if (latest) {
      const report = await tx.backgroundTaskRun.findFirst({ where: { kind: "daily_report_generate", label: `${REPORT_LABEL}${latest.id}` } });
      if (active.some((status) => status === latest.status) || (completedFetch.some((status) => status === latest.status) && (!report || active.some((status) => status === report.status)))) {
        if (latest.entityId !== normalized) throw new GenerationConflict(`已有 ${latest.entityId} 的日报生成任务，请等待完成。`);
        return latest;
      }
    }
    const runningFetch = await tx.backgroundTaskRun.findFirst({ where: { kind: "ingestion", status: { in: [...active] } } });
    if (runningFetch) throw new GenerationConflict("已有抓取任务正在进行，请完成后重试生成日报。");
    return tx.backgroundTaskRun.create({ data: {
      kind: "ingestion", triggerType: "manual", status: "queued", label: `${FETCH_LABEL}${normalized}`, entityId: normalized,
    } });
    });
  } catch (error) {
    // SQLite may reject a concurrent transaction while another writer wins.
    // Only translate the failure when an actual active fetch now exists.
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (["P1008", "P2028", "P2034"].includes(String(code)) && await prisma.backgroundTaskRun.findFirst({ where: { kind: "ingestion", status: { in: [...active] } } })) {
      throw new GenerationConflict("已有抓取任务正在进行，请完成后重试生成日报。");
    }
    throw error;
  }
}

/** Reconciles the durable handoff after a crash as well as after normal execution. */
export async function reconcileManualDailyGeneration() {
  return prisma.$transaction(async (tx) => {
    const fetchRun = await tx.backgroundTaskRun.findFirst({
      where: { kind: "ingestion", label: { startsWith: FETCH_LABEL } }, orderBy: { createdAt: "desc" },
    });
    if (!fetchRun || !completedFetch.some((status) => status === fetchRun.status) || !fetchRun.entityId) return;
    const label = `${REPORT_LABEL}${fetchRun.id}`;
    const existing = await tx.backgroundTaskRun.findFirst({ where: { kind: "daily_report_generate", label } });
    if (existing) return;
    const competing = await tx.backgroundTaskRun.findFirst({ where: { kind: "daily_report_generate", entityId: fetchRun.entityId, status: { in: [...active] } } });
    if (competing) return;
    await tx.backgroundTaskRun.create({ data: {
      kind: "daily_report_generate", triggerType: "manual", status: "queued", label, entityId: fetchRun.entityId,
    } });
  });
}
