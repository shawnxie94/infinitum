import type {
  TaskStageTimingSnapshot,
  TaskTimelineNodeSnapshot,
  TaskTimelineNodeStatus,
} from "@/lib/tasks/types";

export type IngestionStageTiming = {
  key: string;
  label: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
};

export type IngestionTimelineCounters = {
  sourceFetch: {
    sourcesFetched: number;
    sourcesFailed: number;
    itemsFetched: number;
    fullTextFetched: number;
    fullTextFetchAttempted: number;
    fullTextFetchRssHtml: number;
    fullTextFetchShortContent: number;
    fullTextFetchLocalAttempted: number;
    fullTextFetchJinaAttempted: number;
    fullTextFetchLocalUsed: number;
    fullTextFetchJinaUsed: number;
    fullTextFetchDurationMs: number;
  };
  ruleFilter: {
    ruleFiltered: number;
    reusedExisting: number;
    durationMs: number;
    itemTotalDurationMs: number;
    dbWriteDurationMs: number;
  };
  itemSummary: {
    completed: number;
    failed: number;
  };
  aggregationParsing: {
    parsed: number;
    failed: number;
    events: number;
  };
  itemAnalysis: {
    completed: number;
    failed: number;
    filtered: number;
    updatedExisting: number;
    durationMs: number;
  };
  clusterAssignment: {
    exactMatch: number;
    cheapRankDirect: number;
    aiMatch: number;
    skippedIncompleteSignature: number;
    newCluster: number;
    durationMs: number;
  };
  clusterMerge: {
    baseClusters: number;
    candidates: number;
    totalPairs: number;
    rejectedObjectConflict: number;
    rejectedDateConflict: number;
    rejectedNoEventAnchor: number;
    belowGrayScore: number;
    relatedPairs: number;
    aiEligiblePairs: number;
    cleanPairsSkipped: number;
    precomputedCleanPairsUsed: number;
    precomputedCleanPairsAttemptSkipped: number;
    precomputedCleanPairsInvalidSkipped: number;
    blockedByCannotLink: number;
    blockedByDeclinedDecision: number;
    decisionsApproved: number;
    decisionsDeclined: number;
    decisionsAmbiguous: number;
    decisionsFailed: number;
    dirtyPairs: number;
    preLimitCandidates: number;
    postLimitCandidates: number;
    dirtyCandidates: number;
    aiMergeGroups: number;
    skipped: boolean;
    merged: number;
    itemsMoved: number;
    failedGroups: number;
    refreshItemCountsMs: number;
    loadClustersMs: number;
    candidateSelectionMs: number;
    promptBuildMs: number;
    promptChars: number;
    promptPairs: number;
    aiMergeMs: number;
    applyMergeMs: number;
    markEvaluatedMs: number;
  };
  clusterFinalize: {
    recomputed: number;
    updated: number;
    deleted: number;
    summarySucceeded: number;
    summaryFailed: number;
  };
};

export type IngestionTaskStageState = {
  sourceSync: IngestionStageTiming | null;
  itemProcessing: IngestionStageTiming | null;
  clusterMerge: IngestionStageTiming | null;
  clusterFinalize: IngestionStageTiming | null;
};

export type IngestionTimelineModelNames = {
  itemUnderstanding: string | null;
  clusterMatch: string | null;
  clusterMerge: string | null;
  clusterSummary: string | null;
};

function toTaskStageTimingSnapshot(stageTiming: IngestionStageTiming): TaskStageTimingSnapshot {
  return {
    key: stageTiming.key,
    label: stageTiming.label,
    startedAt: stageTiming.startedAt?.toISOString() ?? null,
    finishedAt: stageTiming.finishedAt?.toISOString() ?? null,
    durationMs: stageTiming.durationMs,
  };
}

