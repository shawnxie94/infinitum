import { createHash } from "node:crypto";

import type { BackgroundTaskRun } from "@prisma/client";

import { createAiProvider, type DailyReportStageContext } from "@/lib/ai/provider";
import { prisma } from "@/lib/db";
import { getDailyReportDateRange, getTodayDailyReportDate, normalizeDailyReportDate } from "@/lib/daily-report/date";
import { invalidateDailyReportCache } from "@/lib/daily-report/cache";
import { withDailyReportLock } from "@/lib/daily-report/history";
import { DailyReportCancellationError, DailyReportGenerationError } from "@/lib/daily-report/errors";
import { normalizeDailyReportContent } from "@/lib/daily-report/content";
import { getDailyReportFailureSummary } from "@/lib/daily-report/review";
import { getDailyReportAttemptLimit, isDailyReportContextOverflowError } from "@/lib/daily-report/attempts";
import { DailyReportStageLoopError, runDailyReportStageLoop, type DailyReportStageLoopResult } from "@/lib/daily-report/stage-loop";
import { listRecentDailyReportSourceSnapshots } from "@/lib/daily-report/repository";
import { renderDailyReportMarkdown } from "@/lib/daily-report/renderer";
import { persistDailyReport } from "@/lib/daily-report/persistence";
import { DAILY_REPORT_TIMEZONE, type DailyReportCandidateAssessment, type DailyReportDraft, type DailyReportModelDraft, type DailyReportPlan, type DailyReportPlanningAudit, type DailyReportPlanningCandidate, type DailyReportContent, type DailyReportReviewFeedback, type DailyReportReviewStatus, type DailyReportReviewViolation } from "@/lib/daily-report/types";
import { isDailyReportNotesRepairableViolation } from "@/lib/daily-report/types";
import { applyDailyReportRepairPatches, buildDailyReportCandidateBriefs, buildDailyReportSelectedTopics, attachDailyReportTopicSources, getDailyReportPlanCandidateIds, getDailyReportPlanTopics, materializeDailyReportPlan, normalizeDailyReportDraftForTemplate, omitInvalidOptionalDailyReportTopics, orderAndLimitDailyReportPlanWithAudit, orderDailyReportDraft, splitDailyReportCandidates, toDailyReportModelDraft, toDailyReportPlanningCandidate, validateDailyReportAssessments, validateDailyReportDraft, validateDailyReportPlan, validateDailyReportPlanSectionQuantities } from "@/lib/daily-report/planning";
import { DEFAULT_DAILY_REPORT_TEMPLATE, classifyDailyReportTemplateMigration, getDailyReportTemplateSignature, normalizeDailyReportTemplateConfig, parseDailyReportTemplateJson } from "@/lib/daily-report/template";
import { resolveDailyReportChannelSourceGroupIds } from "@/lib/events/service";
import { getIngestionRuntimeConfig } from "@/lib/settings/runtime-service";
import { type TaskPipelineCheckpoint } from "@/lib/tasks/types";
import type { TaskAiCallBreakdownSnapshot } from "@/lib/tasks/types";
import { parseTaskPipelineCheckpointJson } from "@/lib/tasks/checkpoint";
import { ensureDefaultDailyReportSchedule, isTaskRunCancellationRequested, parseDailyReportChannelIdsJson, TASK_RUN_CANCELLED_LABEL, TASK_RUN_CANCELLED_MESSAGE, updateTaskRun } from "@/lib/tasks/service";
import { createTaskAiUsageTracker } from "@/lib/tasks/ai-usage";
import { buildDailyReportTaskTimeline, normalizeDailyReportTimelineStage, type DailyReportPipelineStage } from "@/lib/daily-report/timeline";
import { getDailyReportRecoveryStages } from "@/lib/daily-report/recovery";
import { DEFAULT_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS } from "@/lib/tasks/scheduler";
import { buildDailyReportSourceKey, deduplicateDailyReportContentByCandidate } from "@/lib/daily-report/candidates";
import { toCandidateSnapshotEntry } from "@/lib/daily-report/recovery-snapshot";
import { buildDailyReportGenerationSignature, buildDailyReportTitle, buildInputHash, getSectionSourceIds, DAILY_REPORT_PIPELINE_VERSION, MIN_CANDIDATE_COUNT } from "@/lib/daily-report/report-input";
import { buildDailyReportCandidateCoverage, buildDailyReportReviewContext, deduplicateDailyReportCandidates, listDailyReportGenerationCandidates } from "@/lib/daily-report/candidates";
import { filterRecentDailyReportDuplicates } from "@/lib/daily-report/recent-duplicates";
import { buildDailyReportExcludedAssessDuplicateSnapshots, buildDailyReportExcludedRecentDuplicateSnapshots, buildDailyReportRecoveryCandidates, buildDailyReportRecoveryPlan, buildRecentDailyReportTopics, parseDailyReportCandidateSnapshot } from "@/lib/daily-report/recovery-snapshot";
import { assertDailyReportSourceIdsExist, buildExpandedDailyReportSourceRegistry, countExistingSelectedDailyReportCandidates, countSelectedDailyReportCandidates } from "@/lib/daily-report/source-registry";
import { markDailyScheduleRunFinished } from "@/lib/daily-report/report-lifecycle";


