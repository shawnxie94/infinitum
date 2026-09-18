import type { ContentCluster, Item } from "@prisma/client";

import { prisma } from "@/lib/db";
import { getDisplayTitle } from "@/lib/feed/presentation";

/**
 * 人工反馈标签（Phase 3）：把管理台的人工动作回写为评估级聚类对标签，
 * 供 eval-embedding-recall 的 human-feedback 分层消费。verdict 沿用评估
 * 词汇（approved=同事件 / declined=不同事件）。写入是 best-effort：
 * 失败只记警告，不阻断管理动作本身。
 */

export type ClusterPairLabelSide = {
  kind: "cluster" | "item";
  id: string;
  title: string;
  summary: string;
  subject: string | null;
  object: string | null;
  action: string | null;
  type: string | null;
  date: string | null;
  itemCount: number;
};

function snapshotText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
}

function clusterToLabelSide(cluster: ContentCluster): ClusterPairLabelSide {
  return {
    kind: "cluster",
    id: cluster.id,
    title: snapshotText(cluster.title),
    summary: snapshotText(cluster.summary),
    subject: cluster.eventSubject,
    object: cluster.eventObject,
    action: cluster.eventAction,
    type: cluster.eventType,
    date: cluster.eventDate,
    itemCount: cluster.itemCount,
  };
}

function itemToLabelSide(item: Item): ClusterPairLabelSide {
  return {
    kind: "item",
    id: item.id,
    title: snapshotText(getDisplayTitle(item.originalTitle, item.translatedTitle)),
    summary: snapshotText(item.summaryText),
    subject: item.eventSubject,
    object: item.eventObject,
    action: item.eventAction,
    type: item.eventType,
    date: item.eventDate,
    itemCount: 1,
  };
}

async function writeClusterPairLabel(input: {
  verdict: "approved" | "declined";
  source: string;
  left: ClusterPairLabelSide;
  right: ClusterPairLabelSide;
}) {
  const { verdict, source, left, right } = input;
  try {
    const label = await prisma.clusterPairLabel.create({
      data: {
        verdict,
        source,
        leftKind: left.kind,
        leftId: left.id,
        rightId: right.id,
        titleA: left.title,
        titleB: right.title,
        summaryA: left.summary,
        summaryB: right.summary,
        subjectA: left.subject,
        subjectB: right.subject,
        objectA: left.object,
        objectB: right.object,
        actionA: left.action,
        actionB: right.action,
        typeA: left.type,
        typeB: right.type,
        dateA: left.date,
        dateB: right.date,
        itemCountA: left.itemCount,
        itemCountB: right.itemCount,
      },
      select: { id: true },
    });
    return label.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cluster-pair-label] 反馈标签写入失败（忽略）: ${message.slice(0, 200)}`);
    return null;
  }
}

export async function recordClusterPairLabelFromClusters(input: {
  verdict: "approved" | "declined";
  source: string;
  leftClusterId: string;
  rightClusterId: string;
}) {
  const clusters = await prisma.contentCluster.findMany({
    where: { id: { in: [input.leftClusterId, input.rightClusterId] } },
  });
  const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const left = byId.get(input.leftClusterId);
  const right = byId.get(input.rightClusterId);
  if (!left || !right) {
    return null;
  }
  return writeClusterPairLabel({
    verdict: input.verdict,
    source: input.source,
    left: clusterToLabelSide(left),
    right: clusterToLabelSide(right),
  });
}

export async function recordClusterPairLabelFromItem(input: {
  verdict: "approved" | "declined";
  source: string;
  itemId: string;
  clusterId: string;
}) {
  const [item, cluster] = await Promise.all([
    prisma.item.findUnique({ where: { id: input.itemId } }),
    prisma.contentCluster.findUnique({ where: { id: input.clusterId } }),
  ]);
  if (!item || !cluster) {
    return null;
  }
  return writeClusterPairLabel({
    verdict: input.verdict,
    source: input.source,
    left: itemToLabelSide(item),
    right: clusterToLabelSide(cluster),
  });
}

/**
 * 一键反馈（聚类级问题队列）：不拆解、不判定 pair，只记录「这个聚合看起来
 * 不对劲」，攒着事后集中分析。与 pair 级标签互补——分析时的拆解动作
 * （split/join/复核）会经上方回写产出精确标签。同一聚类已有 open 记录时去重。
 * 这是用户主动点击的主操作，失败直接抛错而非吞掉。
 */
export async function flagClusterForReview(input: {
  clusterId: string;
  note?: string | null;
}): Promise<{ flagged: boolean }> {
  const cluster = await prisma.contentCluster.findUnique({
    where: { id: input.clusterId },
    select: { id: true, title: true, summary: true, itemCount: true },
  });
  if (!cluster) {
    throw new Error("聚类不存在或已删除。");
  }

  const existing = await prisma.clusterFeedback.findFirst({
    where: { clusterId: cluster.id, status: "open" },
    select: { id: true },
  });
  if (existing) {
    return { flagged: false };
  }

  await prisma.clusterFeedback.create({
    data: {
      clusterId: cluster.id,
      clusterTitle: snapshotText(cluster.title),
      clusterSummary: snapshotText(cluster.summary).slice(0, 600),
      itemCount: cluster.itemCount,
      note: input.note ?? null,
    },
  });
  return { flagged: true };
}

export async function listOpenClusterFeedback(limit = 500) {
  return prisma.clusterFeedback.findMany({
    where: { status: "open" },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function resolveClusterFeedback(input: { id: string; note?: string | null }) {
  return prisma.clusterFeedback.update({
    where: { id: input.id },
    data: {
      status: "resolved",
      resolvedAt: new Date(),
      resolvedNote: input.note ?? null,
    },
  });
}
