import { createEmbedTexts } from "@/lib/ai/embeddings";
import { createAiProvider } from "@/lib/ai/provider-next";
import { type AiCallUsage, type AiProvider } from "@/lib/ai/provider-types";
import { precomputeClusterMergeCleanPairs } from "@/lib/clusters/service";
import { prisma } from "@/lib/db";
import {
  autoNormalizeEntityAliases,
  precomputeEntitySuggestionCandidates,
} from "@/lib/entities/service";
import { getIngestionRuntimeConfig } from "@/lib/settings/service";
import { createTaskAiUsageTracker, type TaskAiUsageSnapshot } from "@/lib/tasks/ai-usage";
import { enqueueTaskRun, updateTaskRun } from "@/lib/tasks/service";

type PrecomputeStageResult = {
  key: "cluster_merge_clean_pairs" | "entity_alias_check" | "entity_suggestion_candidates";
  label: string;
  ok: boolean;
  summary: string;
  error?: string;
};

export type AliasMediumRecords = Awaited<ReturnType<typeof autoNormalizeEntityAliases>>["mediumRecords"];
export type PrecomputeWorkflowStage = PrecomputeStageResult["key"];
export type PrecomputeWorkflowPayload = {
  stages: PrecomputeStageResult[];
  aliasMediumRecords: AliasMediumRecords;
};

async function runPrecomputeStage(
  key: PrecomputeStageResult["key"],
  label: string,
  action: () => Promise<string>,
): Promise<PrecomputeStageResult> {
  try {
    return {
      key,
      label,
      ok: true,
      summary: await action(),
    };
  } catch (error) {
    return {
      key,
      label,
      ok: false,
      summary: `${label}失败`,
      error: error instanceof Error ? error.message : "Unknown precompute error",
    };
  }
}

export async function enqueuePrecomputeTask(input?: {
  triggerType?: "scheduled" | "manual" | "admin_action";
}) {
  const activeTaskCount = await prisma.backgroundTaskRun.count({
    where: {
      kind: {
        in: ["precompute", "cluster_merge_precompute_clean_pairs"],
      },
      status: { in: ["queued", "running"] },
    },
  });

  if (activeTaskCount > 0) {
    return null;
  }

  return enqueueTaskRun({
    kind: "precompute",
    triggerType: input?.triggerType ?? "manual",
    label: "预计算",
  });
}

function isPrecomputeWorkflowPayload(value: unknown): value is PrecomputeWorkflowPayload {
  return Boolean(
    value
    && typeof value === "object"
    && Array.isArray((value as Partial<PrecomputeWorkflowPayload>).stages)
    && Array.isArray((value as Partial<PrecomputeWorkflowPayload>).aliasMediumRecords),
  );
}

export async function executePrecomputeWorkflowStage(
  stage: PrecomputeWorkflowStage,
  payload?: PrecomputeWorkflowPayload,
  options?: {
    onAiUsage?: (usage: TaskAiUsageSnapshot) => Promise<void>;
  },
): Promise<PrecomputeWorkflowPayload> {
  const currentPayload = isPrecomputeWorkflowPayload(payload)
    ? payload
    : { stages: [], aliasMediumRecords: [] } satisfies PrecomputeWorkflowPayload;
  const runtimeConfig = await getIngestionRuntimeConfig().catch(() => null);
  const embedTexts = runtimeConfig ? createEmbedTexts(runtimeConfig.embedding) : null;
  const aiUsage = stage === "entity_alias_check" ? createTaskAiUsageTracker() : null;
  const aiProvider: AiProvider | undefined = runtimeConfig
    ? createAiProvider(runtimeConfig.modelApi, undefined, undefined, {
        embedding: runtimeConfig.embedding,
        ...(aiUsage
          ? { onUsage: (usage: AiCallUsage, usageKey?: string) => aiUsage.addUsageByKey(usageKey, usage) }
          : {}),
      })
    : undefined;
  const trackedAiProvider = aiProvider && aiUsage
    ? aiUsage.wrapProvider(aiProvider)
    : aiProvider;
  let stageAliasMediumRecords: AliasMediumRecords = [];
  const result = await runPrecomputeStage(
    stage,
    stage === "cluster_merge_clean_pairs" ? "聚合合并候选" : stage === "entity_alias_check" ? "实体别名自动化" : "实体治理候选",
    async () => {
      if (stage === "cluster_merge_clean_pairs") {
        const value = await precomputeClusterMergeCleanPairs(new Date(), { embedTexts });
        return `聚合候选 ${value.storedPairs}/${value.candidatePairs} 个（向量提名 ${value.vectorAdmittedPairs}），扫描 ${value.scoredPairs} 对`;
      }
      if (stage === "entity_alias_check") {
        const value = await autoNormalizeEntityAliases(new Date(), trackedAiProvider);
        stageAliasMediumRecords = value.mediumRecords;
        return `别名候选 ${value.result.candidatePairs}，仲裁 ${value.result.adjudicatedPairs}，自动合并 ${value.result.autoMergedAliases}，建议 ${value.result.mediumSuggestions}`;
      }
      const value = await precomputeEntitySuggestionCandidates(new Date(), { additionalRecords: currentPayload.aliasMediumRecords });
      return `实体候选 ${value.storedCandidates} 个，扫描 ${value.scannedPairs} 对`;
    },
  );
  if (aiUsage) await options?.onAiUsage?.(aiUsage.snapshot());
  const aliasMediumRecords = stage === "entity_alias_check" ? stageAliasMediumRecords : currentPayload.aliasMediumRecords;
  return { stages: [...currentPayload.stages, result], aliasMediumRecords };
}