export async function generateDailyReportInternal(input: {
  date: string;
  taskRunId?: string | null;
  force?: boolean;
  onCandidatesLoaded?: (candidateCount: number) => Promise<void>;
  onStageUpdate?: (stage: DailyReportPipelineStage) => Promise<void>;
  onCheckpoint?: (checkpoint: TaskPipelineCheckpoint) => Promise<void>;
  resumeCheckpoint?: TaskPipelineCheckpoint | null;
}) {
  const { date } = getDailyReportDateRange(input.date);
  const schedule = await ensureDefaultDailyReportSchedule();
  const dailyReportChannelIds = parseDailyReportChannelIdsJson(schedule.dailyReportChannelIdsJson);
  const dailyReportSourceGroupIds = await resolveDailyReportChannelSourceGroupIds(dailyReportChannelIds);
  const recentTopicLookbackDays = schedule.dailyReportRecentTopicLookbackDays ?? DEFAULT_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS;
  const recentSources = await listRecentDailyReportSourceSnapshots(date, recentTopicLookbackDays);
  const recentTopics = buildRecentDailyReportTopics(recentSources);
  const candidateResult = await listDailyReportGenerationCandidates(
    date,
    schedule.dailyReportCandidateLimit,
    dailyReportChannelIds,
    dailyReportSourceGroupIds,
  );
  const deduplicated = deduplicateDailyReportCandidates(candidateResult.candidates);
  let rawCandidates = deduplicated.candidates;
  let excludedRecentDuplicates = buildDailyReportExcludedRecentDuplicateSnapshots(rawCandidates, recentSources);
  let candidates = filterRecentDailyReportDuplicates(rawCandidates, recentSources, schedule.dailyReportCandidateLimit);
  const runtimeConfig = await getIngestionRuntimeConfig();
  let template;
  const templateJson = runtimeConfig.selectedPromptConfigs?.dailyReport.templateJson;
  if (!templateJson) {
    template = normalizeDailyReportTemplateConfig(DEFAULT_DAILY_REPORT_TEMPLATE);
  } else {
    try {
      template = parseDailyReportTemplateJson(templateJson);
    } catch (error) {
      let migrationStatus: ReturnType<typeof classifyDailyReportTemplateMigration> = "invalid";
      try {
        migrationStatus = classifyDailyReportTemplateMigration(
          JSON.parse(templateJson) as unknown,
          runtimeConfig.selectedPromptConfigs?.dailyReport.systemPrompt,
        );
      } catch {
        // Keep the original parse error for invalid JSON.
      }
      if (migrationStatus === "custom_legacy_requires_migration") {
        throw new Error("日报模板仍是旧版 opening/sections/closing 结构，请先在 Admin 中迁移为模板 v2。", { cause: error });
      }
      throw error;
    }
  }
  if (!template) throw new Error("日报模板未配置。");
  const templateSignature = getDailyReportTemplateSignature(template);
  const generationSignature = buildDailyReportGenerationSignature({
    runtimeConfig,
    templateSignature,
    planningBatchSize: schedule.dailyReportPlanningBatchSize ?? null,
    recentTopicLookbackDays,
  });
  const inputHash = buildInputHash(date, candidates, dailyReportChannelIds, recentTopics, generationSignature);
  const existing = await prisma.dailyReport.findUnique({
    where: {
      date_timezone: {
        date,
        timezone: DAILY_REPORT_TIMEZONE,
      },
    },
  });

  const reviewRecoveryCheckpoint = input.resumeCheckpoint?.resumeFrom === "review"
    ? input.resumeCheckpoint
    : null;
  let effectiveResumeCheckpoint = input.resumeCheckpoint;
  let reviewRecoveryContextReady = false;
  if (reviewRecoveryCheckpoint && existing) {
    let persistedContent: DailyReportContent | null = null;
    try {
      persistedContent = normalizeDailyReportContent(JSON.parse(existing.summaryJson));
    } catch {
      persistedContent = null;
    }

    let persistedSnapshot: unknown = reviewRecoveryCheckpoint.candidateSnapshot;
    if (persistedSnapshot === undefined && existing.candidateSnapshot) {
      try {
        persistedSnapshot = JSON.parse(existing.candidateSnapshot);
      } catch {
        persistedSnapshot = null;
      }
    }
    const snapshot = parseDailyReportCandidateSnapshot(persistedSnapshot);
    const planningCandidateBriefs = Array.isArray(reviewRecoveryCheckpoint.planningCandidateBriefs)
      ? reviewRecoveryCheckpoint.planningCandidateBriefs as Awaited<ReturnType<typeof buildDailyReportCandidateBriefs>>
      : [];
    if (persistedContent && snapshot.length > 0 && planningCandidateBriefs.length > 0) {
      const persistedSources = await prisma.dailyReportSource.findMany({
        where: { dailyReportId: existing.id },
        select: {
          sourceNumber: true,
          sourceKey: true,
          itemId: true,
          clusterId: true,
          sourceName: true,
          title: true,
          url: true,
          sourceSummary: true,
          sourcePublishedAt: true,
          sourceQualityScore: true,
          eventType: true,
          eventSubject: true,
          eventAction: true,
          eventObject: true,
          eventDate: true,
        },
      });
      const recoveryCandidates = buildDailyReportRecoveryCandidates({
        snapshot,
        planningCandidateBriefs,
        currentCandidates: candidates,
        persistedSources,
      });
      const recoveryPlan = buildDailyReportRecoveryPlan(persistedContent, template);
      rawCandidates = recoveryCandidates;
      candidates = recoveryCandidates;
      excludedRecentDuplicates = buildDailyReportExcludedRecentDuplicateSnapshots(rawCandidates, recentSources);
      effectiveResumeCheckpoint = {
        ...reviewRecoveryCheckpoint,
        plan: recoveryPlan,
        draft: persistedContent,
        completedStages: [...new Set([
          ...reviewRecoveryCheckpoint.completedStages,
          "prepare",
          "assess",
          "merge",
          "plan",
          "plan_validate",
          "write",
          "validate",
        ])],
        data: {
          ...(reviewRecoveryCheckpoint.data ?? {}),
          reviewRecoverySource: "persisted_daily_report",
        },
      };
      reviewRecoveryContextReady = true;
    }
  }
  await input.onCandidatesLoaded?.(candidates.length);
  await input.onStageUpdate?.("prepare");

  if (existing && existing.inputHash === inputHash && !input.force) {
    return {
      report: existing,
      skipped: true,
      reason: "日报输入未变化，已跳过生成。",
      candidateCount: candidates.length,
      selectedCount: await countExistingSelectedDailyReportCandidates(existing.id),
      planningCandidateCount: 0,
      mergedTopicCount: 0,
      planSectionCount: 0,
      planTopicCount: 0,
      planSelectedCount: 0,
      planViolationCount: 0,
      repairCount: 0,
      writeRetryCount: 0,
      partial: false,
      omittedTopicIds: [],
      historyFilteredCount: 0,
      batchCount: 0,
      batchSize: schedule.dailyReportPlanningBatchSize ?? null,
      reviewStatus: "disabled" as const,
      reviewAttempts: 0,
      aiUsage: { actual: 0, estimated: 0, breakdown: [] },
    };
  }

  if (candidates.length < MIN_CANDIDATE_COUNT) {
    return {
      report: null,
      skipped: true,
      reason: `候选内容不足 ${MIN_CANDIDATE_COUNT} 条，已跳过生成。`,
      candidateCount: candidates.length,
      selectedCount: 0,
      planningCandidateCount: 0,
      mergedTopicCount: 0,
      planSectionCount: 0,
      planTopicCount: 0,
      planSelectedCount: 0,
      planViolationCount: 0,
      repairCount: 0,
      writeRetryCount: 0,
      partial: false,
      omittedTopicIds: [],
      historyFilteredCount: 0,
      batchCount: 0,
      batchSize: schedule.dailyReportPlanningBatchSize ?? null,
      reviewStatus: "disabled" as const,
      reviewAttempts: 0,
      aiUsage: { actual: 0, estimated: 0, breakdown: [] },
    };
  }

  // Track every AI call made during generation (main call + repair fallback)
  // so the background task run records accurate `aiCallCountActual` / breakdown.
  const aiUsage = createTaskAiUsageTracker(0, "daily_report_assess");
  const baseProvider = createAiProvider(runtimeConfig.modelApi, runtimeConfig.selectedPromptConfigs, undefined, {
    onUsage: (usage, usageKey) => aiUsage.addUsageByKey(usageKey, usage),
  });
  const provider = aiUsage.wrapProvider(baseProvider);
  let content: DailyReportContent;
  let finalizationPlan: DailyReportPlan | null = null;
  let finalizationPlanningCandidates: DailyReportPlanningCandidate[] = [];
  let finalizationSelectedCandidates: DailyReportPlanningCandidate[] = [];
  let finalizationSelectedTopics: ReturnType<typeof buildDailyReportSelectedTopics> = [];
  let finalizationCandidateBriefs: Awaited<ReturnType<typeof buildDailyReportCandidateBriefs>> = [];
  let finalizationTemplate: ReturnType<typeof normalizeDailyReportTemplateConfig> | null = null;
  finalizationTemplate = template;
  let planningBatchCount = 0;
  let planningCandidateCount = 0;
  let mergedTopicCount = 0;
  let planSectionCount = 0;
  let planTopicCount = 0;
  let planSelectedCount = 0;
  let planViolationCount = 0;
  let repairCount = 0;
  let writeRetryCount = 0;
  let historyFilteredCount = 0;
  let validationViolationCount = 0;
  let partial = false;
  let omittedTopicIds = new Set<string>();
  let latestCheckpoint: TaskPipelineCheckpoint | null = effectiveResumeCheckpoint ?? null;
  const stageAttempts: Record<string, number> = { ...(effectiveResumeCheckpoint?.stageAttempts ?? {}) };
  let currentStage: DailyReportPipelineStage = "prepare";
  let currentBatchIndex: number | null = null;
  let currentAttemptKey = "PREPARE";
  let currentStageContext: DailyReportStageContext | null = null;
  let latestPlanAttempt: DailyReportPlan | null = null;
  let latestPlanViolations: ReturnType<typeof validateDailyReportPlan> | null = null;
  let latestPlanningAudit: DailyReportPlanningAudit | null = null;
  let planOverflowFeedbackUsed = false;
  let reviewStatus: DailyReportReviewStatus = runtimeConfig.selectedPromptConfigs?.dailyReportReview?.enabled
    ? "unavailable"
    : "disabled";
  let reviewAttempts = 0;
  let reviewRetryStage: "plan" | "write" | null = null;
  let reviewViolations: DailyReportReviewViolation[] = [];
  let reviewAudit: Record<string, unknown> | null = null;
  const buildFailureCheckpoint = (error: unknown) => {
    if (!latestCheckpoint) return null;
    const contextOverflow = isDailyReportContextOverflowError(error);
    const matrixStage = currentAttemptKey.startsWith("ASSESS.") ? "ASSESS" : currentAttemptKey;
    const maxAttempts = getDailyReportAttemptLimit(matrixStage);
    const currentAttempt = stageAttempts[currentAttemptKey] ?? 0;
    const assessmentBatches = latestCheckpoint.assessmentBatches?.map((batch) =>
      currentBatchIndex === batch.index
        ? { ...batch, status: "failed" as const, attempt: currentAttempt, error: error instanceof Error ? error.message : String(error) }
        : batch,
    );
    const planFailureContext = currentStage === "plan" || currentStage === "plan_validate"
      ? {
          ...(latestPlanAttempt ? { plan: latestPlanAttempt } : {}),
          ...(latestPlanningAudit ? { planningAudit: latestPlanningAudit } : {}),
          ...(latestPlanViolations ? { violations: latestPlanViolations } : {}),
        }
      : {};
    return {
      ...latestCheckpoint,
      stage: currentStage,
      failedStage: currentStage,
      failureCode: contextOverflow ? "context_overflow" : "stage_failed",
      resumeEligible: !contextOverflow && currentAttempt < maxAttempts,
      stageAttempts: { ...stageAttempts },
      ...(currentStageContext ? { stageLoop: currentStageContext } : latestCheckpoint.stageLoop ? { stageLoop: latestCheckpoint.stageLoop } : {}),
      ...(assessmentBatches ? { assessmentBatches } : {}),
      ...planFailureContext,
      data: {
        ...(latestCheckpoint.data ?? {}),
        writeRetryCount,
      },
    } satisfies TaskPipelineCheckpoint;
  };
  const buildCancellationCheckpoint = () => {
    if (!latestCheckpoint) return null;
    const assessmentBatches = latestCheckpoint.assessmentBatches?.map((batch) =>
      currentBatchIndex === batch.index && batch.status !== "succeeded"
        ? { ...batch, status: "failed" as const, error: TASK_RUN_CANCELLED_MESSAGE }
        : batch,
    );
    return {
      ...latestCheckpoint,
      stage: currentStage,
      failedStage: currentStage,
      failureCode: "cancelled",
      resumeEligible: true,
      stageAttempts: { ...stageAttempts },
      ...(currentStageContext ? { stageLoop: currentStageContext } : latestCheckpoint.stageLoop ? { stageLoop: latestCheckpoint.stageLoop } : {}),
      ...(assessmentBatches ? { assessmentBatches } : {}),
      data: {
        ...(latestCheckpoint.data ?? {}),
        writeRetryCount,
      },
    } satisfies TaskPipelineCheckpoint;
  };
  const throwIfCancellationRequested = async () => {
    if (input.taskRunId && await isTaskRunCancellationRequested(input.taskRunId)) {
      throw new DailyReportCancellationError(aiUsage.snapshot(), buildCancellationCheckpoint());
    }
  };
  const saveCheckpoint = async (checkpoint: TaskPipelineCheckpoint) => {
    const resumeFrom = checkpoint.resumeFrom ?? latestCheckpoint?.resumeFrom;
    const checkpointWithRecovery = resumeFrom
      ? {
          ...checkpoint,
          resumeFrom,
          data: {
            ...(checkpoint.data ?? {}),
            manualRetryFrom: resumeFrom,
          },
        }
      : checkpoint;
    latestCheckpoint = checkpointWithRecovery;
    await input.onCheckpoint?.(checkpointWithRecovery);
    await throwIfCancellationRequested();
  };
  const persistStageLoopContext = async (context: DailyReportStageContext) => {
    currentStageContext = context;
    currentStage = context.stage;
    currentAttemptKey = context.stage.toUpperCase();
    stageAttempts[currentAttemptKey] = context.cleanRetryAttempt + 1;
    if (!latestCheckpoint) return;
    await saveCheckpoint({
      ...latestCheckpoint,
      stage: context.stage,
      failedStage: null,
      failureCode: null,
      resumeEligible: true,
      stageAttempts: { ...stageAttempts },
      stageLoop: context,
      data: {
        ...(latestCheckpoint.data ?? {}),
        [`${context.stage}RepairRound`]: context.repairRound,
        [`${context.stage}CleanRetryCount`]: context.cleanRetryAttempt,
        ...(context.contextOverflow ? { contextOverflowStage: context.stage } : {}),
      },
    });
  };
  const runStageWithAttempts = async <T>(
    stage: DailyReportPipelineStage,
    operation: (attempt: number) => Promise<T>,
    options: { attemptKey?: string; matrixStage?: string } = {},
  ) => {
    const matrixStage = options.matrixStage ?? stage.toUpperCase();
    const attemptKey = options.attemptKey ?? matrixStage;
    const maxAttempts = getDailyReportAttemptLimit(matrixStage);
    let lastError: unknown = null;
    const firstAttempt = (stageAttempts[attemptKey] ?? 0) + 1;
    currentStage = stage;
    currentAttemptKey = attemptKey;
    for (let attempt = firstAttempt; attempt <= maxAttempts; attempt += 1) {
      stageAttempts[attemptKey] = attempt;
      try {
        await throwIfCancellationRequested();
        const result = await operation(attempt);
        await throwIfCancellationRequested();
        return result;
      } catch (error) {
        if (error instanceof DailyReportCancellationError) throw error;
        await throwIfCancellationRequested();
        lastError = error;
        if (isDailyReportContextOverflowError(error) || attempt === maxAttempts) break;
        console.warn(`[daily-report] ${stage} attempt ${attempt} failed; retrying same input`, error);
      }
    }
    const stageError = lastError instanceof Error ? lastError : new Error(`${stage} 阶段失败。`);
    throw new DailyReportGenerationError(stageError, aiUsage.snapshot(), buildFailureCheckpoint(stageError));
  };
  const assessments: DailyReportCandidateAssessment[] = [];
  try {
    const planningCandidates = candidates.map(toDailyReportPlanningCandidate);
    finalizationPlanningCandidates = planningCandidates;
    const batchSize = schedule.dailyReportPlanningBatchSize ?? null;
    const batches = splitDailyReportCandidates(planningCandidates, batchSize);
    planningBatchCount = batches.length;
    const candidateSnapshotHash = createHash("sha256").update(JSON.stringify(candidates.map(toCandidateSnapshotEntry))).digest("hex");
    const checkpoint = effectiveResumeCheckpoint;
    const canResume = Boolean(
      checkpoint?.resumeEligible &&
      (
        (checkpoint.inputHash === inputHash && checkpoint.candidateSnapshotHash === candidateSnapshotHash)
        || (
          checkpoint.resumeFrom === "review"
          && reviewRecoveryContextReady
          && checkpoint.templateSignature === templateSignature
          && checkpoint.pipelineVersion === DAILY_REPORT_PIPELINE_VERSION
        )
      ) &&
      checkpoint.templateSignature === templateSignature &&
      checkpoint.pipelineVersion === DAILY_REPORT_PIPELINE_VERSION,
    );
    if (checkpoint && !canResume) {
      throw new DailyReportGenerationError(
        new Error("日报输入、模板或 Pipeline 版本已变化，旧 checkpoint 不可继续执行，请重新生成。"),
        aiUsage.snapshot(),
        {
          ...checkpoint,
          stage: "prepare",
          failedStage: "prepare",
          failureCode: "checkpoint_mismatch",
          resumeEligible: false,
        },
      );
    }
    await saveCheckpoint({
      version: 1,
      pipelineVersion: DAILY_REPORT_PIPELINE_VERSION,
      stage: "prepare",
      completedStages: canResume ? checkpoint?.completedStages ?? ["prepare"] : ["prepare"],
      lastCompletedStage: "prepare",
      failedStage: null,
      failureCode: null,
      resumeAttempt: checkpoint?.resumeAttempt ?? 0,
      stageAttempts: { ...stageAttempts },
      inputHash,
      templateSignature,
      candidateSnapshotHash,
      candidateSnapshot: candidates.map(toCandidateSnapshotEntry),
      resumeEligible: true,
      data: { batchCount: batches.length, batchSize },
      ...(canResume && checkpoint?.assessmentBatches
        ? { assessmentBatches: checkpoint.assessmentBatches }
        : { assessmentBatches: batches.map((batch, index) => ({ index, candidateIds: batch.map((candidate) => candidate.id), status: "pending" as const, attempt: 0 })) }),
      ...(canResume && checkpoint?.ledger ? { ledger: checkpoint.ledger } : {}),
      ...(canResume && checkpoint?.planningAudit ? { planningAudit: checkpoint.planningAudit } : {}),
      ...(canResume && checkpoint?.planningCandidateBriefs ? { planningCandidateBriefs: checkpoint.planningCandidateBriefs } : {}),
      ...(canResume && checkpoint?.plan ? { plan: checkpoint.plan } : {}),
      ...(canResume && checkpoint?.draft ? { draft: checkpoint.draft } : {}),
    });
    await input.onStageUpdate?.("assess");
    const getHistoryFilteredCount = () => assessments.filter(
      (assessment) => assessment.historyDecision === "duplicate",
    ).length;
    for (const [batchIndex, batch] of batches.entries()) {
      const checkpointBatch = canResume ? checkpoint?.assessmentBatches?.find((entry) => entry.index === batchIndex && entry.status === "succeeded") : null;
      currentBatchIndex = batchIndex;
      const batchAssessments = checkpointBatch?.assessments
        ? validateDailyReportAssessments(batch, checkpointBatch.assessments)
        : validateDailyReportAssessments(
            batch,
            (await runDailyReportStageLoop({
              stage: "assess",
              inputHash: `${candidateSnapshotHash}:assess:${batchIndex}`,
              run: (stageContext, validationFeedback) => provider.assessDailyReportCandidates({
                candidates: batch,
                template,
                recentTopics,
                recentTopicLookbackDays,
                stageContext,
                validationFeedback,
              }),
              validate: (value) => {
                try {
                  validateDailyReportAssessments(batch, value);
                  return [];
                } catch (error) {
                  return [{
                    code: "assess_output_invalid",
                    stage: "assess" as const,
                    message: error instanceof Error ? error.message : String(error),
                  }];
                }
              },
              onContextUpdate: async (context) => {
                stageAttempts[`ASSESS.batch.${batchIndex}`] = context.cleanRetryAttempt + 1;
                await persistStageLoopContext(context);
              },
            })).value,
          );
      currentStageContext = null;
      assessments.push(...batchAssessments);
      historyFilteredCount = getHistoryFilteredCount();
      await saveCheckpoint({
        version: 1,
        pipelineVersion: DAILY_REPORT_PIPELINE_VERSION,
        stage: "assess",
        completedStages: ["prepare", "assess"],
        lastCompletedStage: "assess",
        failedStage: null,
        failureCode: null,
        resumeAttempt: checkpoint?.resumeAttempt ?? 0,
        stageAttempts: { ...stageAttempts },
        inputHash,
        templateSignature: getDailyReportTemplateSignature(template),
        candidateSnapshotHash,
        candidateSnapshot: candidates.map(toCandidateSnapshotEntry),
        resumeEligible: true,
        assessmentBatches: batches.map((currentBatch, index) => ({
          index,
          candidateIds: currentBatch.map((candidate) => candidate.id),
          status: index < batches.indexOf(batch) + 1 ? "succeeded" : "pending",
          attempt: index < batches.indexOf(batch) + 1 ? stageAttempts[`ASSESS.batch.${index}`] ?? 1 : 0,
          ...(index <= batchIndex
            ? { assessments: assessments.filter((assessment) => currentBatch.some((candidate) => candidate.id === assessment.candidateId)) }
            : {}),
        })),
        data: {
          batchCount: batches.length,
          batchSize,
          assessedCount: assessments.length,
          historyFilteredCount: getHistoryFilteredCount(),
        },
      });
    }
    currentBatchIndex = null;
    await input.onStageUpdate?.("merge");
    const ledger = {
      schemaVersion: 1 as const,
      candidateCount: planningCandidates.length,
      assessedCount: assessments.length,
      unassessedCandidateIds: planningCandidates
        .map((candidate) => candidate.id)
        .filter((candidateId) => !assessments.some((assessment) => assessment.candidateId === candidateId)),
      excludedCandidateIds: assessments
        .filter((assessment) => !assessment.isWorthReading)
        .map((assessment) => assessment.candidateId),
      historyFilteredCandidateIds: assessments
        .filter((assessment) => assessment.historyDecision === "duplicate")
        .map((assessment) => assessment.candidateId),
      historyFilteredCount: getHistoryFilteredCount(),
      assessments: assessments.filter((assessment) => assessment.isWorthReading),
      batchCount: batches.length,
      recentTopics,
    };
    const candidateBriefs = canResume && Array.isArray(checkpoint?.planningCandidateBriefs)
      ? checkpoint.planningCandidateBriefs as Awaited<ReturnType<typeof buildDailyReportCandidateBriefs>>
      : buildDailyReportCandidateBriefs(planningCandidates, assessments);
    finalizationCandidateBriefs = candidateBriefs;
    planningCandidateCount = candidateBriefs.length;
    await saveCheckpoint({
      version: 1,
      pipelineVersion: DAILY_REPORT_PIPELINE_VERSION,
      stage: "merge",
      completedStages: ["prepare", "assess", "merge"],
      lastCompletedStage: "merge",
      failedStage: null,
      failureCode: null,
      resumeAttempt: checkpoint?.resumeAttempt ?? 0,
      stageAttempts: { ...stageAttempts },
      inputHash,
      templateSignature: getDailyReportTemplateSignature(template),
      candidateSnapshotHash,
      candidateSnapshot: candidates.map(toCandidateSnapshotEntry),
      resumeEligible: true,
      assessmentBatches: batches.map((batch, index) => ({
        index,
        candidateIds: batch.map((candidate) => candidate.id),
        status: "succeeded" as const,
        attempt: stageAttempts[`ASSESS.batch.${index}`] ?? 1,
        assessments: assessments.filter((assessment) => batch.some((candidate) => candidate.id === assessment.candidateId)),
      })),
      data: {
        batchCount: batches.length,
        batchSize,
        assessedCount: assessments.length,
        historyFilteredCount: getHistoryFilteredCount(),
      },
      ledger,
      planningCandidateBriefs: candidateBriefs,
    });
    await input.onStageUpdate?.("plan");
    const hasCompletedPlan = Boolean(
      canResume
      && checkpoint?.plan
      && (checkpoint.completedStages.includes("plan") || checkpoint.completedStages.includes("plan_validate")),
    );
    let plan: DailyReportPlan;
    if (hasCompletedPlan) {
      plan = checkpoint!.plan as DailyReportPlan;
      latestPlanningAudit = checkpoint?.planningAudit as DailyReportPlanningAudit | null ?? null;
    } else {
      const planLoop = await runDailyReportStageLoop({
        stage: "plan",
        inputHash: `${inputHash}:plan`,
        run: (stageContext, validationFeedback) => provider.planDailyReport({
          candidateBriefs,
          template,
          recentTopics,
          recentTopicLookbackDays,
          stageContext,
          validationFeedback,
        }),
        validate: (rawSelection) => {
          const rawPlan = materializeDailyReportPlan(rawSelection);
          const rawQuantityViolations = validateDailyReportPlanSectionQuantities(rawPlan, template);
          const ordered = orderAndLimitDailyReportPlanWithAudit(
            rawPlan,
            template,
            planningCandidates,
            assessments,
          );
          const violations = validateDailyReportPlan(ordered.plan, planningCandidates, assessments, template);
          const overflowFeedback = rawQuantityViolations.length > 0 && !planOverflowFeedbackUsed
            ? rawQuantityViolations
            : [];
          if (rawQuantityViolations.length > 0) planOverflowFeedbackUsed = true;
          latestPlanAttempt = ordered.plan;
          latestPlanningAudit = ordered.audit;
          latestPlanViolations = [...overflowFeedback, ...violations];
          return latestPlanViolations;
        },
        // The model cannot repair a shortage of eligible candidates: the
        // missing inputs do not exist in the PLAN context. Keep the single
        // clean retry as a fresh-model attempt, but do not spend same-context
        // repair rounds on an impossible minimum-count violation.
        isRepairable: (violations) => !violations.some(
          (violation) => violation.code === "insufficient_required_candidates",
        ),
        onContextUpdate: persistStageLoopContext,
      });
      plan = latestPlanAttempt ?? materializeDailyReportPlan(planLoop.value);
      currentStageContext = null;
    }
    const planViolations = validateDailyReportPlan(plan, planningCandidates, assessments, template);
    planSectionCount = plan.sections.length;
    planTopicCount = getDailyReportPlanTopics(plan).length;
    planSelectedCount = getDailyReportPlanCandidateIds(plan).length;
    mergedTopicCount = getDailyReportPlanTopics(plan).length;
    planViolationCount = planViolations.length;
    if (planViolations.length > 0) {
      throw new Error(`PLAN 校验失败：${planViolations.map((violation) => violation.message).slice(0, 5).join("；")}`);
    }
    await saveCheckpoint({
      version: 1,
      pipelineVersion: DAILY_REPORT_PIPELINE_VERSION,
      stage: "plan",
      completedStages: ["prepare", "assess", "merge", "plan", "plan_validate"],
      lastCompletedStage: "plan",
      failedStage: null,
      failureCode: null,
      resumeAttempt: checkpoint?.resumeAttempt ?? 0,
      stageAttempts: { ...stageAttempts },
      inputHash,
      templateSignature: getDailyReportTemplateSignature(template),
      candidateSnapshotHash,
      candidateSnapshot: candidates.map(toCandidateSnapshotEntry),
      resumeEligible: true,
      data: {
        batchCount: batches.length,
        batchSize,
        assessedCount: assessments.length,
        historyFilteredCount: getHistoryFilteredCount(),
      },
      assessmentBatches: batches.map((batch, index) => ({
        index,
        candidateIds: batch.map((candidate) => candidate.id),
        status: "succeeded" as const,
        attempt: stageAttempts[`ASSESS.batch.${index}`] ?? 1,
        assessments: assessments.filter((assessment) => batch.some((candidate) => candidate.id === assessment.candidateId)),
      })),
      ledger,
      planningCandidateBriefs: candidateBriefs,
      plan,
      ...(latestPlanningAudit ? { planningAudit: latestPlanningAudit } : {}),
      violations: [],
    });
    const selectedIds = new Set(getDailyReportPlanCandidateIds(plan));
    const selectedCandidates = planningCandidates.filter((candidate) => selectedIds.has(candidate.id));
    const selectedTopics = buildDailyReportSelectedTopics(plan, planningCandidates, assessments);
    finalizationPlan = plan;
    finalizationSelectedCandidates = selectedCandidates;
    finalizationSelectedTopics = selectedTopics;
    await input.onStageUpdate?.("write");
    let modelDraft: DailyReportModelDraft | null = null;
    let draft: DailyReportDraft | null = null;
    let draftViolations: ReturnType<typeof validateDailyReportDraft> = [];
    let latestModelDraftForLoop: DailyReportModelDraft | null = null;
    let latestDraftForLoop: DailyReportDraft | null = null;
    let writeLoop: DailyReportStageLoopResult<DailyReportModelDraft> | null = null;
    let writeLoopFailedWithDraft = false;
    let notePatchRepairCount = 0;
    try {
      writeLoop = canResume && checkpoint?.draft
        ? null
        : await runDailyReportStageLoop({
          stage: "write",
          inputHash: `${inputHash}:write`,
          run: (stageContext, validationFeedback) => provider.writeDailyReport({
            selectedTopics,
            template,
            stageContext,
            validationFeedback,
          }),
          validate: (nextModelDraft) => {
            latestModelDraftForLoop = nextModelDraft;
            latestDraftForLoop = normalizeDailyReportDraftForTemplate(
              orderDailyReportDraft(attachDailyReportTopicSources(nextModelDraft, plan), plan, template),
              template,
            );
            const violations = validateDailyReportDraft(latestDraftForLoop, plan, selectedCandidates, template);
            draftViolations = violations;
            validationViolationCount = violations.length;
            return violations;
          },
          stopOnValidation: (violations) => violations.length > 0 && violations.every(isDailyReportNotesRepairableViolation),
          onContextUpdate: async (context) => {
            repairCount = context.repairRound;
            writeRetryCount = context.cleanRetryAttempt;
            await persistStageLoopContext(context);
          },
          });
    } catch (error) {
      if (!(error instanceof DailyReportStageLoopError) || error.stage !== "write" || !latestModelDraftForLoop || !latestDraftForLoop) {
        throw error;
      }
      writeRetryCount = error.cleanRetryCount;
      repairCount = error.context.repairRound;
      currentStageContext = error.context;
      writeLoopFailedWithDraft = true;
      modelDraft = latestModelDraftForLoop;
      draft = latestDraftForLoop;
      draftViolations = validateDailyReportDraft(draft, plan, selectedCandidates, template, omittedTopicIds);
    }

    if (writeLoop) {
      modelDraft = writeLoop.value;
      draft = latestDraftForLoop ?? normalizeDailyReportDraftForTemplate(
        orderDailyReportDraft(attachDailyReportTopicSources(modelDraft, plan), plan, template),
        template,
      );
      draftViolations = validateDailyReportDraft(draft, plan, selectedCandidates, template, omittedTopicIds);
    } else if (!writeLoopFailedWithDraft) {
      modelDraft = toDailyReportModelDraft(checkpoint!.draft as DailyReportModelDraft);
      draft = normalizeDailyReportDraftForTemplate(
        orderDailyReportDraft(attachDailyReportTopicSources(modelDraft, plan), plan, template),
        template,
      );
      draftViolations = validateDailyReportDraft(draft, plan, selectedCandidates, template, omittedTopicIds);
    }
    if (!modelDraft || !draft) {
      throw new Error("WRITE 阶段未生成可校验的日报草稿。");
    }
    validationViolationCount = draftViolations.length;
    const nonRepairableDraftViolations = draftViolations.filter(
      (violation) => !isDailyReportNotesRepairableViolation(violation),
    );
    if (draftViolations.length > 0 && nonRepairableDraftViolations.length === 0) {
      let repairViolations = draftViolations.filter(isDailyReportNotesRepairableViolation);
      while (repairViolations.length > 0 && notePatchRepairCount < 2) {
        notePatchRepairCount += 1;
        repairCount += 1;
        await input.onStageUpdate?.("repair");
        let patchResult;
        try {
          patchResult = await runStageWithAttempts(
            "repair",
            async () => provider.repairDailyReportDraft({
              draft: toDailyReportModelDraft(draft!),
              violations: repairViolations,
              selectedTopics,
              template,
            }),
            {
              attemptKey: `REPAIR.round.${notePatchRepairCount}`,
              matrixStage: "REPAIR",
            },
          );
        } catch {
          break;
        }
        draft = normalizeDailyReportDraftForTemplate(
          orderDailyReportDraft(
            applyDailyReportRepairPatches(draft, patchResult) as DailyReportDraft,
            plan,
            template,
          ),
          template,
        );
        modelDraft = toDailyReportModelDraft(draft);
        draftViolations = validateDailyReportDraft(draft, plan, selectedCandidates, template, omittedTopicIds);
        repairViolations = draftViolations.filter(isDailyReportNotesRepairableViolation);
        validationViolationCount = draftViolations.length;
        if (latestCheckpoint) {
          await saveCheckpoint({
            ...latestCheckpoint,
            stage: "repair",
            completedStages: draftViolations.length > 0
              ? [...new Set([...latestCheckpoint.completedStages, "write", "repair"])]
              : [...new Set([...latestCheckpoint.completedStages, "write", "validate", "repair"])],
            lastCompletedStage: "repair",
            failedStage: null,
            failureCode: null,
            resumeEligible: draftViolations.length === 0,
            stageAttempts: { ...stageAttempts },
            draft: modelDraft,
            violations: draftViolations,
            data: {
              ...(latestCheckpoint.data ?? {}),
              writeRepairRound: repairCount,
              omittedTopicIds: Array.from(omittedTopicIds),
              omittedTopicCount: omittedTopicIds.size,
            },
          });
        }
      }
    }
    if (draftViolations.length > 0) {
      const fallback = omitInvalidOptionalDailyReportTopics(draft, draftViolations, template, omittedTopicIds);
      omittedTopicIds = fallback.omittedTopicIds;
      if (omittedTopicIds.size > 0) {
        partial = true;
        draft = normalizeDailyReportDraftForTemplate(
          orderDailyReportDraft(fallback.draft as DailyReportDraft, plan, template),
          template,
        );
        modelDraft = toDailyReportModelDraft(draft);
        draftViolations = validateDailyReportDraft(draft, plan, selectedCandidates, template, omittedTopicIds);
        validationViolationCount = draftViolations.length;
      }
    }
    if (latestCheckpoint) {
      await saveCheckpoint({
        ...latestCheckpoint,
        stage: "write",
        completedStages: draftViolations.length > 0
          ? [...new Set([...latestCheckpoint.completedStages, "write"])]
          : [...new Set([...latestCheckpoint.completedStages, "write", "validate"])],
        lastCompletedStage: draftViolations.length > 0 ? "write" : "validate",
        failedStage: null,
        failureCode: null,
        resumeEligible: draftViolations.length === 0,
        stageAttempts: { ...stageAttempts },
        stageLoop: undefined,
        draft: modelDraft,
        violations: draftViolations,
        data: {
          ...(latestCheckpoint.data ?? {}),
          writeRetryCount,
          writeRepairRound: repairCount,
          omittedTopicIds: Array.from(omittedTopicIds),
          omittedTopicCount: omittedTopicIds.size,
        },
      });
    }
    if (draftViolations.length === 0) {
      currentStageContext = null;
    }
    if (draftViolations.length > 0) {
      throw new Error(`WRITE 校验失败：${draftViolations.map((violation) => violation.message).slice(0, 5).join("；")}`);
    }
    content = draft;
  } catch (error) {
    if (error instanceof DailyReportGenerationError || error instanceof DailyReportCancellationError) throw error;
    throw new DailyReportGenerationError(error, aiUsage.snapshot(), buildFailureCheckpoint(error));
  }
  assertDailyReportSourceIdsExist(content, candidates.map((candidate) => ({
    sourceNumber: candidate.id,
    sourceKey: buildDailyReportSourceKey(candidate),
    itemId: candidate.itemId,
    clusterId: candidate.clusterId,
    sourceName: candidate.sourceName,
    title: candidate.title,
    url: candidate.url,
    summary: candidate.summary,
    publishedAt: candidate.publishedAt,
    qualityScore: candidate.qualityScore,
    eventType: candidate.eventType,
    eventSubject: candidate.eventSubject,
    eventAction: candidate.eventAction,
    eventObject: candidate.eventObject,
    eventDate: candidate.eventDate,
  })));
  let deduplication: ReturnType<typeof deduplicateDailyReportContentByCandidate>;
  try {
    deduplication = deduplicateDailyReportContentByCandidate(content, finalizationSelectedCandidates, { refillEmptySections: false });
    if (finalizationPlan && finalizationTemplate) {
      currentStage = "validate";
      currentAttemptKey = "VALIDATE";
      const finalViolations = validateDailyReportDraft(
        deduplication.content,
        finalizationPlan,
        finalizationSelectedCandidates,
        finalizationTemplate,
        omittedTopicIds,
      );
      validationViolationCount = finalViolations.length;
      if (finalViolations.length > 0) {
        latestCheckpoint = latestCheckpoint
          ? {
              ...latestCheckpoint,
              stage: "validate",
              failedStage: "validate",
              failureCode: "stage_failed",
              resumeEligible: false,
              violations: finalViolations,
            }
          : latestCheckpoint;
        throw new Error(`日报最终校验失败：${finalViolations.map((violation) => violation.message).slice(0, 5).join("；")}`);
      }
    }
  } catch (error) {
    if (error instanceof DailyReportGenerationError || error instanceof DailyReportCancellationError) throw error;
    throw new DailyReportGenerationError(error, aiUsage.snapshot(), buildFailureCheckpoint(error));
  }
  content = deduplication.content;

  // Reviewer runs after deterministic WRITE validation. A rejection can ask
  // for exactly one intermediate PLAN/WRITE regeneration; a reviewer failure
  // keeps the valid draft but permanently disables automatic publication.
  if (runtimeConfig.selectedPromptConfigs?.dailyReportReview?.enabled && finalizationPlan) {
    currentStage = "review";
    currentAttemptKey = "REVIEW";
    await input.onStageUpdate?.("review");
    const reviewRetryPlanCodes = new Set([
      "coverage_insufficient",
      "candidate_omitted",
      "topic_not_independent",
      "padding_content",
    ]);
    const evaluateReview = async (reviewContent: DailyReportContent) => {
      const normalized = deduplicateDailyReportContentByCandidate(
        reviewContent,
        finalizationSelectedCandidates,
        { refillEmptySections: false },
      ).content;
      const deterministicViolations = validateDailyReportDraft(
        normalized,
        finalizationPlan!,
        finalizationSelectedCandidates,
        template,
        omittedTopicIds,
      );
      if (deterministicViolations.length > 0) {
        throw new Error(`Review 输入日报未通过最终校验：${deterministicViolations.map((violation) => violation.message).slice(0, 5).join("；")}`);
      }
      const coverage = buildDailyReportCandidateCoverage(normalized, candidates);
      const reviewInput = buildDailyReportReviewContext({
        date,
        draft: toDailyReportModelDraft(normalized),
        selectedTopics: finalizationSelectedTopics,
        candidates,
        rawCandidateCount: rawCandidates.length,
        candidateBriefs: finalizationCandidateBriefs,
        historyFilteredCount,
        candidateCoverage: coverage,
        planningAudit: latestPlanningAudit,
        template,
      });
      const result = await runStageWithAttempts(
        "review",
        async () => provider.reviewDailyReport(reviewInput),
        { attemptKey: "REVIEW", matrixStage: "REVIEW" },
      );
      return { content: normalized, coverage, result };
    };
    const firstReview = await (async () => {
      try {
        return await evaluateReview(content);
      } catch (error) {
        reviewAttempts = 1;
        reviewStatus = "unavailable";
        reviewAudit = { attempts: 1, error: error instanceof Error ? error.message : String(error) };
        return null;
      }
    })();

    if (firstReview) {
      reviewAttempts = 1;
      reviewViolations = firstReview.result.violations;
      reviewStatus = firstReview.result.verdict === "pass" ? "passed" : "rejected";
      content = firstReview.content;
      reviewAudit = {
        attempts: 1,
        first: firstReview.result,
        candidateCoverage: firstReview.coverage,
      };

      if (firstReview.result.verdict === "reject") {
        reviewRetryStage = firstReview.result.violations.some((violation) => reviewRetryPlanCodes.has(violation.code))
          ? "plan"
          : "write";
        const reviewFeedback: DailyReportReviewFeedback = {
          violations: firstReview.result.violations,
          instruction: "这是上一次审核发现的问题和修复指导。请优先解决所有 error 级问题，并逐条落实 guidance；只能使用本次重试输入中的候选、主题、模板和事实，不得补造事实。",
        };
        const originalFinalization = {
          plan: finalizationPlan,
          selectedCandidates: finalizationSelectedCandidates,
          selectedTopics: finalizationSelectedTopics,
        };
        try {
          if (reviewRetryStage === "plan") {
            const rawPlan = materializeDailyReportPlan(await provider.planDailyReport({
              candidateBriefs: finalizationCandidateBriefs,
              template,
              recentTopics,
              recentTopicLookbackDays,
              reviewFeedback,
            }));
            const ordered = orderAndLimitDailyReportPlanWithAudit(
              rawPlan,
              template,
              finalizationPlanningCandidates,
              assessments,
            );
            const planViolations = validateDailyReportPlan(
              ordered.plan,
              finalizationPlanningCandidates,
              assessments,
              template,
            );
            if (planViolations.length > 0) {
              throw new Error(`Review 触发的 PLAN 重试未通过校验：${planViolations.map((violation) => violation.message).slice(0, 5).join("；")}`);
            }
            finalizationPlan = ordered.plan;
            latestPlanningAudit = ordered.audit;
            finalizationSelectedCandidates = finalizationPlanningCandidates.filter((candidate) =>
              new Set(getDailyReportPlanCandidateIds(ordered.plan)).has(candidate.id),
            );
            finalizationSelectedTopics = buildDailyReportSelectedTopics(
              ordered.plan,
              finalizationPlanningCandidates,
              assessments,
            );
          }

          const retryModelDraft = await provider.writeDailyReport({
            selectedTopics: finalizationSelectedTopics,
            template,
            reviewFeedback,
          });
          const retryDraft = normalizeDailyReportDraftForTemplate(
            orderDailyReportDraft(
              attachDailyReportTopicSources(retryModelDraft, finalizationPlan),
              finalizationPlan,
              template,
            ),
            template,
          );
          const retryViolations = validateDailyReportDraft(
            retryDraft,
            finalizationPlan,
            finalizationSelectedCandidates,
            template,
            omittedTopicIds,
          );
          if (retryViolations.length > 0) {
            throw new Error(`Review 触发的 WRITE 重试未通过校验：${retryViolations.map((violation) => violation.message).slice(0, 5).join("；")}`);
          }
          const secondReview = await evaluateReview(retryDraft);
          reviewAttempts = 2;
          reviewViolations = secondReview.result.violations;
          reviewStatus = secondReview.result.verdict === "pass" ? "passed" : "rejected";
          content = secondReview.content;
          reviewAudit = {
            ...(reviewAudit ?? {}),
            attempts: 2,
            retryStage: reviewRetryStage,
            second: secondReview.result,
            secondCandidateCoverage: secondReview.coverage,
          };
        } catch (error) {
          // Keep the last deterministic draft, but never let a failed review
          // or review-triggered regeneration reach the auto-publish gate.
          finalizationPlan = originalFinalization.plan;
          finalizationSelectedCandidates = originalFinalization.selectedCandidates;
          finalizationSelectedTopics = originalFinalization.selectedTopics;
          reviewStatus = "unavailable";
          reviewAudit = {
            ...(reviewAudit ?? {}),
            attempts: reviewAttempts,
            retryStage: reviewRetryStage,
            retryError: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    if (latestCheckpoint) {
      await saveCheckpoint({
        ...latestCheckpoint,
        stage: "review",
        completedStages: [...new Set([...latestCheckpoint.completedStages, "review"])],
        lastCompletedStage: "review",
        failedStage: null,
        failureCode: null,
        resumeEligible: reviewStatus === "passed",
        reviewStatus,
        reviewAttempts,
        reviewRetryStage,
        reviewViolations,
        reviewAudit,
        data: {
          ...(latestCheckpoint.data ?? {}),
          reviewAttempts,
          reviewRetryStage,
        },
      });
    }
  }
  const sourceRows = getSectionSourceIds(content);
  const candidateCoverage = buildDailyReportCandidateCoverage(content, candidates);
  if (candidateCoverage.warnings.length > 0) {
    console.warn("[daily-report] candidate coverage warnings:", candidateCoverage.warnings.join(", "));
  }
  const selectedCount = countSelectedDailyReportCandidates(content);
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const excludedAssessDuplicates = buildDailyReportExcludedAssessDuplicateSnapshots(candidates, assessments);
  const expandedSourcesByNumber = await buildExpandedDailyReportSourceRegistry({
    candidatesById,
    sourceRows,
    groupIds: dailyReportSourceGroupIds,
  });
  const title = buildDailyReportTitle(date, content);
  const renderedMarkdown = renderDailyReportMarkdown(
    content,
    candidates,
    title,
    Array.from(expandedSourcesByNumber.values()).flat(),
  );
  const candidateSnapshot = JSON.stringify({
    candidateSource: candidateResult.source,
    candidates: candidates.map(toCandidateSnapshotEntry),
    excludedCurrentDuplicates: deduplicated.duplicates.map((candidate) => ({
      ...toCandidateSnapshotEntry(candidate),
      excludedReason: "当前候选集合内重复",
      matchedRecentDate: null,
      matchedRecentTitle: null,
    })),
    excludedRecentDuplicates,
    excludedAssessDuplicates,
    emptySectionsAfterDeduplication: deduplication.emptySectionTitles,
    refilledEmptySections: deduplication.refilledSectionTitles,
    removedEmptySections: deduplication.removedEmptySectionTitles,
    omittedRepairTopics: Array.from(omittedTopicIds),
    candidateCoverage,
    review: {
      status: reviewStatus,
      attempts: reviewAttempts,
      retryStage: reviewRetryStage,
      violations: reviewViolations,
      audit: reviewAudit,
    },
    candidateCount: candidates.length,
  });
  const shouldAutoPublish = schedule.dailyReportAutoPublish
    && !partial
    && (reviewStatus === "disabled" || reviewStatus === "passed");
  const publishedAt = shouldAutoPublish ? new Date() : null;
  const persistIdempotencyKey = `generated:${input.taskRunId ?? `direct-${Date.now()}`}:${inputHash}`;

  await throwIfCancellationRequested();
  await input.onStageUpdate?.("persist_publish");
  const report = await runStageWithAttempts("persist_publish", async () => persistDailyReport({
    date,
    existing,
    taskRunId: input.taskRunId,
    content,
    title,
    renderedMarkdown,
    inputHash,
    candidateSnapshot,
    modelName: runtimeConfig.modelApi.model,
    templateSignature,
    sourceRows,
    expandedSourcesByNumber,
    shouldAutoPublish,
    publishedAt,
    idempotencyKey: persistIdempotencyKey,
    aiUsage: aiUsage.snapshot(),
    buildCancellationCheckpoint,
  }), { matrixStage: "PERSIST_PUBLISH" });

  invalidateDailyReportCache();

  return {
    report,
    skipped: false,
    reason: null,
    candidateCount: candidates.length,
    selectedCount,
    planningCandidateCount,
    batchCount: planningBatchCount,
    mergedTopicCount,
    planSectionCount,
    planTopicCount,
    planSelectedCount,
    planViolationCount,
    repairCount,
    writeRetryCount,
    partial,
    omittedTopicIds: Array.from(omittedTopicIds),
    historyFilteredCount,
    validationViolationCount,
    reviewStatus,
    reviewAttempts,
    reviewRetryStage,
    reviewViolations,
    reviewAudit,
    batchSize: schedule.dailyReportPlanningBatchSize ?? null,
    aiUsage: aiUsage.snapshot(),
  };
}

export async function generateDailyReport(input: {
  date: string;
  taskRunId?: string | null;
  force?: boolean;
  onCandidatesLoaded?: (candidateCount: number) => Promise<void>;
  onStageUpdate?: (stage: DailyReportPipelineStage) => Promise<void>;
  onCheckpoint?: (checkpoint: TaskPipelineCheckpoint) => Promise<void>;
  resumeCheckpoint?: TaskPipelineCheckpoint | null;
}) {
  const normalizedDate = normalizeDailyReportDate(input.date);
  return withDailyReportLock(normalizedDate, "generate", async ({ assertLock }) => {
    return generateDailyReportInternal({
      ...input,
      onCandidatesLoaded: async (candidateCount) => {
        await assertLock();
        await input.onCandidatesLoaded?.(candidateCount);
      },
      onStageUpdate: async (stage) => {
        await assertLock();
        await input.onStageUpdate?.(stage);
      },
      onCheckpoint: async (checkpoint) => {
        await assertLock();
        await input.onCheckpoint?.(checkpoint);
      },
    });
  });
}

export async function executeDailyReportTask(taskRun: BackgroundTaskRun) {
  const date = taskRun.entityId && /^\d{4}-\d{2}-\d{2}$/.test(taskRun.entityId)
    ? taskRun.entityId
    : getTodayDailyReportDate();
  let candidateCount = 0;
  let historyFilteredCount = 0;
  let planningCandidateCount = 0;
  let planSectionCount = 0;
  let planTopicCount = 0;
  let planSelectedCount = 0;
  let planTruncatedTopicCount = 0;
  let planningAudit: DailyReportPlanningAudit | null = null;
  let planViolationCount = 0;
  let assessRepairCount = 0;
  let assessRetryCount = 0;
  let planRepairCount = 0;
  let planRetryCount = 0;
  let writeRepairCount = 0;
  let repairCount = 0;
  let writeRetryCount = 0;
  let validationViolationCount = 0;
  const contextOverflowStages = new Set<string>();
  let omittedTopicCount = 0;
  let batchCount = 0;
  let batchSize: number | null = null;
  let reviewStatus: DailyReportReviewStatus = "disabled";
  let reviewAttempts = 0;
  let reviewRetryCount = 0;
  let activeStage: DailyReportPipelineStage | null = "prepare";
  let resumeCheckpoint: TaskPipelineCheckpoint | null = null;
  if (taskRun.pipelineCheckpointJson) {
    const parsed = parseTaskPipelineCheckpointJson(taskRun.pipelineCheckpointJson);
    if (parsed?.resumeEligible) resumeCheckpoint = parsed;
  }

  try {
    await updateTaskRun(taskRun.id, {
      status: "running",
      progressCurrent: 0,
      progressTotal: 1,
      progressLabel: `正在生成 ${date} AI 日报`,
      taskTimeline: buildDailyReportTaskTimeline({
        taskRun,
        status: "running",
        activeStage,
      }),
      aiCallCountEstimated: 1,
      aiCallBreakdown: [
        { key: "daily_report_assess", label: "评估", actual: 0, estimated: 1 } as TaskAiCallBreakdownSnapshot,
      ],
    });

    const result = await generateDailyReport({
      date,
      taskRunId: taskRun.id,
      force: taskRun.triggerType !== "scheduled",
      onCandidatesLoaded: async (loadedCandidateCount) => {
        candidateCount = loadedCandidateCount;
        await updateTaskRun(taskRun.id, {
          taskTimeline: buildDailyReportTaskTimeline({
            taskRun,
            status: "running",
            candidateCount,
            historyFilteredCount,
            batchCount,
            batchSize,
            activeStage,
          }),
        });
      },
      onStageUpdate: async (stage) => {
        activeStage = normalizeDailyReportTimelineStage(stage);
        await updateTaskRun(taskRun.id, {
          taskTimeline: buildDailyReportTaskTimeline({
            taskRun,
            status: "running",
            candidateCount,
            historyFilteredCount,
            batchCount,
            batchSize,
          activeStage,
          assessRepairCount,
          assessRetryCount,
          planRepairCount,
          planRetryCount,
          writeRepairCount,
          contextOverflowCount: contextOverflowStages.size,
        }),
        });
      },
      onCheckpoint: async (checkpoint) => {
        if (typeof checkpoint.data?.batchCount === "number") batchCount = checkpoint.data.batchCount;
        if (typeof checkpoint.data?.historyFilteredCount === "number") historyFilteredCount = checkpoint.data.historyFilteredCount;
        if (checkpoint.data && Object.prototype.hasOwnProperty.call(checkpoint.data, "batchSize")) {
          batchSize = typeof checkpoint.data.batchSize === "number" ? checkpoint.data.batchSize : null;
        }
        const checkpointPlan = checkpoint.plan as DailyReportPlan | undefined;
        if (Array.isArray(checkpoint.planningCandidateBriefs)) {
          planningCandidateCount = checkpoint.planningCandidateBriefs.length;
        }
        if (checkpointPlan?.sections) {
          planSectionCount = checkpointPlan.sections.length;
          planTopicCount = getDailyReportPlanTopics(checkpointPlan).length;
          planSelectedCount = getDailyReportPlanCandidateIds(checkpointPlan).length;
          planViolationCount = checkpoint.violations?.length ?? 0;
        }
        if (checkpoint.stageLoop) {
          const stageLoop = checkpoint.stageLoop;
          if (stageLoop.stage === "assess") {
            assessRepairCount = stageLoop.repairRound;
            assessRetryCount = stageLoop.cleanRetryAttempt;
          } else if (stageLoop.stage === "plan") {
            planRepairCount = stageLoop.repairRound;
            planRetryCount = stageLoop.cleanRetryAttempt;
          } else if (stageLoop.stage === "write") {
            writeRepairCount = stageLoop.repairRound;
            repairCount = stageLoop.repairRound;
            writeRetryCount = stageLoop.cleanRetryAttempt;
          }
          if (stageLoop.contextOverflow) contextOverflowStages.add(stageLoop.stage);
        }
        const checkpointPlanningAudit = checkpoint.planningAudit as DailyReportPlanningAudit | undefined;
        if (checkpointPlanningAudit && typeof checkpointPlanningAudit.truncatedTopicCount === "number") {
          planningAudit = checkpointPlanningAudit;
          planTruncatedTopicCount = checkpointPlanningAudit.truncatedTopicCount;
        }
        if (checkpoint.stage === "write" || checkpoint.stage === "validate" || checkpoint.stage === "repair") {
          validationViolationCount = checkpoint.violations?.length ?? 0;
        }
        if (typeof checkpoint.data?.omittedTopicCount === "number") {
          omittedTopicCount = checkpoint.data.omittedTopicCount;
        }
        if (typeof checkpoint.data?.writeRetryCount === "number") {
          writeRetryCount = checkpoint.data.writeRetryCount;
        }
        if (checkpoint.reviewStatus) reviewStatus = checkpoint.reviewStatus;
        if (typeof checkpoint.reviewAttempts === "number") reviewAttempts = checkpoint.reviewAttempts;
        if (typeof checkpoint.stageAttempts?.REVIEW === "number") {
          reviewRetryCount = Math.max(0, checkpoint.stageAttempts.REVIEW - 1);
        }
        await updateTaskRun(taskRun.id, { pipelineCheckpoint: checkpoint });
        resumeCheckpoint = checkpoint;
      },
      resumeCheckpoint,
    });

    const finishedAt = new Date();
    const finalAiUsage = result.aiUsage;
    reviewStatus = result.reviewStatus;
    reviewAttempts = result.reviewAttempts;
    const finalStatus = result.partial || reviewStatus === "rejected" || reviewStatus === "unavailable"
      ? "partial"
      : "succeeded";
    omittedTopicCount = result.omittedTopicIds.length;
    const completionIssueSummary = getDailyReportFailureSummary({
      status: result.reviewStatus,
      audit: result.reviewAudit,
      violations: result.reviewViolations,
      partial: result.partial,
      omittedTopicCount,
    });
    const totalActual = result.skipped ? 0 : finalAiUsage.actual;
    const totalEstimated = finalAiUsage.estimated;
    // Always include the first concrete daily-report stage so the breakdown is
    // non-empty when the task runs at all, even if the call count is zero.
    const finalBreakdown: TaskAiCallBreakdownSnapshot[] = result.skipped
      ? [{ key: "daily_report_assess", label: "评估", actual: 0, estimated: totalEstimated }]
      : finalAiUsage.breakdown.some((entry) => entry.key.startsWith("daily_report_") || entry.key === "daily_report")
        ? finalAiUsage.breakdown
        : [{ key: "daily_report_assess", label: "评估", actual: totalActual, estimated: totalEstimated }];
    const completedCheckpoint = resumeCheckpoint
      && resumeCheckpoint.resumeEligible
      && getDailyReportRecoveryStages(resumeCheckpoint).length > 0
      ? {
          ...resumeCheckpoint,
          stage: "validate",
          lastCompletedStage: "validate",
          failedStage: null,
          failureCode: null,
          resumeEligible: true,
          stageLoop: undefined,
        }
      : null;
    const finalPipelineCheckpoint = completedCheckpoint
      ?? (resumeCheckpoint?.reviewStatus ? resumeCheckpoint : null);
    await updateTaskRun(taskRun.id, {
      status: finalStatus,
      progressCurrent: 1,
      progressTotal: 1,
      progressLabel: result.skipped
        ? result.reason
        : `已生成 ${date} AI 日报${result.report?.status === "published" ? "并发布" : "草稿"}${result.partial ? "（部分条目因校验失败被剔除）" : ""}`,
      errorSummary: completionIssueSummary,
      aiCallCountActual: totalActual,
      aiCallCountEstimated: totalEstimated,
      aiCallBreakdown: finalBreakdown,
      taskTimeline: buildDailyReportTaskTimeline({
        taskRun,
        status: result.skipped ? "skipped" : finalStatus,
        candidateCount: result.candidateCount,
        historyFilteredCount: result.historyFilteredCount,
        selectedCount: result.selectedCount,
        planningCandidateCount: result.planningCandidateCount,
        planSectionCount: result.planSectionCount,
        planTopicCount: result.planTopicCount,
        planSelectedCount: result.planSelectedCount,
        planTruncatedTopicCount,
        planningAudit,
        planViolationCount: result.planViolationCount,
        validationViolationCount: result.validationViolationCount,
        assessRepairCount,
        assessRetryCount,
        planRepairCount,
        planRetryCount,
        writeRepairCount,
        writeRetryCount: result.writeRetryCount,
        repairCount: result.repairCount,
        contextOverflowCount: contextOverflowStages.size,
        omittedTopicCount,
        reviewStatus,
        reviewAttempts,
        reviewRetryCount,
        batchCount: result.batchCount,
        batchSize: result.batchSize,
        activeStage: result.skipped ? null : "persist_publish",
        finishedAt,
      }),
      // Keep the final planning inputs and plan so a completed report can be
      // regenerated from ASSESS/PLAN/WRITE as a new task.
      pipelineCheckpoint: finalPipelineCheckpoint,
      finishedAt,
    });
    await markDailyScheduleRunFinished(taskRun, finalStatus);
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 日报生成失败。";
    const cancelled = error instanceof DailyReportCancellationError;
    const failedAiUsage = error instanceof DailyReportGenerationError || cancelled ? error.aiUsage : null;
    const failedCheckpoint = error instanceof DailyReportGenerationError || cancelled ? error.checkpoint : null;
    if (failedCheckpoint?.failedStage) activeStage = normalizeDailyReportTimelineStage(failedCheckpoint.failedStage);
    if (failedCheckpoint?.data && typeof failedCheckpoint.data.batchCount === "number") batchCount = failedCheckpoint.data.batchCount;
    if (failedCheckpoint?.data && typeof failedCheckpoint.data.historyFilteredCount === "number") {
      historyFilteredCount = failedCheckpoint.data.historyFilteredCount;
    }
    if (failedCheckpoint?.data && Object.prototype.hasOwnProperty.call(failedCheckpoint.data, "batchSize")) {
      batchSize = typeof failedCheckpoint.data.batchSize === "number" ? failedCheckpoint.data.batchSize : null;
    }
    if (failedCheckpoint?.data && typeof failedCheckpoint.data.omittedTopicCount === "number") {
      omittedTopicCount = failedCheckpoint.data.omittedTopicCount;
    }
    if (failedCheckpoint?.data && typeof failedCheckpoint.data.writeRetryCount === "number") {
      writeRetryCount = failedCheckpoint.data.writeRetryCount;
    }
    if (failedCheckpoint?.stageLoop) {
      const stageLoop = failedCheckpoint.stageLoop;
      if (stageLoop.stage === "assess") {
        assessRepairCount = stageLoop.repairRound;
        assessRetryCount = stageLoop.cleanRetryAttempt;
      } else if (stageLoop.stage === "plan") {
        planRepairCount = stageLoop.repairRound;
        planRetryCount = stageLoop.cleanRetryAttempt;
      } else if (stageLoop.stage === "write") {
        writeRepairCount = stageLoop.repairRound;
        repairCount = stageLoop.repairRound;
        writeRetryCount = stageLoop.cleanRetryAttempt;
      }
      if (stageLoop.contextOverflow) contextOverflowStages.add(stageLoop.stage);
    }
    const failedPlan = failedCheckpoint?.plan as DailyReportPlan | undefined;
    if (failedPlan?.sections) {
      planSectionCount = failedPlan.sections.length;
      planTopicCount = getDailyReportPlanTopics(failedPlan).length;
      planSelectedCount = getDailyReportPlanCandidateIds(failedPlan).length;
      planViolationCount = failedCheckpoint?.violations?.length ?? 0;
    }
    const failedPlanningAudit = failedCheckpoint?.planningAudit as DailyReportPlanningAudit | undefined;
    if (failedPlanningAudit && typeof failedPlanningAudit.truncatedTopicCount === "number") {
      planningAudit = failedPlanningAudit;
      planTruncatedTopicCount = failedPlanningAudit.truncatedTopicCount;
    }
    const finishedAt = new Date();
    await updateTaskRun(taskRun.id, {
      status: cancelled ? "cancelled" : "failed",
      progressLabel: cancelled ? TASK_RUN_CANCELLED_LABEL : message,
      errorSummary: cancelled ? TASK_RUN_CANCELLED_MESSAGE : message,
      ...(failedAiUsage ? {
        aiCallCountActual: failedAiUsage.actual,
        aiCallCountEstimated: failedAiUsage.estimated,
        aiCallBreakdown: failedAiUsage.breakdown,
      } : {}),
      taskTimeline: buildDailyReportTaskTimeline({
        taskRun,
        status: cancelled ? "cancelled" : "failed",
        candidateCount,
        historyFilteredCount,
        planningCandidateCount,
        planSectionCount,
        planTopicCount,
        planSelectedCount,
        planTruncatedTopicCount,
        planningAudit,
        planViolationCount,
        validationViolationCount,
        assessRepairCount,
        assessRetryCount,
        planRepairCount,
        planRetryCount,
        writeRepairCount,
        writeRetryCount,
        repairCount,
        contextOverflowCount: contextOverflowStages.size,
        omittedTopicCount,
        batchCount,
        batchSize,
        activeStage,
        finishedAt,
      }),
      ...(failedCheckpoint ? { pipelineCheckpoint: failedCheckpoint } : {}),
      finishedAt,
    });
    await markDailyScheduleRunFinished(taskRun, cancelled ? "cancelled" : "failed");
  }
}

