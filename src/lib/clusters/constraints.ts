import type { ClusterConstraintKind, ClusterConstraintScope, Prisma } from "@prisma/client";

import { buildClusterMergeEdgeKey } from "@/lib/clusters/helpers";
import { prisma } from "@/lib/db";

export function buildClusterConstraintPairKey(leftId: string, rightId: string) {
  return buildClusterMergeEdgeKey(leftId, rightId);
}

async function upsertClusterConstraint(
  input: {
  kind: ClusterConstraintKind;
  scope: ClusterConstraintScope;
  leftId: string;
  rightId: string;
  reason?: string | null;
  createdBy?: string;
  expiresAt?: Date | null;
  },
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const [leftId, rightId] = [input.leftId, input.rightId].sort();
  const pairKey = buildClusterConstraintPairKey(leftId, rightId);

  return db.clusterConstraint.upsert({
    where: {
      kind_scope_pairKey: {
        kind: input.kind,
        scope: input.scope,
        pairKey,
      },
    },
    create: {
      kind: input.kind,
      scope: input.scope,
      leftId,
      rightId,
      pairKey,
      reason: input.reason ?? null,
      createdBy: input.createdBy ?? "system",
      expiresAt: input.expiresAt ?? null,
    },
    update: {
      reason: input.reason ?? null,
      createdBy: input.createdBy ?? "system",
      expiresAt: input.expiresAt ?? null,
    },
  });
}

export async function createMustLinkForClusters(leftClusterId: string, rightClusterId: string, reason?: string) {
  if (leftClusterId === rightClusterId) {
    return null;
  }

  return upsertClusterConstraint({
    kind: "must_link",
    scope: "cluster_cluster",
    leftId: leftClusterId,
    rightId: rightClusterId,
    reason,
    createdBy: "manual",
  });
}

export async function createCannotLinkForClusters(leftClusterId: string, rightClusterId: string, reason?: string) {
  if (leftClusterId === rightClusterId) {
    return null;
  }

  return upsertClusterConstraint({
    kind: "cannot_link",
    scope: "cluster_cluster",
    leftId: leftClusterId,
    rightId: rightClusterId,
    reason,
    createdBy: "manual",
  });
}

export async function createCannotLinkForItems(leftItemId: string, rightItemId: string, reason?: string) {
  if (leftItemId === rightItemId) {
    return null;
  }

  return upsertClusterConstraint({
    kind: "cannot_link",
    scope: "item_item",
    leftId: leftItemId,
    rightId: rightItemId,
    reason,
    createdBy: "manual",
  });
}

export async function findBlockingClusterPairConstraint(input: {
  leftClusterId: string;
  rightClusterId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const clusterPairKey = buildClusterConstraintPairKey(input.leftClusterId, input.rightClusterId);
  const directConstraint = await prisma.clusterConstraint.findFirst({
    where: {
      kind: "cannot_link",
      scope: "cluster_cluster",
      pairKey: clusterPairKey,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  if (directConstraint) {
    return directConstraint;
  }

  const items = await prisma.item.findMany({
    where: {
      clusterId: { in: [input.leftClusterId, input.rightClusterId] },
      status: "processed",
      moderationStatus: { in: ["allowed", "restored"] },
    },
    select: {
      id: true,
      clusterId: true,
    },
  });
  const leftItemIds = items.filter((item) => item.clusterId === input.leftClusterId).map((item) => item.id);
  const rightItemIds = items.filter((item) => item.clusterId === input.rightClusterId).map((item) => item.id);
  const itemPairKeys: string[] = [];

  for (const leftItemId of leftItemIds) {
    for (const rightItemId of rightItemIds) {
      itemPairKeys.push(buildClusterConstraintPairKey(leftItemId, rightItemId));
    }
  }

  if (itemPairKeys.length === 0) {
    return null;
  }

  return prisma.clusterConstraint.findFirst({
    where: {
      kind: "cannot_link",
      scope: "item_item",
      pairKey: { in: itemPairKeys },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

export async function createCannotLinksBetweenItemSets(input: {
  leftItemIds: string[];
  rightItemIds: string[];
  reason: string;
}) {
  const pairs = new Set<string>();
  for (const leftItemId of input.leftItemIds) {
    for (const rightItemId of input.rightItemIds) {
      if (leftItemId !== rightItemId) {
        pairs.add(buildClusterConstraintPairKey(leftItemId, rightItemId));
      }
    }
  }

  if (pairs.size === 0) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const pairKey of pairs) {
      const [leftId, rightId] = pairKey.split("\u0000");
      await upsertClusterConstraint({
        kind: "cannot_link",
        scope: "item_item",
        leftId: leftId!,
        rightId: rightId!,
        reason: input.reason,
        createdBy: "manual",
      }, tx);
    }
  });
}
