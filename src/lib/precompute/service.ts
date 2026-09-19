import { createEmbedTexts } from "@/lib/ai/embeddings";
import { createAiProvider, type AiProvider } from "@/lib/ai/provider";
import { precomputeClusterMergeCleanPairs } from "@/lib/clusters/service";
import { prisma } from "@/lib/db";
import {
  autoNormalizeEntityAliases,
  precomputeEntitySuggestionCandidates,
} from "@/lib/entities/service";
import { getIngestionRuntimeConfig } from "@/lib/settings/service";
import { enqueueTaskRun, updateTaskRun } from "@/lib/tasks/service";

type PrecomputeStageResult = {
  key: "cluster_merge_clean_pairs" | "entity_alias_check" | "entity_suggestion_candidates";
  label: string;
  ok: boolean;
  summary: string;
  error?: string;
};

type AliasMediumRecords = Awaited<ReturnType<typeof autoNormalizeEntityAliases>>["mediumRecords"];

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

export async function executePrecomputeTask(taskRun: { id: string }) {
  await updateTaskRun(taskRun.id, {
    status: "running",
    progressCurrent: 0,
    progressTotal: 3,
    progressLabel: "正在执行预计算",
  });

  // 配置缺失时降级：合并预筛退纯规则、别名阶段跳过仲裁，任务不阻断
  const runtimeConfig = await getIngestionRuntimeConfig().catch(() => null);
  const embedTexts = runtimeConfig ? createEmbedTexts(runtimeConfig.embedding) : null;
  const aiProvider: AiProvider | undefined = runtimeConfig
    ? createAiProvider(runtimeConfig.modelApi, undefined, undefined, {
        embedding: runtimeConfig.embedding,
      })
    : undefined;

  let aliasMediumRecords: AliasMediumRecords = [];
  const clusterStage = await runPrecomputeStage(
    "cluster_merge_clean_pairs",
    "聚合合并候选",
    async () => {
      const result = await precomputeClusterMergeCleanPairs(new Date(), { embedTexts });
      return `聚合候选 ${result.storedPairs}/${result.candidatePairs} 个（向量提名 ${result.vectorAdmittedPairs}），扫描 ${result.scoredPairs} 对`;
    },
  );
  await updateTaskRun(taskRun.id, {
    status: "running",
    progressCurrent: 1,
    progressTotal: 3,
    progressLabel: clusterStage.summary,
  });

  const aliasStage = await runPrecomputeStage(
    "entity_alias_check",
    "实体别名自动化",
    async () => {
      const aliasOutcome = await autoNormalizeEntityAliases(new Date(), aiProvider);
      aliasMediumRecords = aliasOutcome.mediumRecords;
      const { result } = aliasOutcome;
      return `别名候选 ${result.candidatePairs}，仲裁 ${result.adjudicatedPairs}，自动合并 ${result.autoMergedAliases}，建议 ${result.mediumSuggestions}`;
    },
  );

  // 中置信的别名候选以补充草稿进入实体治理建议（非破坏性 upsert）
  const entityStage = await runPrecomputeStage(
    "entity_suggestion_candidates",
    "实体治理候选",
    async () => {
      const result = await precomputeEntitySuggestionCandidates(new Date(), {
        additionalRecords: aliasMediumRecords,
      });
      return `实体候选 ${result.storedCandidates} 个，扫描 ${result.scannedPairs} 对`;
    },
  );

  const stages = [clusterStage, aliasStage, entityStage];
  const failedStages = stages.filter((stage) => !stage.ok);
  const status = failedStages.length === 0 ? "succeeded" : failedStages.length === stages.length ? "failed" : "partial";
  const progressLabel = stages.map((stage) => stage.summary).join("；");
  const errorSummary = failedStages.map((stage) => `${stage.label}: ${stage.error}`).join("；") || null;

  await updateTaskRun(taskRun.id, {
    status,
    progressCurrent: 3,
    progressTotal: 3,
    progressLabel,
    errorSummary,
    finishedAt: new Date(),
  });

  if (status === "failed") {
    throw new Error(errorSummary ?? "预计算失败");
  }

  return {
    status,
    stages,
  };
}
