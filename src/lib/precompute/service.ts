import { precomputeClusterMergeCleanPairs } from "@/lib/clusters/service";
import { prisma } from "@/lib/db";
import { precomputeEntitySuggestionCandidates } from "@/lib/entities/service";
import { enqueueTaskRun, updateTaskRun } from "@/lib/tasks/service";

type PrecomputeStageResult = {
  key: "cluster_merge_clean_pairs" | "entity_suggestion_candidates";
  label: string;
  ok: boolean;
  summary: string;
  error?: string;
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

export async function executePrecomputeTask(taskRun: { id: string }) {
  await updateTaskRun(taskRun.id, {
    status: "running",
    progressCurrent: 0,
    progressTotal: 2,
    progressLabel: "正在执行预计算",
  });

  const clusterStage = await runPrecomputeStage(
    "cluster_merge_clean_pairs",
    "聚合合并候选",
    async () => {
      const result = await precomputeClusterMergeCleanPairs();
      return `聚合候选 ${result.storedPairs}/${result.candidatePairs} 个，扫描 ${result.scoredPairs} 对`;
    },
  );
  await updateTaskRun(taskRun.id, {
    status: "running",
    progressCurrent: 1,
    progressTotal: 2,
    progressLabel: clusterStage.summary,
  });

  const entityStage = await runPrecomputeStage(
    "entity_suggestion_candidates",
    "实体治理候选",
    async () => {
      const result = await precomputeEntitySuggestionCandidates();
      return `实体候选 ${result.storedCandidates} 个，扫描 ${result.scannedPairs} 对`;
    },
  );
  const stages = [clusterStage, entityStage];
  const failedStages = stages.filter((stage) => !stage.ok);
  const status = failedStages.length === 0 ? "succeeded" : failedStages.length === stages.length ? "failed" : "partial";
  const progressLabel = stages.map((stage) => stage.summary).join("；");
  const errorSummary = failedStages.map((stage) => `${stage.label}: ${stage.error}`).join("；") || null;

  await updateTaskRun(taskRun.id, {
    status,
    progressCurrent: 2,
    progressTotal: 2,
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
