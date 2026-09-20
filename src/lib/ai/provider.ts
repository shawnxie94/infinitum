// AI Provider facade：引擎实现已迁移到 @infinitum/ai 模型网关（P1a，spec-mastra-migration）。
// 本文件只保留应用侧导入面（工厂 + 类型 + 错误类），不含任何逻辑。
export { createAiProvider } from "@/lib/ai/provider-next";
export {
  CLUSTER_MERGE_REASON_CODES,
  createDailyReportStageContext,
  getJsonParseErrorMessage,
  InvalidJsonModelResponseError,
  isInvalidJsonModelResponseError,
} from "@/lib/ai/provider-types";
export { buildClusterMergeGroupsFromDecisions } from "@/lib/ai/protocols/cluster";
export type {
  AiCallUsage,
  AiEventSignature,
  AiProvider,
  AiProviderOptions,
  ClusterMergeDecision,
  ClusterMergeDecisionVerdict,
  ClusterMergeReasonCode,
  DailyReportStage,
  DailyReportStageContext,
  DailyReportStageMessage,
  DailyReportStageValidationFeedback,
  EntityAliasCheckConfidence,
  EntityAliasCheckDecision,
  ItemUnderstandingResult,
} from "@/lib/ai/provider-types";
