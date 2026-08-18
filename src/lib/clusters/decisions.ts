import { Prisma, type ClusterDecisionKind, type ClusterDecisionSource, type ClusterDecisionVerdict } from "@prisma/client";

import { prisma } from "@/lib/db";
import type { ClusterReviewCandidateDTO } from "@/lib/feed/types";

const DECLINED_RETRY_DELAYS_MS = [
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  48 * 60 * 60 * 1000,
];
const MAX_DECLINED_ATTEMPTS = DECLINED_RETRY_DELAYS_MS.length;

export type ClusterDecisionRecordInput = {
  kind: ClusterDecisionKind;
  source: ClusterDecisionSource;
  verdict: ClusterDecisionVerdict;
  pairKey: string;
  inputHash: string;
  leftItemId?: string | null;
  rightItemId?: string | null;
  leftClusterId?: string | null;
  rightClusterId?: string | null;
  localScore?: number | null;
  confidence?: number | null;
  reasonCode?: string | null;
  reasonText?: string | null;
  now?: Date;
};

export function getDeclinedAttemptLimit() {
  return MAX_DECLINED_ATTEMPTS;
}

function getDeclinedRetryDelayMs(attemptCount: number) {
  return DECLINED_RETRY_DELAYS_MS[Math.max(0, Math.min(attemptCount - 1, DECLINED_RETRY_DELAYS_MS.length - 1))] ?? null;
}

export async function countDeclinedDecisions(pairKey: string, inputHash: string) {
  return prisma.clusterDecision.count({
    where: {
      kind: "cluster_pair",
      pairKey,
      inputHash,
      verdict: "declined",
    },
  });
}

export async function recordClusterDecision(input: ClusterDecisionRecordInput) {
  const now = input.now ?? new Date();
  const declinedAttempts =
    input.verdict === "declined" ? (await countDeclinedDecisions(input.pairKey, input.inputHash)) + 1 : 0;
  const retryDelayMs = input.verdict === "declined" ? getDeclinedRetryDelayMs(declinedAttempts) : null;

  return prisma.clusterDecision.create({
    data: {
      kind: input.kind,
      source: input.source,
      verdict: input.verdict,
      pairKey: input.pairKey,
      inputHash: input.inputHash,
      leftItemId: input.leftItemId ?? null,
      rightItemId: input.rightItemId ?? null,
      leftClusterId: input.leftClusterId ?? null,
      rightClusterId: input.rightClusterId ?? null,
      localScore: input.localScore ?? null,
      confidence: input.confidence ?? null,
      reasonCode: input.reasonCode ?? null,
      reasonText: input.reasonText ?? null,
      attemptCount: declinedAttempts,
      expiresAt: retryDelayMs == null ? null : new Date(now.getTime() + retryDelayMs),
    },
  });
}