export function createIngestionStageTracker() {
  const stageTimings: IngestionStageTiming[] = [];

  return {
    snapshot() {
      return stageTimings.map(toTaskStageTimingSnapshot);
    },
    startStage(key: string, label: string) {
      const stageTiming: IngestionStageTiming = {
        key,
        label,
        startedAt: new Date(),
        finishedAt: null,
        durationMs: null,
      };

      stageTimings.push(stageTiming);
      return stageTiming;
    },
    finishStage(stageTiming: IngestionStageTiming) {
      if (stageTiming.finishedAt) {
        return;
      }

      const finishedAt = new Date();
      stageTiming.finishedAt = finishedAt;
      stageTiming.durationMs = stageTiming.startedAt ? finishedAt.getTime() - stageTiming.startedAt.getTime() : null;
    },
  };
}

export function createIngestionTimelineCounters(): IngestionTimelineCounters {
  return {
    sourceFetch: {
      sourcesFetched: 0,
      sourcesFailed: 0,
      itemsFetched: 0,
      fullTextFetched: 0,
      fullTextFetchAttempted: 0,
      fullTextFetchRssHtml: 0,
      fullTextFetchShortContent: 0,
      fullTextFetchLocalAttempted: 0,
      fullTextFetchJinaAttempted: 0,
      fullTextFetchLocalUsed: 0,
      fullTextFetchJinaUsed: 0,
      fullTextFetchDurationMs: 0,
    },
    ruleFilter: {
      ruleFiltered: 0,
      reusedExisting: 0,
      durationMs: 0,
      itemTotalDurationMs: 0,
      dbWriteDurationMs: 0,
    },
    itemSummary: {
      completed: 0,
      failed: 0,
    },
    aggregationParsing: {
      parsed: 0,
      failed: 0,
      events: 0,
    },
    itemAnalysis: {
      completed: 0,
      failed: 0,
      filtered: 0,
      updatedExisting: 0,
      durationMs: 0,
    },
    clusterAssignment: {
      exactMatch: 0,
      cheapRankDirect: 0,
      aiMatch: 0,
      skippedIncompleteSignature: 0,
      newCluster: 0,
      durationMs: 0,
    },
    clusterMerge: {
      baseClusters: 0,
      candidates: 0,
      totalPairs: 0,
      rejectedObjectConflict: 0,
      rejectedDateConflict: 0,
      rejectedNoEventAnchor: 0,
      belowGrayScore: 0,
      relatedPairs: 0,
      aiEligiblePairs: 0,
      cleanPairsSkipped: 0,
      precomputedCleanPairsUsed: 0,
      precomputedCleanPairsAttemptSkipped: 0,
      precomputedCleanPairsInvalidSkipped: 0,
      blockedByCannotLink: 0,
      blockedByDeclinedDecision: 0,
      decisionsApproved: 0,
      decisionsDeclined: 0,
      decisionsAmbiguous: 0,
      decisionsFailed: 0,
      dirtyPairs: 0,
      preLimitCandidates: 0,
      postLimitCandidates: 0,
      dirtyCandidates: 0,
      aiMergeGroups: 0,
      skipped: true,
      merged: 0,
      itemsMoved: 0,
      failedGroups: 0,
      refreshItemCountsMs: 0,
      loadClustersMs: 0,
      candidateSelectionMs: 0,
      promptBuildMs: 0,
      promptChars: 0,
      promptPairs: 0,
      aiMergeMs: 0,
      applyMergeMs: 0,
      markEvaluatedMs: 0,
    },
    clusterFinalize: {
      recomputed: 0,
      updated: 0,
      deleted: 0,
      summarySucceeded: 0,
      summaryFailed: 0,
    },
  };
}

export function createIngestionTimelineModelNames(): IngestionTimelineModelNames {
  return {
    itemUnderstanding: null,
    clusterMatch: null,
    clusterMerge: null,
    clusterSummary: null,
  };
}

