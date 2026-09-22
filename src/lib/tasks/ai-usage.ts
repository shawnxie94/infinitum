import type { AiProvider } from "@/lib/ai/provider";
import type { AiCallUsage } from "@/lib/ai/provider";
import { getAiTaskContract } from "@/lib/ai/contracts";
import { AI_OPERATION_REGISTRY } from "@/lib/ai/operations";
import { createUsageLedger } from "@infinitum/ai/provider/usage-ledger";
import type {
  TaskAiCallBreakdownKey,
  TaskAiCallBreakdownSnapshot,
} from "@/lib/tasks/types";

export type TaskAiUsageSnapshot = {
  actual: number;
  estimated: number;
  breakdown: TaskAiCallBreakdownSnapshot[];
  /** 网关层 attempt 审计；不改变现有业务调用计数口径。 */
  attempts?: Record<string, number>;
};

function getContractTypeForUsageKey(key: TaskAiCallBreakdownKey) {
  return key === "daily_report_review" ? "daily_report_review" as const :
    key === "item_understanding" ? "item_understanding" as const :
      key === "cluster_summary" ? "cluster_summary" as const :
        key === "cluster_match" ? "cluster_match" as const :
          key === "cluster_merge" ? "cluster_merge" as const :
            key === "entity_alias_check" ? "entity_alias_check" as const : "daily_report" as const;
}

function toTaskBreakdownSnapshot(
  entries: ReturnType<ReturnType<typeof createUsageLedger>["snapshot"]>["breakdown"],
): TaskAiCallBreakdownSnapshot[] {
  return entries.map((entry) => ({
    key: entry.key as TaskAiCallBreakdownKey,
    label: entry.label,
    actual: entry.actual,
    estimated: entry.estimated,
    ...(entry.tokens.totalTokens > 0
      ? {
          contractVersion: getAiTaskContract(getContractTypeForUsageKey(entry.key as TaskAiCallBreakdownKey)).contractVersion,
          contractHash: getAiTaskContract(getContractTypeForUsageKey(entry.key as TaskAiCallBreakdownKey)).contractHash,
          promptTokens: entry.tokens.promptTokens,
          completionTokens: entry.tokens.completionTokens,
          totalTokens: entry.tokens.totalTokens,
          cachedTokens: entry.tokens.cachedTokens,
          tokenUsageSource: entry.tokens.tokenUsageSource ?? "estimated",
        }
      : {}),
  }));
}

export function createTaskAiUsageTracker(
  initialEstimated = 0,
  initialEstimatedKey: TaskAiCallBreakdownKey = "item_understanding",
) {
  const ledger = createUsageLedger(AI_OPERATION_REGISTRY.list());
  ledger.setEstimated(initialEstimated, initialEstimatedKey);

  return {
    snapshot(): TaskAiUsageSnapshot {
      const snapshot = ledger.snapshot();
      return {
        actual: snapshot.actual,
        estimated: snapshot.estimated,
        breakdown: toTaskBreakdownSnapshot(snapshot.breakdown),
        attempts: snapshot.attempts,
      };
    },
    recordAttempt(event: {
      usageKey?: string;
      attemptType: "initial" | "json_retry" | "transient_retry" | "structured_fallback" | "business_repair";
    }) {
      ledger.recordAttempt(event);
    },
    setEstimated(value: number, key: TaskAiCallBreakdownKey = "item_understanding") {
      ledger.setEstimated(value, key);
    },
    addEstimated(value: number, key: TaskAiCallBreakdownKey = "item_understanding") {
      ledger.addEstimated(value, key);
    },
    addUsage(key: TaskAiCallBreakdownKey, usage: AiCallUsage) {
      ledger.recordUsage(key, usage);
    },
    addUsageByKey(usageKey: string | undefined, usage: AiCallUsage) {
      if (usageKey && AI_OPERATION_REGISTRY.has(usageKey)) {
        ledger.recordUsage(usageKey, usage);
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
          ledger.recordCall("item_understanding", options?.understandItemEstimated ?? true);
          return aiProvider.understandItem(inputText, metadata);
        },
        async summarizeCluster(inputText, metadata) {
          ledger.recordCall("cluster_summary", options?.summarizeClusterEstimated ?? true);
          return aiProvider.summarizeCluster(inputText, metadata);
        },
        async matchClusterCandidate(inputText, metadata) {
          ledger.recordCall("cluster_match", options?.matchClusterCandidateEstimated ?? true);
          return aiProvider.matchClusterCandidate(inputText, metadata);
        },
        async assessClusterMergePairs(clustersJson) {
          ledger.recordCall("cluster_merge");
          return aiProvider.assessClusterMergePairs(clustersJson);
        },
        ...(aiProvider.assessEntityAliasPairs
          ? {
              async assessEntityAliasPairs(input: Parameters<NonNullable<AiProvider["assessEntityAliasPairs"]>>[0]) {
                ledger.recordCall("entity_alias_check");
                return aiProvider.assessEntityAliasPairs!(input);
              },
            }
          : {}),
        async assessDailyReportCandidates(input) {
          ledger.recordCall("daily_report_assess");
          return aiProvider.assessDailyReportCandidates(input);
        },
        async planDailyReport(input) {
          ledger.recordCall("daily_report_plan");
          return aiProvider.planDailyReport(input);
        },
        async writeDailyReport(input) {
          ledger.recordCall("daily_report_write");
          return aiProvider.writeDailyReport(input);
        },
        async repairDailyReportDraft(input) {
          ledger.recordCall("daily_report_repair");
          return aiProvider.repairDailyReportDraft(input);
        },
        async reviewDailyReport(input) {
          ledger.recordCall("daily_report_review");
          return aiProvider.reviewDailyReport(input);
        },
      };
    },
  };
}
