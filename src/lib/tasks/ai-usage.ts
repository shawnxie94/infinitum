import type { AiProvider } from "@/lib/ai/provider";
import type { AiCallUsage } from "@/lib/ai/provider";
import { getAiTaskContract } from "@/lib/ai/contracts";
import type {
  TaskAiCallBreakdownKey,
  TaskAiCallBreakdownSnapshot,
} from "@/lib/tasks/types";

export type TaskAiUsageSnapshot = {
  actual: number;
  estimated: number;
  breakdown: TaskAiCallBreakdownSnapshot[];
};

const AI_CALL_BREAKDOWN_LABELS: Record<TaskAiCallBreakdownKey, string> = {
  item_understanding: "条目理解",
  cluster_match: "聚合匹配",
  cluster_summary: "聚合摘要",
  cluster_merge: "聚合合并",
  daily_report: "AI 日报",
  daily_report_assess: "评估",
  daily_report_plan: "规划",
  daily_report_write: "写作",
  daily_report_repair: "修复",
  daily_report_review: "审核",
};

function getContractTypeForUsageKey(key: TaskAiCallBreakdownKey) {
  return key === "daily_report_review" ? "daily_report_review" as const :
    key === "item_understanding" ? "item_understanding" as const :
      key === "cluster_summary" ? "cluster_summary" as const :
        key === "cluster_match" ? "cluster_match" as const :
          key === "cluster_merge" ? "cluster_merge" as const : "daily_report" as const;
}

type TaskAiUsageBreakdownState = Record<TaskAiCallBreakdownKey, { actual: number; estimated: number }>;
type TaskAiUsageTokenState = Record<TaskAiCallBreakdownKey, {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  tokenUsageSource: "provider" | "estimated" | "mixed" | null;
}>;

function createEmptyBreakdownState(): TaskAiUsageBreakdownState {
  return {
    item_understanding: { actual: 0, estimated: 0 },
    cluster_match: { actual: 0, estimated: 0 },
    cluster_summary: { actual: 0, estimated: 0 },
    cluster_merge: { actual: 0, estimated: 0 },
    daily_report: { actual: 0, estimated: 0 },
    daily_report_assess: { actual: 0, estimated: 0 },
    daily_report_plan: { actual: 0, estimated: 0 },
    daily_report_write: { actual: 0, estimated: 0 },
    daily_report_repair: { actual: 0, estimated: 0 },
    daily_report_review: { actual: 0, estimated: 0 },
  };
}

function createEmptyTokenState(): TaskAiUsageTokenState {
  return {
    item_understanding: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, tokenUsageSource: null },
    cluster_match: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, tokenUsageSource: null },
    cluster_summary: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, tokenUsageSource: null },
    cluster_merge: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, tokenUsageSource: null },
    daily_report: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, tokenUsageSource: null },
    daily_report_assess: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, tokenUsageSource: null },
    daily_report_plan: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, tokenUsageSource: null },
    daily_report_write: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, tokenUsageSource: null },
    daily_report_repair: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, tokenUsageSource: null },
    daily_report_review: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, tokenUsageSource: null },
  };
}

function toBreakdownSnapshot(
  state: TaskAiUsageBreakdownState,
  tokenState: TaskAiUsageTokenState,
): TaskAiCallBreakdownSnapshot[] {
  return (Object.keys(AI_CALL_BREAKDOWN_LABELS) as TaskAiCallBreakdownKey[]).map((key) => ({
    key,
    label: AI_CALL_BREAKDOWN_LABELS[key],
    actual: state[key].actual,
    estimated: state[key].estimated,
    ...(tokenState[key].totalTokens > 0
      ? {
          contractVersion: getAiTaskContract(getContractTypeForUsageKey(key)).contractVersion,
          contractHash: getAiTaskContract(getContractTypeForUsageKey(key)).contractHash,
          promptTokens: tokenState[key].promptTokens,
          completionTokens: tokenState[key].completionTokens,
          totalTokens: tokenState[key].totalTokens,
          cachedTokens: tokenState[key].cachedTokens,
          tokenUsageSource: tokenState[key].tokenUsageSource ?? "estimated",
        }
      : {}),
  }));
}

function sumBreakdown(state: TaskAiUsageBreakdownState, field: "actual" | "estimated") {
  return (Object.keys(state) as TaskAiCallBreakdownKey[]).reduce(
    (total, key) => total + state[key][field],
    0,
  );
}