export function createInitialIngestionTaskTimeline(): TaskTimelineNodeSnapshot[] {
  return [
    { key: "source_fetch", label: "信息抓取", status: "running", startedAt: null, finishedAt: null, durationMs: null, metrics: [] },
    { key: "rule_filter", label: "规则过滤", status: "pending", startedAt: null, finishedAt: null, durationMs: null, metrics: [] },
    { key: "item_understanding", label: "条目理解", status: "pending", startedAt: null, finishedAt: null, durationMs: null, metrics: [] },
    { key: "cluster_assignment", label: "归组决策", status: "pending", startedAt: null, finishedAt: null, durationMs: null, metrics: [] },
    { key: "cluster_merge", label: "聚合合并", status: "pending", startedAt: null, finishedAt: null, durationMs: null, metrics: [] },
    { key: "cluster_finalize", label: "聚合收尾", status: "pending", startedAt: null, finishedAt: null, durationMs: null, metrics: [] },
  ];
}

function toNodeTiming(stageTiming: IngestionStageTiming | null) {
  return {
    startedAt: stageTiming?.startedAt?.toISOString() ?? null,
    finishedAt: stageTiming?.finishedAt?.toISOString() ?? null,
    durationMs: stageTiming?.durationMs ?? null,
  };
}

function resolveNodeStatusFromCounts(options: {
  stageTiming: IngestionStageTiming | null;
  successCount: number;
  failureCount?: number;
  allowEmptySuccess?: boolean;
}): TaskTimelineNodeStatus {
  const { stageTiming, successCount, failureCount = 0, allowEmptySuccess = false } = options;

  if (!stageTiming) {
    return "pending";
  }

  if (!stageTiming.finishedAt) {
    return "running";
  }

  if (successCount === 0 && failureCount === 0) {
    return allowEmptySuccess ? "succeeded" : "skipped";
  }

  if (failureCount > 0 && successCount === 0) {
    return "failed";
  }

  if (failureCount > 0) {
    return "partial";
  }

  return "succeeded";
}

