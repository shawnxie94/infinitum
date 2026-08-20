import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";

type ClusterCandidateTimeField = "latestPublishedAt" | "createdAt";

export type ClusterAssignmentCandidate = {
  id: string;
  title: string;
  summary: string;
  fingerprint: string;
  eventFingerprint: string | null;
  eventBucket: string | null;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  latestPublishedAt: Date;
  itemCount: number;
};

function clusterableItemWhere(): Prisma.ItemWhereInput {
  return {
    status: "processed" as const,
    moderationStatus: {
      in: ["allowed", "restored"],
    },
    OR: [
      {
        source: {
          aggregationEnabled: true,
        },
      },
      {
        parentItemId: {
          not: null,
        },
      },
    ],
  };
}

export async function findActiveClusterByFingerprint(
  fingerprint: string,
  since: Date,
  until?: Date,
  timeField: ClusterCandidateTimeField = "latestPublishedAt",
) {
  const timeFilter = timeField === "createdAt"
    ? { createdAt: { gte: since, ...(until ? { lte: until } : {}) } }
    : { latestPublishedAt: { gte: since, ...(until ? { lte: until } : {}) } };

  return prisma.contentCluster.findFirst({
    where: {
      fingerprint,
      status: "active",
      items: {
        some: clusterableItemWhere(),
      },
      ...timeFilter,
    },
    orderBy: timeField === "createdAt" ? [{ createdAt: "desc" }] : [{ latestPublishedAt: "desc" }],
  });
}

export async function findActiveClusterByTitle(
  title: string,
  since: Date,
  until?: Date,
  timeField: ClusterCandidateTimeField = "latestPublishedAt",
) {
  const normalizedTitle = title.trim();

  if (!normalizedTitle) {
    return null;
  }

  const timeFilter = timeField === "createdAt"
    ? { createdAt: { gte: since, ...(until ? { lte: until } : {}) } }
    : { latestPublishedAt: { gte: since, ...(until ? { lte: until } : {}) } };

  return prisma.contentCluster.findFirst({
    where: {
      title: normalizedTitle,
      status: "active",
      items: {
        some: clusterableItemWhere(),
      },
      ...timeFilter,
    },
    orderBy: timeField === "createdAt"
      ? [{ createdAt: "desc" }, { updatedAt: "desc" }]
      : [{ latestPublishedAt: "desc" }, { updatedAt: "desc" }],
  });
}

export async function findRecentActiveClusterCandidates(options: {
  since: Date;
  until: Date;
  timeField?: ClusterCandidateTimeField;
}) {
  const timeField = options.timeField ?? "latestPublishedAt";
  const timeFilter = timeField === "createdAt"
    ? { createdAt: { gte: options.since, lte: options.until } }
    : { latestPublishedAt: { gte: options.since, lte: options.until } };

  return prisma.contentCluster.findMany({
    where: {
      status: "active",
      items: {
        some: clusterableItemWhere(),
      },
      ...timeFilter,
    },
    select: {
      id: true,
      title: true,
      summary: true,
      fingerprint: true,
      eventFingerprint: true,
      eventBucket: true,
      eventType: true,
      eventSubject: true,
      eventAction: true,
      eventObject: true,
      eventDate: true,
      latestPublishedAt: true,
      itemCount: true,
    },
    orderBy: timeField === "createdAt"
      ? [{ createdAt: "desc" }, { updatedAt: "desc" }]
      : [{ latestPublishedAt: "desc" }, { updatedAt: "desc" }],
  }) as Promise<ClusterAssignmentCandidate[]>;
}

export async function createContentCluster(data: {
  fingerprint: string;
  eventFingerprint?: string | null;
  eventBucket?: string | null;
  title: string;
  summary: string;
  summaryInputHash?: string | null;
  score: number;
  itemCount?: number;
  latestPublishedAt: Date;
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
}) {
  return prisma.contentCluster.upsert({
    where: { fingerprint: data.fingerprint },
    update: {},
    create: {
      kind: "topic",
      title: data.title,
      summary: data.summary,
      summaryInputHash: data.summaryInputHash ?? null,
      score: data.score,
      itemCount: data.itemCount ?? 0,
      latestPublishedAt: data.latestPublishedAt,
      status: "active",
      fingerprint: data.fingerprint,
      eventFingerprint: data.eventFingerprint ?? null,
      eventBucket: data.eventBucket ?? null,
      eventType: data.eventType ?? null,
      eventSubject: data.eventSubject ?? null,
      eventAction: data.eventAction ?? null,
      eventObject: data.eventObject ?? null,
      eventDate: data.eventDate ?? null,
    },
  });
}

export async function setItemCluster(itemId: string, clusterId: string | null) {
  return prisma.item.update({
    where: { id: itemId },
    data: {
      clusterId,
    },
  });
}

export async function getClusterWithItems(clusterId: string) {
  return prisma.contentCluster.findUnique({
    where: { id: clusterId },
    include: {
      items: {
        where: {
          status: "processed",
          moderationStatus: {
            in: ["allowed", "restored"],
          },
        },
        include: { source: true },
        orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
      },
    },
  });
}

export async function updateClusterSummary(
  clusterId: string,
  data: {
    title: string;
    summary: string;
    summaryInputHash?: string | null;
    score: number;
    itemCount: number;
    latestPublishedAt: Date;
    status?: "active" | "hidden";
    eventType?: string | null;
    eventSubject?: string | null;
    eventAction?: string | null;
    eventObject?: string | null;
    eventDate?: string | null;
    eventFingerprint?: string | null;
    eventBucket?: string | null;
  },
) {
  return prisma.contentCluster.update({
    where: { id: clusterId },
    data,
  });
}

export async function deleteCluster(clusterId: string) {
  return prisma.contentCluster.delete({
    where: { id: clusterId },
  });
}

export async function updateClusterStatus(clusterId: string, status: "active" | "hidden") {
  return prisma.contentCluster.update({
    where: { id: clusterId },
    data: { status },
  });
}