export function createTaskAiUsageTracker(
  initialEstimated = 0,
  initialEstimatedKey: TaskAiCallBreakdownKey = "item_understanding",
) {
  const state: TaskAiUsageSnapshot = {
    actual: 0,
    estimated: Math.max(0, initialEstimated),
    breakdown: [],
  };
  const breakdownState = createEmptyBreakdownState();
  const tokenState = createEmptyTokenState();
  breakdownState[initialEstimatedKey].estimated = Math.max(0, initialEstimated);

  const syncSnapshot = () => {
    state.actual = sumBreakdown(breakdownState, "actual");
    state.estimated = sumBreakdown(breakdownState, "estimated");
    state.breakdown = toBreakdownSnapshot(breakdownState, tokenState);
  };

  const syncEstimateFloor = () => {
    for (const key of Object.keys(breakdownState) as TaskAiCallBreakdownKey[]) {
      if (breakdownState[key].estimated < breakdownState[key].actual) {
        breakdownState[key].estimated = breakdownState[key].actual;
      }
    }
    syncSnapshot();
  };

  const incrementActual = (key: TaskAiCallBreakdownKey) => {
    breakdownState[key].actual += 1;
  };

  const incrementEstimated = (key: TaskAiCallBreakdownKey) => {
    breakdownState[key].estimated += 1;
  };

  const addUsage = (key: TaskAiCallBreakdownKey, usage: AiCallUsage) => {
    tokenState[key].promptTokens += Math.max(0, usage.promptTokens);
    tokenState[key].completionTokens += Math.max(0, usage.completionTokens);
    tokenState[key].totalTokens += Math.max(0, usage.totalTokens);
    tokenState[key].cachedTokens += Math.max(0, usage.cachedTokens);
    const usageSource = usage.tokenUsageSource ?? "estimated";
    tokenState[key].tokenUsageSource = tokenState[key].tokenUsageSource === null || tokenState[key].tokenUsageSource === usageSource
      ? usageSource
      : "mixed";
    syncSnapshot();
  };

  syncSnapshot();

  return {
    snapshot(): TaskAiUsageSnapshot {
      return {
        actual: state.actual,
        estimated: state.estimated,
        breakdown: state.breakdown.map((entry) => ({ ...entry })),
      };
    },
    setEstimated(value: number, key: TaskAiCallBreakdownKey = "item_understanding") {
      breakdownState[key].estimated = Math.max(0, value);
      syncEstimateFloor();
    },
    addEstimated(value: number, key: TaskAiCallBreakdownKey = "item_understanding") {
      breakdownState[key].estimated += Math.max(0, value);
      syncEstimateFloor();
    },
    addUsage,
    addUsageByKey(usageKey: string | undefined, usage: AiCallUsage) {
      if (usageKey && Object.prototype.hasOwnProperty.call(tokenState, usageKey)) {
        addUsage(usageKey as TaskAiCallBreakdownKey, usage);
      }
    },
    wrapProvider(
      aiProvider: AiProvider,
      options?: {
        understandItemEstimated?: boolean;
        summarizeClusterEstimated?: boolean;
        matchClusterCandidateEstimated?: boolean;
      },
    ): AiProvider {
      return {
        async understandItem(inputText, metadata) {
          incrementActual("item_understanding");
          if (options?.understandItemEstimated ?? true) {
            incrementEstimated("item_understanding");
          }
          syncEstimateFloor();
          return aiProvider.understandItem(inputText, metadata);
        },
        async summarizeCluster(inputText, metadata) {
          incrementActual("cluster_summary");
          if (options?.summarizeClusterEstimated ?? true) {
            incrementEstimated("cluster_summary");
          }
          syncEstimateFloor();
          return aiProvider.summarizeCluster(inputText, metadata);
        },
        async matchClusterCandidate(inputText, metadata) {
          incrementActual("cluster_match");
          if (options?.matchClusterCandidateEstimated ?? true) {
            incrementEstimated("cluster_match");
          }
          syncEstimateFloor();
          return aiProvider.matchClusterCandidate(inputText, metadata);
        },
        async assessClusterMergePairs(clustersJson) {
          incrementActual("cluster_merge");
          incrementEstimated("cluster_merge");
          syncEstimateFloor();
          return aiProvider.assessClusterMergePairs(clustersJson);
        },
        async assessDailyReportCandidates(input) {
          incrementActual("daily_report_assess");
          incrementEstimated("daily_report_assess");
          syncEstimateFloor();
          return aiProvider.assessDailyReportCandidates(input);
        },
        async planDailyReport(input) {
          incrementActual("daily_report_plan");
          incrementEstimated("daily_report_plan");
          syncEstimateFloor();
          return aiProvider.planDailyReport(input);
        },
        async writeDailyReport(input) {
          incrementActual("daily_report_write");
          incrementEstimated("daily_report_write");
          syncEstimateFloor();
          return aiProvider.writeDailyReport(input);
        },
        async repairDailyReportDraft(input) {
          incrementActual("daily_report_repair");
          incrementEstimated("daily_report_repair");
          syncEstimateFloor();
          return aiProvider.repairDailyReportDraft(input);
        },
        async reviewDailyReport(input) {
          incrementActual("daily_report_review");
          incrementEstimated("daily_report_review");
          syncEstimateFloor();
          return aiProvider.reviewDailyReport(input);
        },
      };
    },
  };
}
