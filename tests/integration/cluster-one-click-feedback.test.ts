import { afterEach, describe, expect, it } from "vitest";

import {
  flagClusterForReview,
  listOpenClusterFeedback,
  resolveClusterFeedback,
} from "@/lib/clusters/feedback";
import { prisma } from "@/lib/db";

const CLUSTER_ID = "one-click-cluster-1";

async function seedCluster() {
  await prisma.contentCluster.create({
    data: {
      id: CLUSTER_ID,
      title: "OpenAI 发布 GPT-6 Astra 模型",
      summary: "OpenAI 正式发布 GPT-6 Astra",
      score: 80,
      itemCount: 3,
      latestPublishedAt: new Date("2026-09-18T10:00:00.000Z"),
      status: "active",
      fingerprint: "one-click-fp",
    },
  });
}

afterEach(async () => {
  await prisma.clusterFeedback.deleteMany({ where: { clusterId: CLUSTER_ID } });
  await prisma.contentCluster.deleteMany({ where: { id: CLUSTER_ID } });
});

describe("one-click cluster feedback", () => {
  it("flags a cluster with a snapshot and dedupes open flags", async () => {
    await seedCluster();

    const first = await flagClusterForReview({ clusterId: CLUSTER_ID });
    expect(first.flagged).toBe(true);

    const rows = await prisma.clusterFeedback.findMany({ where: { clusterId: CLUSTER_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("open");
    expect(rows[0]!.clusterTitle).toBe("OpenAI 发布 GPT-6 Astra 模型");
    expect(rows[0]!.itemCount).toBe(3);

    // 重复点击去重
    const second = await flagClusterForReview({ clusterId: CLUSTER_ID });
    expect(second.flagged).toBe(false);
    expect(await prisma.clusterFeedback.count({ where: { clusterId: CLUSTER_ID } })).toBe(1);
  });

  it("resolves a flag and allows flagging again", async () => {
    await seedCluster();
    await flagClusterForReview({ clusterId: CLUSTER_ID });

    const open = await listOpenClusterFeedback();
    const target = open.find((row) => row.clusterId === CLUSTER_ID);
    expect(target).toBeDefined();

    await resolveClusterFeedback({ id: target!.id, note: "已拆分处理" });
    expect(await listOpenClusterFeedback().then((rows) => rows.some((row) => row.clusterId === CLUSTER_ID))).toBe(false);

    // 解决后可再次反馈（新的异常出现）
    const again = await flagClusterForReview({ clusterId: CLUSTER_ID });
    expect(again.flagged).toBe(true);
  });

  it("throws for a missing cluster", async () => {
    await expect(flagClusterForReview({ clusterId: "missing-cluster" })).rejects.toThrow("聚类不存在");
  });
});
