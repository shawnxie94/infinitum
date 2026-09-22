import { createAiOperationRegistry } from "@infinitum/ai/provider/operations";
import { CLUSTER_MATCH_SCHEMA } from "@/lib/ai/protocols/cluster";
import { ENTITY_ALIAS_DECISIONS_SCHEMA } from "@/lib/ai/protocols/entity-alias";

/**
 * Product-owned AI operation catalog. The framework owns execution mechanics;
 * this registry owns the stable business keys used by prompts and telemetry.
 */
export const AI_OPERATION_REGISTRY = createAiOperationRegistry([
  { key: "item_understanding", label: "条目理解", retryPolicy: { jsonParseRetryCount: 1 } },
  { key: "cluster_match", label: "聚合匹配", schema: CLUSTER_MATCH_SCHEMA, retryPolicy: { jsonParseRetryCount: 1 } },
  { key: "cluster_summary", label: "聚合摘要", retryPolicy: { jsonParseRetryCount: 1 } },
  { key: "cluster_merge", label: "聚合合并", retryPolicy: { jsonParseRetryCount: 1 } },
  { key: "entity_alias_check", label: "实体别名判定", schema: ENTITY_ALIAS_DECISIONS_SCHEMA, retryPolicy: { jsonParseRetryCount: 1 } },
  { key: "daily_report", label: "AI 日报", retryPolicy: { jsonParseRetryCount: 1 } },
  { key: "daily_report_assess", label: "评估", retryPolicy: { jsonParseRetryCount: 1 } },
  { key: "daily_report_plan", label: "规划", retryPolicy: { jsonParseRetryCount: 1 } },
  { key: "daily_report_write", label: "写作", retryPolicy: { jsonParseRetryCount: 1 } },
  { key: "daily_report_repair", label: "修复", retryPolicy: { jsonParseRetryCount: 1 } },
  { key: "daily_report_review", label: "审核", retryPolicy: { jsonParseRetryCount: 1 } },
]);

export function assertAiOperation(key: string) {
  return AI_OPERATION_REGISTRY.get(key);
}
