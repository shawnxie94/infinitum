import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";

const requireAdmin = vi.fn();
const enqueueClusterSummaryTask = vi.fn();
const mergeClusters = vi.fn();
const splitClusterIntoSingletons = vi.fn();

vi.mock("@/lib/admin/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin/session")>();

  return {
    ...actual,
    requireAdmin,
  };
});

vi.mock("@/lib/clusters/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/service")>();

  return {
    ...actual,
    enqueueClusterSummaryTask,
    mergeClusters,
    splitClusterIntoSingletons,
  };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("/api/admin/clusters", () => {
  beforeEach(async () => {
    await prisma.clusterDecision.deleteMany();
    await prisma.clusterConstraint.deleteMany();
    await prisma.item.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.source.deleteMany();

    const source = await prisma.source.create({
      data: {
        name: "Cluster Feed",
        rssUrl: "https://cluster.example.com/feed.xml",
        siteUrl: "https://cluster.example.com",
        enabled: true,
        aiParsingEnabled: false,
      },
    });

    await prisma.contentCluster.create({
      data: {
        id: "cluster-1",
        kind: "topic",
        title: "OpenAI Agent launch",
        summary: "聚合摘要",
        score: 84,
        itemCount: 2,
        latestPublishedAt: new Date("2026-04-10T10:00:00.000Z"),
        status: "active",
        fingerprint: "openai-agent-launch",
      },
    });

    await prisma.contentCluster.create({
      data: {
        id: "cluster-singleton",
        kind: "topic",
        title: "全模态全尺寸全国发布",
        summary: "单条目聚合摘要",
        score: 72,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T08:00:00.000Z"),
        status: "active",
        fingerprint: "all-modal-all-size-national",
      },
    });

    await prisma.item.createMany({
      data: [
        {
          id: "cluster-item-1",
          sourceId: source.id,
          clusterId: "cluster-1",
          originalUrl: "https://cluster.example.com/1",
          canonicalUrl: "https://cluster.example.com/1",
          urlHash: "cluster-hash-1",
          originalTitle: "OpenAI launches agent toolkit",
          translatedTitle: "OpenAI 发布 agent 工具包",
          publishedAt: new Date("2026-04-10T10:00:00.000Z"),
          summaryText: "内容一",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 88,
          qualityRationale: "高质量",
          language: "en",
        },
        {
          id: "cluster-item-2",
          sourceId: source.id,
          clusterId: "cluster-1",
          originalUrl: "https://cluster.example.com/2",
          canonicalUrl: "https://cluster.example.com/2",
          urlHash: "cluster-hash-2",
          originalTitle: "Toolkit details from OpenAI",
          translatedTitle: "OpenAI 工具包细节",
          publishedAt: new Date("2026-04-10T09:00:00.000Z"),
          summaryText: "内容二",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 80,
          qualityRationale: "较高质量",
          language: "en",
        },
        {
          id: "cluster-item-singleton",
          sourceId: source.id,
          clusterId: "cluster-singleton",
          originalUrl: "https://cluster.example.com/singleton",
          canonicalUrl: "https://cluster.example.com/singleton",
          urlHash: "cluster-hash-singleton",
          originalTitle: "全模态全尺寸全国发布",
          translatedTitle: null,
          publishedAt: new Date("2026-04-10T08:00:00.000Z"),
          summaryText: "单条内容",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 72,
          qualityRationale: "可用内容",
          language: "zh",
        },
      ],
    });
  });

  it("lists clusters for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { GET } = await import("@/app/api/admin/clusters/route");
    const response = await GET(new Request("http://localhost/api/admin/clusters?minItemCount=2"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.clusters).toHaveLength(1);
    expect(json.total).toBe(1);
    expect(json.clusters[0]).toMatchObject({
      id: "cluster-1",
      itemCount: 2,
      status: "active",
    });
  });

  it("uses the same aggregate recommendation score as the public feed", async () => {
    requireAdmin.mockResolvedValue(undefined);
    await prisma.contentCluster.update({
      where: { id: "cluster-1" },
      data: { score: 100 },
    });

    const { GET } = await import("@/app/api/admin/clusters/route");
    const response = await GET(new Request("http://localhost/api/admin/clusters?minItemCount=2"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.clusters[0]).toMatchObject({
      id: "cluster-1",
      score: 84,
    });
  });

  it("orders admin clusters by latest child item update time", async () => {
    requireAdmin.mockResolvedValue(undefined);
    const source = await prisma.source.findFirstOrThrow({ where: { name: "Cluster Feed" } });

    await prisma.contentCluster.create({
      data: {
        id: "cluster-older-published-newer-updated",
        kind: "topic",
        title: "Compute infrastructure update",
        summary: "更新更晚的聚合",
        score: 76,
        itemCount: 2,
        latestPublishedAt: new Date("2026-04-09T10:00:00.000Z"),
        status: "active",
        fingerprint: "compute-infrastructure-update",
      },
    });

    await prisma.item.createMany({
      data: [
        {
          id: "cluster-update-item-1",
          sourceId: source.id,
          clusterId: "cluster-older-published-newer-updated",
          originalUrl: "https://cluster.example.com/update-1",
          canonicalUrl: "https://cluster.example.com/update-1",
          urlHash: "cluster-update-hash-1",
          originalTitle: "Compute infrastructure update",
          translatedTitle: null,
          publishedAt: new Date("2026-04-09T10:00:00.000Z"),
          summaryText: "更新内容一",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 76,
          qualityRationale: "可用内容",
          language: "en",
        },
        {
          id: "cluster-update-item-2",
          sourceId: source.id,
          clusterId: "cluster-older-published-newer-updated",
          originalUrl: "https://cluster.example.com/update-2",
          canonicalUrl: "https://cluster.example.com/update-2",
          urlHash: "cluster-update-hash-2",
          originalTitle: "Compute infrastructure update detail",
          translatedTitle: null,
          publishedAt: new Date("2026-04-09T09:00:00.000Z"),
          summaryText: "更新内容二",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 74,
          qualityRationale: "可用内容",
          language: "en",
        },
      ],
    });
    await prisma.item.update({
      where: { id: "cluster-update-item-2" },
      data: { summaryText: "最近被更新的内容" },
    });

    const { GET } = await import("@/app/api/admin/clusters/route");
    const response = await GET(new Request("http://localhost/api/admin/clusters?minItemCount=2"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.clusters.map((cluster: { id: string }) => cluster.id)).toEqual([
      "cluster-older-published-newer-updated",
      "cluster-1",
    ]);
    expect(json.clusters[0].latestItemUpdatedAt).toEqual(expect.any(String));
  });

  it("searches clusters with fuzzy Chinese keywords across child item titles", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { GET } = await import("@/app/api/admin/clusters/route");
    const response = await GET(new Request("http://localhost/api/admin/clusters?search=工具细节"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.clusters).toHaveLength(1);
    expect(json.total).toBe(1);
    expect(json.clusters[0].id).toBe("cluster-1");
  });

  it("does not search cluster summaries or child item details", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { GET } = await import("@/app/api/admin/clusters/route");
    const clusterSummaryResponse = await GET(new Request("http://localhost/api/admin/clusters?search=聚合摘要"));
    const itemSummaryResponse = await GET(new Request("http://localhost/api/admin/clusters?search=内容一"));
    const clusterSummaryJson = await clusterSummaryResponse.json();
    const itemSummaryJson = await itemSummaryResponse.json();

    expect(clusterSummaryResponse.status).toBe(200);
    expect(itemSummaryResponse.status).toBe(200);
    expect(clusterSummaryJson.clusters).toHaveLength(0);
    expect(itemSummaryJson.clusters).toHaveLength(0);
  });

  it("does not restrict singleton clusters unless minItemCount is provided", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { GET } = await import("@/app/api/admin/clusters/route");
    const restrictedResponse = await GET(
      new Request("http://localhost/api/admin/clusters?search=全模态全尺寸全国&minItemCount=2"),
    );
    const restrictedJson = await restrictedResponse.json();
    const defaultResponse = await GET(new Request("http://localhost/api/admin/clusters?search=全模态全尺寸全国"));
    const defaultJson = await defaultResponse.json();

    expect(restrictedResponse.status).toBe(200);
    expect(restrictedJson.clusters).toHaveLength(0);
    expect(defaultResponse.status).toBe(200);
    expect(defaultJson.clusters).toHaveLength(1);
    expect(defaultJson.clusters[0]).toMatchObject({
      id: "cluster-singleton",
      itemCount: 1,
    });
  });

  it("hides a cluster for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/clusters/[id]/hide/route");
    const response = await POST(
      new Request("http://localhost/api/admin/clusters/cluster-1/hide", { method: "POST" }),
      {
        params: Promise.resolve({ id: "cluster-1" }),
      },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.cluster.status).toBe("hidden");
  });

  it("queues a cluster summary regeneration task for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);
    enqueueClusterSummaryTask.mockResolvedValue({
      id: "task-cluster-1",
      kind: "cluster_regenerate_summary",
      status: "queued",
      triggerType: "admin_action",
      label: "重新生成聚合摘要",
      entityId: "cluster-1",
    });

    const { POST } = await import("@/app/api/admin/clusters/[id]/regenerate-summary/route");
    const response = await POST(
      new Request("http://localhost/api/admin/clusters/cluster-1/regenerate-summary", { method: "POST" }),
      {
        params: Promise.resolve({ id: "cluster-1" }),
      },
    );
    const json = await response.json();

    expect(response.status).toBe(202);
    expect(enqueueClusterSummaryTask).toHaveBeenCalledWith("cluster-1");
    expect(json.taskRun.id).toBe("task-cluster-1");
    expect(json.taskRun.kind).toBe("cluster_regenerate_summary");
  });

  it("splits all cluster items into singleton clusters for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);
    splitClusterIntoSingletons.mockResolvedValue({
      clusterId: "cluster-1",
      itemCount: 2,
      singletonClusterIds: ["single-a", "single-b"],
    });

    const { POST } = await import("@/app/api/admin/clusters/[id]/split/route");
    const response = await POST(
      new Request("http://localhost/api/admin/clusters/cluster-1/split", { method: "POST" }),
      {
        params: Promise.resolve({ id: "cluster-1" }),
      },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(splitClusterIntoSingletons).toHaveBeenCalledWith("cluster-1");
    expect(json).toEqual({
      success: true,
      cluster: null,
      result: {
        clusterId: "cluster-1",
        itemCount: 2,
        singletonClusterIds: ["single-a", "single-b"],
      },
    });
  });

  it("merges selected clusters for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);
    mergeClusters.mockResolvedValue({
      targetClusterId: "cluster-1",
      mergedClusterIds: ["cluster-2"],
      itemsMoved: 2,
      taskId: "task-merge-1",
    });

    const { POST } = await import("@/app/api/admin/clusters/merge/route");
    const response = await POST(
      new Request("http://localhost/api/admin/clusters/merge", {
        method: "POST",
        body: JSON.stringify({
          targetClusterId: "cluster-1",
          sourceClusterIds: ["cluster-2"],
        }),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(mergeClusters).toHaveBeenCalledWith("cluster-1", ["cluster-2"]);
    expect(json).toEqual({
      success: true,
      result: {
        targetClusterId: "cluster-1",
        mergedClusterIds: ["cluster-2"],
        itemsMoved: 2,
        taskId: "task-merge-1",
      },
    });
  });

  it("rejects invalid cluster merge requests before calling the service", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/clusters/merge/route");
    const response = await POST(
      new Request("http://localhost/api/admin/clusters/merge", {
        method: "POST",
        body: JSON.stringify({
          targetClusterId: "cluster-1",
          sourceClusterIds: ["cluster-1"],
        }),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("目标聚合组不能在待合并列表中");
    expect(mergeClusters).not.toHaveBeenCalled();
  });

  it("lists pending cluster review candidates for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);
    await prisma.contentCluster.create({
      data: {
        id: "cluster-review-source",
        kind: "topic",
        title: "OpenAI Agent launch follow-up",
        summary: "复核摘要",
        score: 78,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T07:00:00.000Z"),
        status: "active",
        fingerprint: "openai-agent-review-source",
      },
    });
    await prisma.clusterDecision.create({
      data: {
        id: "decision-review-1",
        kind: "cluster_pair",
        source: "llm",
        verdict: "ambiguous",
        leftClusterId: "cluster-1",
        rightClusterId: "cluster-review-source",
        pairKey: "cluster-1::cluster-review-source",
        inputHash: "review-input",
        localScore: 88,
        confidence: 62,
        reasonCode: "llm_ambiguous",
        reasonText: "主体一致但对象证据不足",
      },
    });
    await prisma.clusterDecision.create({
      data: {
        id: "decision-applied",
        kind: "cluster_pair",
        source: "llm",
        verdict: "approved",
        leftClusterId: "cluster-1",
        rightClusterId: "cluster-review-source",
        pairKey: "cluster-1::cluster-review-source",
        inputHash: "applied-input",
        appliedAt: new Date(),
        appliedAction: "manual_review_ignore",
      },
    });

    const { GET } = await import("@/app/api/admin/clusters/review-candidates/route");
    const response = await GET(new Request("http://localhost/api/admin/clusters/review-candidates?page=1&pageSize=5"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.total).toBe(1);
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0]).toMatchObject({
      id: "decision-review-1",
      verdict: "ambiguous",
      localScore: 88,
      reasonText: "主体一致但对象证据不足",
      leftCluster: {
        id: "cluster-1",
        title: "OpenAI Agent launch",
      },
      rightCluster: {
        id: "cluster-review-source",
        title: "OpenAI Agent launch follow-up",
      },
      targetClusterId: "cluster-1",
      sourceClusterId: "cluster-review-source",
    });
  });

  it("excludes orphaned cluster decisions before counting and paginating", async () => {
    requireAdmin.mockResolvedValue(undefined);
    await prisma.contentCluster.create({
      data: {
        id: "cluster-review-source",
        kind: "topic",
        title: "OpenAI Agent launch follow-up",
        summary: "复核摘要",
        score: 78,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T07:00:00.000Z"),
        status: "active",
        fingerprint: "openai-agent-review-source",
      },
    });
    await prisma.clusterDecision.createMany({
      data: [
        {
          id: "decision-review-valid",
          kind: "cluster_pair",
          source: "llm",
          verdict: "ambiguous",
          leftClusterId: "cluster-1",
          rightClusterId: "cluster-review-source",
          pairKey: "cluster-1::cluster-review-source",
          inputHash: "valid-input",
          createdAt: new Date("2026-04-10T07:00:00.000Z"),
        },
        {
          id: "decision-review-orphan-left",
          kind: "cluster_pair",
          source: "llm",
          verdict: "approved",
          leftClusterId: "missing-left-cluster",
          rightClusterId: "cluster-review-source",
          pairKey: "missing-left-cluster::cluster-review-source",
          inputHash: "orphan-left-input",
          createdAt: new Date("2026-04-10T09:00:00.000Z"),
        },
        {
          id: "decision-review-orphan-right",
          kind: "cluster_pair",
          source: "llm",
          verdict: "approved",
          leftClusterId: "cluster-1",
          rightClusterId: "missing-right-cluster",
          pairKey: "cluster-1::missing-right-cluster",
          inputHash: "orphan-right-input",
          createdAt: new Date("2026-04-10T08:00:00.000Z"),
        },
      ],
    });

    const { GET } = await import("@/app/api/admin/clusters/review-candidates/route");
    const response = await GET(new Request("http://localhost/api/admin/clusters/review-candidates?page=1&pageSize=1"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.total).toBe(1);
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].id).toBe("decision-review-valid");
  });

  it("merges a cluster review candidate and marks the decision applied", async () => {
    requireAdmin.mockResolvedValue(undefined);
    mergeClusters.mockResolvedValue({
      targetClusterId: "cluster-1",
      mergedClusterIds: ["cluster-review-source"],
      itemsMoved: 1,
      taskId: "task-review-merge",
    });
    await prisma.contentCluster.create({
      data: {
        id: "cluster-review-source",
        kind: "topic",
        title: "OpenAI Agent launch follow-up",
        summary: "复核摘要",
        score: 78,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T07:00:00.000Z"),
        status: "active",
        fingerprint: "openai-agent-review-source",
      },
    });
    await prisma.clusterDecision.create({
      data: {
        id: "decision-review-merge",
        kind: "cluster_pair",
        source: "llm",
        verdict: "approved",
        leftClusterId: "cluster-1",
        rightClusterId: "cluster-review-source",
        pairKey: "cluster-1::cluster-review-source",
        inputHash: "review-input",
      },
    });

    const { POST } = await import("@/app/api/admin/clusters/review-candidates/[id]/merge/route");
    const response = await POST(
      new Request("http://localhost/api/admin/clusters/review-candidates/decision-review-merge/merge", {
        method: "POST",
      }),
      {
        params: Promise.resolve({ id: "decision-review-merge" }),
      },
    );
    const json = await response.json();
    const decision = await prisma.clusterDecision.findUniqueOrThrow({
      where: { id: "decision-review-merge" },
    });

    expect(response.status).toBe(200);
    expect(mergeClusters).toHaveBeenCalledWith("cluster-1", ["cluster-review-source"]);
    expect(json.result.taskId).toBe("task-review-merge");
    expect(decision.appliedAction).toBe("manual_review_merge");
    expect(decision.appliedAt).toBeInstanceOf(Date);
  });

  it("ignores a cluster review candidate by creating a cannot-link constraint", async () => {
    requireAdmin.mockResolvedValue(undefined);
    await prisma.contentCluster.create({
      data: {
        id: "cluster-review-source",
        kind: "topic",
        title: "OpenAI Agent launch follow-up",
        summary: "复核摘要",
        score: 78,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T07:00:00.000Z"),
        status: "active",
        fingerprint: "openai-agent-review-source",
      },
    });
    await prisma.clusterDecision.create({
      data: {
        id: "decision-review-ignore",
        kind: "cluster_pair",
        source: "llm",
        verdict: "ambiguous",
        leftClusterId: "cluster-1",
        rightClusterId: "cluster-review-source",
        pairKey: "cluster-1::cluster-review-source",
        inputHash: "review-input",
      },
    });

    const { POST } = await import("@/app/api/admin/clusters/review-candidates/[id]/ignore/route");
    const response = await POST(
      new Request("http://localhost/api/admin/clusters/review-candidates/decision-review-ignore/ignore", {
        method: "POST",
      }),
      {
        params: Promise.resolve({ id: "decision-review-ignore" }),
      },
    );
    const json = await response.json();
    const [decision, constraint] = await Promise.all([
      prisma.clusterDecision.findUniqueOrThrow({ where: { id: "decision-review-ignore" } }),
      prisma.clusterConstraint.findFirstOrThrow({
        where: {
          kind: "cannot_link",
          scope: "cluster_cluster",
        },
      }),
    ]);

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(decision.appliedAction).toBe("manual_review_ignore");
    expect(constraint).toMatchObject({
      leftId: "cluster-1",
      rightId: "cluster-review-source",
      createdBy: "manual",
      reason: "manual review ignored",
    });
  });
});