export function buildIngestionTaskTimeline(input: {
  counters: IngestionTimelineCounters;
  stages: IngestionTaskStageState;
  modelNames: IngestionTimelineModelNames;
}): TaskTimelineNodeSnapshot[] {
  const { counters, stages, modelNames } = input;
  const clusterFinalizeCounts =
    counters.clusterFinalize.recomputed +
    counters.clusterFinalize.updated +
    counters.clusterFinalize.deleted +
    counters.clusterFinalize.summarySucceeded +
    counters.clusterFinalize.summaryFailed;

  return [
    {
      key: "source_fetch",
      label: "信息抓取",
      status: resolveNodeStatusFromCounts({
        stageTiming: stages.sourceSync,
        successCount: Math.max(0, counters.sourceFetch.sourcesFetched - counters.sourceFetch.sourcesFailed),
        failureCount: counters.sourceFetch.sourcesFailed,
        allowEmptySuccess: true,
      }),
      ...toNodeTiming(stages.sourceSync),
      metrics: [
        { label: "抓取源", value: counters.sourceFetch.sourcesFetched },
        { label: "失败源", value: counters.sourceFetch.sourcesFailed },
        { label: "抓取内容", value: counters.sourceFetch.itemsFetched },
        { label: "正文补抓", value: counters.sourceFetch.fullTextFetched },
        { label: "补抓尝试", value: counters.sourceFetch.fullTextFetchAttempted },
        { label: "HTML补抓", value: counters.sourceFetch.fullTextFetchRssHtml },
        { label: "短正文补抓", value: counters.sourceFetch.fullTextFetchShortContent },
        { label: "本地尝试", value: counters.sourceFetch.fullTextFetchLocalAttempted },
        { label: "Jina尝试", value: counters.sourceFetch.fullTextFetchJinaAttempted },
        { label: "本地命中", value: counters.sourceFetch.fullTextFetchLocalUsed },
        { label: "Jina命中", value: counters.sourceFetch.fullTextFetchJinaUsed },
        { label: "补抓累计耗时ms", value: counters.sourceFetch.fullTextFetchDurationMs },
      ],
    },
    {
      key: "rule_filter",
      label: "规则过滤",
      status: resolveNodeStatusFromCounts({
        stageTiming: stages.itemProcessing,
        successCount: counters.ruleFilter.ruleFiltered + counters.ruleFilter.reusedExisting,
      }),
      ...toNodeTiming(stages.itemProcessing),
      metrics: [
        { label: "命中规则过滤", value: counters.ruleFilter.ruleFiltered },
        { label: "复用已有处理", value: counters.ruleFilter.reusedExisting },
        { label: "累计耗时ms", value: counters.ruleFilter.durationMs },
        { label: "条目累计耗时ms", value: counters.ruleFilter.itemTotalDurationMs },
        { label: "DB写入累计耗时ms", value: counters.ruleFilter.dbWriteDurationMs },
      ],
    },
    {
      key: "item_understanding",
      label: "条目理解",
      status: resolveNodeStatusFromCounts({
        stageTiming: stages.itemProcessing,
        successCount:
          counters.itemSummary.completed +
          counters.itemAnalysis.completed +
          counters.aggregationParsing.parsed,
        failureCount:
          counters.itemSummary.failed +
          counters.itemAnalysis.failed +
          counters.aggregationParsing.failed,
      }),
      ...toNodeTiming(stages.itemProcessing),
      modelName: modelNames.itemUnderstanding,
      metrics: [
        { label: "摘要完成", value: counters.itemSummary.completed },
        { label: "摘要失败", value: counters.itemSummary.failed },
        { label: "分析完成", value: counters.itemAnalysis.completed },
        { label: "分析失败", value: counters.itemAnalysis.failed },
        { label: "过滤", value: counters.itemAnalysis.filtered },
        { label: "更新/重处理", value: counters.itemAnalysis.updatedExisting },
        { label: "拆分成功", value: counters.aggregationParsing.parsed },
        { label: "拆分失败", value: counters.aggregationParsing.failed },
        { label: "子事件", value: counters.aggregationParsing.events },
        { label: "累计耗时ms", value: counters.itemAnalysis.durationMs },
      ],
    },
    {
      key: "cluster_assignment",
      label: "归组决策",
      status: resolveNodeStatusFromCounts({
        stageTiming: stages.itemProcessing,
        successCount:
          counters.clusterAssignment.exactMatch +
          counters.clusterAssignment.cheapRankDirect +
          counters.clusterAssignment.aiMatch +
          counters.clusterAssignment.skippedIncompleteSignature +
          counters.clusterAssignment.newCluster,
      }),
      ...toNodeTiming(stages.itemProcessing),
      modelName: modelNames.clusterMatch,
      metrics: [
        { label: "指纹命中", value: counters.clusterAssignment.exactMatch },
        { label: "本地直连", value: counters.clusterAssignment.cheapRankDirect },
        { label: "AI归组", value: counters.clusterAssignment.aiMatch },
        { label: "跳过", value: counters.clusterAssignment.skippedIncompleteSignature },
        { label: "新建", value: counters.clusterAssignment.newCluster },
        { label: "累计耗时ms", value: counters.clusterAssignment.durationMs },
      ],
    },
    {
      key: "cluster_merge",
      label: "聚合合并",
      status: stages.clusterMerge
        ? stages.clusterMerge.finishedAt
          ? counters.clusterMerge.candidates > 0
            ? counters.clusterMerge.failedGroups > 0
              ? "partial"
              : counters.clusterMerge.skipped
                ? "skipped"
                : "succeeded"
            : "skipped"
          : "running"
        : "pending",
      ...toNodeTiming(stages.clusterMerge),
      modelName: modelNames.clusterMerge,
      metrics: [
        { label: "基础池", value: counters.clusterMerge.baseClusters },
        { label: "本地Pair", value: counters.clusterMerge.totalPairs },
        { label: "对象冲突", value: counters.clusterMerge.rejectedObjectConflict },
        { label: "日期冲突", value: counters.clusterMerge.rejectedDateConflict },
        { label: "无锚点", value: counters.clusterMerge.rejectedNoEventAnchor },
        { label: "低分", value: counters.clusterMerge.belowGrayScore },
        { label: "相关Pair", value: counters.clusterMerge.relatedPairs },
        { label: "AI候选Pair", value: counters.clusterMerge.aiEligiblePairs },
        { label: "Hash跳过", value: counters.clusterMerge.cleanPairsSkipped },
        { label: "预计算Pair", value: counters.clusterMerge.precomputedCleanPairsUsed },
        { label: "预计算限次", value: counters.clusterMerge.precomputedCleanPairsAttemptSkipped },
        { label: "预计算失效", value: counters.clusterMerge.precomputedCleanPairsInvalidSkipped },
        { label: "人工阻断", value: counters.clusterMerge.blockedByCannotLink },
        { label: "冷却阻断", value: counters.clusterMerge.blockedByDeclinedDecision },
        { label: "账本通过", value: counters.clusterMerge.decisionsApproved },
        { label: "账本拒绝", value: counters.clusterMerge.decisionsDeclined },
        { label: "账本灰区", value: counters.clusterMerge.decisionsAmbiguous },
        { label: "账本失败", value: counters.clusterMerge.decisionsFailed },
        { label: "Dirty Pair", value: counters.clusterMerge.dirtyPairs },
        { label: "裁剪前", value: counters.clusterMerge.preLimitCandidates },
        { label: "候选组", value: counters.clusterMerge.candidates },
        { label: "Dirty候选", value: counters.clusterMerge.dirtyCandidates },
        { label: "送模Pair", value: counters.clusterMerge.promptPairs },
        { label: "输入字符", value: counters.clusterMerge.promptChars },
        { label: "刷新数量ms", value: counters.clusterMerge.refreshItemCountsMs },
        { label: "加载候选ms", value: counters.clusterMerge.loadClustersMs },
        { label: "候选计算ms", value: counters.clusterMerge.candidateSelectionMs },
        { label: "构造输入ms", value: counters.clusterMerge.promptBuildMs },
        { label: "模型调用ms", value: counters.clusterMerge.aiMergeMs },
        { label: "执行合并ms", value: counters.clusterMerge.applyMergeMs },
        { label: "标记Hashms", value: counters.clusterMerge.markEvaluatedMs },
        { label: "AI返回组", value: counters.clusterMerge.aiMergeGroups },
        { label: "跳过", value: counters.clusterMerge.skipped ? 1 : 0 },
        { label: "合并后", value: counters.clusterMerge.candidates - counters.clusterMerge.merged },
        { label: "移动条目", value: counters.clusterMerge.itemsMoved },
        { label: "失败组", value: counters.clusterMerge.failedGroups },
      ],
    },
    {
      key: "cluster_finalize",
      label: "聚合收尾",
      status: resolveNodeStatusFromCounts({
        stageTiming: stages.clusterFinalize,
        successCount:
          counters.clusterFinalize.recomputed +
          counters.clusterFinalize.updated +
          counters.clusterFinalize.deleted +
          counters.clusterFinalize.summarySucceeded,
        failureCount: counters.clusterFinalize.summaryFailed,
        allowEmptySuccess: Boolean(stages.clusterFinalize?.finishedAt) && clusterFinalizeCounts === 0,
      }),
      ...toNodeTiming(stages.clusterFinalize),
      modelName: modelNames.clusterSummary,
      metrics: [
        { label: "参与重算", value: counters.clusterFinalize.recomputed },
        { label: "完成更新", value: counters.clusterFinalize.updated },
        { label: "摘要完成", value: counters.clusterFinalize.summarySucceeded },
        { label: "摘要失败", value: counters.clusterFinalize.summaryFailed },
        { label: "已删除", value: counters.clusterFinalize.deleted },
      ],
    },
  ];
}