export async function getClusterPairDecisionBlock(input: {
  pairKey: string;
  inputHash: string;
  now: Date;
}) {
  const latestDecision = await prisma.clusterDecision.findFirst({
    where: {
      kind: "cluster_pair",
      pairKey: input.pairKey,
      inputHash: input.inputHash,
      verdict: { in: ["declined", "ambiguous"] },
      appliedAt: null,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  if (!latestDecision) {
    return null;
  }

  if (latestDecision.verdict === "ambiguous") {
    return {
      reason: "ambiguous_pending_review" as const,
      decision: latestDecision,
    };
  }

  if (latestDecision.attemptCount >= MAX_DECLINED_ATTEMPTS) {
    return {
      reason: "declined_attempt_limit" as const,
      decision: latestDecision,
    };
  }

  if (latestDecision.expiresAt && latestDecision.expiresAt.getTime() > input.now.getTime()) {
    return {
      reason: "declined_cooldown" as const,
      decision: latestDecision,
    };
  }

  return null;
}

export async function markDecisionApplied(decisionId: string, appliedAction: string) {
  return prisma.clusterDecision.update({
    where: { id: decisionId },
    data: {
      appliedAt: new Date(),
      appliedAction,
    },
  });
}

export async function markOrphanedClusterPairDecisionsStale(now = new Date()) {
  return prisma.$executeRaw`
    UPDATE "cluster_decisions"
    SET "appliedAt" = ${now.getTime()},
        "appliedAction" = ${"stale_orphan_cluster"}
    WHERE "kind" = ${"cluster_pair"}
      AND "verdict" IN (${Prisma.join(["approved", "ambiguous"])})
      AND "appliedAt" IS NULL
      AND (
        "leftClusterId" IS NULL
        OR "rightClusterId" IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM "content_clusters" left_cluster
          WHERE left_cluster."id" = "cluster_decisions"."leftClusterId"
        )
        OR NOT EXISTS (
          SELECT 1 FROM "content_clusters" right_cluster
          WHERE right_cluster."id" = "cluster_decisions"."rightClusterId"
        )
      )
  `;
}

function mapReviewCluster(cluster: {
  id: string;
  title: string;
  summary: string;
  itemCount: number;
  score: number;
  latestPublishedAt: Date;
  status: "active" | "hidden";
}): ClusterReviewCandidateDTO["leftCluster"] {
  return {
    id: cluster.id,
    title: cluster.title,
    summary: cluster.summary,
    itemCount: cluster.itemCount,
    score: cluster.score,
    latestPublishedAt: cluster.latestPublishedAt.toISOString(),
    status: cluster.status,
  };
}

export async function listClusterReviewCandidates(page = 1, pageSize = 20, options?: { since?: Date | null }) {
  const normalizedPage = Math.max(1, page);
  const normalizedPageSize = Math.min(100, Math.max(1, pageSize));
  const skip = (normalizedPage - 1) * normalizedPageSize;
  const createdAtFilter = options?.since
    ? Prisma.sql`AND d."createdAt" >= ${options.since.getTime()}`
    : Prisma.empty;
  const reviewDecisionFilter = Prisma.sql`
    WHERE d."kind" = ${"cluster_pair"}
      AND d."verdict" IN (${Prisma.join(["approved", "ambiguous"])})
      AND d."appliedAt" IS NULL
      AND d."leftClusterId" IS NOT NULL
      AND d."rightClusterId" IS NOT NULL
      ${createdAtFilter}
  `;
  const [decisionIdRows, totalRows] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT d.id
      FROM "cluster_decisions" d
      INNER JOIN "content_clusters" left_cluster ON left_cluster.id = d."leftClusterId"
      INNER JOIN "content_clusters" right_cluster ON right_cluster.id = d."rightClusterId"
      ${reviewDecisionFilter}
      ORDER BY d."createdAt" DESC, d.id DESC
      LIMIT ${normalizedPageSize}
      OFFSET ${skip}
    `),
    prisma.$queryRaw<Array<{ total: number | bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS total
      FROM "cluster_decisions" d
      INNER JOIN "content_clusters" left_cluster ON left_cluster.id = d."leftClusterId"
      INNER JOIN "content_clusters" right_cluster ON right_cluster.id = d."rightClusterId"
      ${reviewDecisionFilter}
    `),
  ]);
  const decisionIds = decisionIdRows.map((row) => row.id);
  const decisions = decisionIds.length
    ? await prisma.clusterDecision.findMany({ where: { id: { in: decisionIds } } })
    : [];
  const decisionsById = new Map(decisions.map((decision) => [decision.id, decision]));
  const orderedDecisions = decisionIds
    .map((id) => decisionsById.get(id))
    .filter((decision): decision is (typeof decisions)[number] => Boolean(decision));
  const total = Number(totalRows[0]?.total ?? 0);
  const clusterIds = Array.from(
    new Set(
      orderedDecisions
        .flatMap((decision) => [decision.leftClusterId, decision.rightClusterId])
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const clusters = await prisma.contentCluster.findMany({
    where: { id: { in: clusterIds } },
    select: {
      id: true,
      title: true,
      summary: true,
      itemCount: true,
      score: true,
      latestPublishedAt: true,
      status: true,
    },
  });
  const clustersById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const candidates: ClusterReviewCandidateDTO[] = [];

  for (const decision of orderedDecisions) {
    if (!decision.leftClusterId || !decision.rightClusterId) {
      continue;
    }

    const leftCluster = clustersById.get(decision.leftClusterId);
    const rightCluster = clustersById.get(decision.rightClusterId);

    if (!leftCluster || !rightCluster) {
      continue;
    }

    candidates.push({
      id: decision.id,
      verdict: decision.verdict,
      source: decision.source,
      reasonCode: decision.reasonCode,
      reasonText: decision.reasonText,
      localScore: decision.localScore,
      confidence: decision.confidence,
      attemptCount: decision.attemptCount,
      expiresAt: decision.expiresAt?.toISOString() ?? null,
      createdAt: decision.createdAt.toISOString(),
      leftCluster: mapReviewCluster(leftCluster),
      rightCluster: mapReviewCluster(rightCluster),
      targetClusterId: leftCluster.itemCount >= rightCluster.itemCount ? leftCluster.id : rightCluster.id,
      sourceClusterId: leftCluster.itemCount >= rightCluster.itemCount ? rightCluster.id : leftCluster.id,
    });
  }

  return {
    candidates,
    total,
    page: normalizedPage,
    pageSize: normalizedPageSize,
  };
}

export async function getPendingClusterReviewDecision(decisionId: string) {
  const decision = await prisma.clusterDecision.findFirst({
    where: {
      id: decisionId,
      kind: "cluster_pair",
      verdict: { in: ["approved", "ambiguous"] },
      appliedAt: null,
      leftClusterId: { not: null },
      rightClusterId: { not: null },
    },
  });

  if (!decision?.leftClusterId || !decision.rightClusterId) {
    return null;
  }

  const clusters = await prisma.contentCluster.findMany({
    where: {
      id: { in: [decision.leftClusterId, decision.rightClusterId] },
    },
    select: {
      id: true,
      itemCount: true,
    },
  });
  const clustersById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const leftCluster = clustersById.get(decision.leftClusterId);
  const rightCluster = clustersById.get(decision.rightClusterId);

  if (!leftCluster || !rightCluster) {
    return null;
  }

  return {
    decision,
    targetClusterId: leftCluster.itemCount >= rightCluster.itemCount ? leftCluster.id : rightCluster.id,
    sourceClusterId: leftCluster.itemCount >= rightCluster.itemCount ? rightCluster.id : leftCluster.id,
  };
}
