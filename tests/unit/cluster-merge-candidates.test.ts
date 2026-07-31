import { describe, expect, it } from "vitest";

import { CLUSTER_MERGE_CANDIDATE_LIMIT, CLUSTER_MERGE_DIRTY_NEIGHBOR_SCAN_LIMIT } from "@/config/constants";
import {
  buildClusterMergeCandidateInputHash,
  buildClusterMergeCandidateSelection,
  buildClusterMergeCandidates,
  buildClusterMergeInput,
  filterClusterMergeSourcesByAllowedEdges,
  hasClusterMergeCandidateEdge,
  rankClusterCandidates,
  type ClusterMergeCandidate,
} from "@/lib/clusters/helpers";
import type { ClusterAssignmentCandidate } from "@/lib/clusters/repository";

function createCandidate(overrides: Partial<ClusterMergeCandidate>): ClusterMergeCandidate {
  return {
    id: "cluster",
    title: "聚合标题",
    summary: "聚合摘要",
    fingerprint: "fingerprint",
    mergeInputHash: null,
    eventType: null,
    eventSubject: null,
    eventAction: null,
    eventObject: null,
    eventDate: null,
    itemCount: 1,
    latestPublishedAt: new Date("2026-04-20T09:00:00.000Z"),
    ...overrides,
  };
}

function createAssignmentCandidate(overrides: Partial<ClusterAssignmentCandidate>): ClusterAssignmentCandidate {
  return {
    id: "assignment-candidate",
    title: "聚合标题",
    summary: "聚合摘要",
    fingerprint: "fingerprint",
    eventFingerprint: null,
    eventBucket: null,
    eventType: null,
    eventSubject: null,
    eventAction: null,
    eventObject: null,
    eventDate: null,
    latestPublishedAt: new Date("2026-04-20T09:00:00.000Z"),
    itemCount: 1,
    ...overrides,
  };
}

describe("buildClusterMergeCandidates", () => {
  it("uses the same canonical date compatibility rule for initial assignment", () => {
    const item = {
      originalTitle: "Acme 发布 Widget",
      translatedTitle: null,
      summaryText: "Acme 发布 Widget。",
      rssExcerpt: null,
      fullText: null,
      rssContent: null,
      publishedAt: new Date("2026-04-10T10:00:00.000Z"),
    } as unknown as Parameters<typeof rankClusterCandidates>[0];
    const eventSignature = {
      eventType: "launch" as const,
      eventSubject: "Acme",
      eventAction: "发布",
      eventObject: "Widget",
      eventDate: "2026年4月",
    };

    const compatible = rankClusterCandidates(item, eventSignature, [
      createAssignmentCandidate({
        id: "compatible",
        eventType: "launch",
        eventSubject: "Acme 公司",
        eventAction: "正式发布",
        eventObject: "新版 Widget 服务",
        eventDate: "2026-04-10",
      }),
    ]);
    const conflicting = rankClusterCandidates(item, { ...eventSignature, eventDate: "2026年5月" }, [
      createAssignmentCandidate({
        id: "conflicting",
        eventType: "launch",
        eventSubject: "Acme",
        eventAction: "发布",
        eventObject: "Widget",
        eventDate: "2026-04-10",
      }),
    ]);

    expect(compatible[0]?.strongMatch).toBe(true);
    expect(conflicting[0]?.dateCompatible).toBe(false);
    expect(conflicting[0]?.strongMatch).toBe(false);

    const objectConflict = rankClusterCandidates(item, eventSignature, [
      createAssignmentCandidate({
        id: "object-conflict",
        title: "Acme 发布 Pricing",
        summary: "Acme 发布 Pricing。",
        eventType: "launch",
        eventSubject: "Acme",
        eventAction: "发布",
        eventObject: "Pricing",
        eventDate: "2026-04-10",
      }),
    ]);
    expect(objectConflict[0]?.hardConflict).toBe(true);
  });

  it("does not keep existing multi-item clusters when no merge anchor is found", () => {
    const candidates = buildClusterMergeCandidates([
      createCandidate({
        id: "multi-product-a",
        title: "Acme 发布产品 A",
        summary: "Acme 发布产品 A。",
        fingerprint: "multi-product-a",
        eventType: "launch",
        eventSubject: "Acme",
        eventAction: "发布",
        eventObject: "产品 A",
        eventDate: "2026-04-20",
        itemCount: 2,
      }),
      createCandidate({
        id: "multi-funding-b",
        title: "Beta 完成 B 轮融资",
        summary: "Beta 获得新一轮融资。",
        fingerprint: "multi-funding-b",
        eventType: "funding",
        eventSubject: "Beta",
        eventAction: "融资",
        eventObject: "B 轮",
        eventDate: "2026-04-21",
        itemCount: 3,
        latestPublishedAt: new Date("2026-04-21T10:00:00.000Z"),
      }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("keeps multi-subject singleton events when object, action, date, and text anchors align", () => {
    const candidates = buildClusterMergeCandidates([
      createCandidate({
        id: "openai-contract",
        title: "OpenAI 与微软调整合作合同",
        summary: "OpenAI 和微软调整云服务合作合同条款。",
        fingerprint: "openai-contract",
        eventType: "partnership",
        eventSubject: "OpenAI",
        eventAction: "变更",
        eventObject: "微软合同",
        eventDate: "2026-04-20",
      }),
      createCandidate({
        id: "microsoft-contract",
        title: "微软和 OpenAI 调整合作协议",
        summary: "微软与 OpenAI 对合作合同进行变更。",
        fingerprint: "microsoft-contract",
        eventType: "partnership",
        eventSubject: "微软",
        eventAction: "变更",
        eventObject: "OpenAI 合同",
        eventDate: "2026-04-20",
        latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
      }),
    ]);

    expect(candidates.map((candidate) => candidate.id).sort()).toEqual(["microsoft-contract", "openai-contract"]);
  });

  it("keeps narrow multi-subject bridge pairs when time and distinctive anchors are strong", () => {
    const candidates = buildClusterMergeCandidates([
      createCandidate({
        id: "openai-stargate-shift",
        title: "OpenAI 调整 Stargate 星际之门计划转向算力租赁",
        summary: "OpenAI 的 Stargate 星际之门计划转向算力租赁和算力基础设施合作。",
        fingerprint: "openai-stargate-shift",
        eventType: "infrastructure",
        eventSubject: "OpenAI",
        eventAction: "调整战略",
        eventObject: "星际之门计划",
        eventDate: "2026-04-20",
      }),
      createCandidate({
        id: "oracle-stargate-infra",
        title: "Oracle 支持 OpenAI Stargate 算力租赁基础设施",
        summary: "Oracle 支持 OpenAI Stargate 算力租赁基础设施合作。",
        fingerprint: "oracle-stargate-infra",
        eventType: "infrastructure",
        eventSubject: "Oracle",
        eventAction: "支持建设",
        eventObject: "OpenAI 算力基础设施",
        eventDate: "2026-04-20",
        latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
      }),
    ]);

    expect(candidates.map((candidate) => candidate.id).sort()).toEqual([
      "openai-stargate-shift",
      "oracle-stargate-infra",
    ]);
  });

  it("emits only local related pair edges for AI merge input", () => {
    const selection = buildClusterMergeCandidateSelection([
      createCandidate({
        id: "baidu-ai-comic-base",
        title: "百度携手淄博师专共建山东首个AI漫剧创作基地",
        summary: "山东首家百度AI漫剧创作基地正式落户淄博。",
        fingerprint: "baidu-ai-comic-base",
        eventType: "partnership",
        eventSubject: "百度与淄博师范高等专科学校",
        eventAction: "合作",
        eventObject: "百度AI漫剧创作基地",
        eventDate: "2025-04-27",
      }),
      createCandidate({
        id: "git-am-fake-diff",
        title: "git-am 误把提交消息里的假 diff 当补丁",
        summary: "git-am 误把提交消息里的假 diff 当补丁。",
        fingerprint: "git-am-fake-diff",
        eventType: "other",
        eventSubject: "Git",
        eventAction: "披露漏洞",
        eventObject: "git-am",
        latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
      }),
      createCandidate({
        id: "zibo-ai-comic-base",
        title: "山东首家百度AI漫剧创作基地正式落户淄博",
        summary: "百度与淄博师范高等专科学校合作建设 AI 漫剧创作基地。",
        fingerprint: "zibo-ai-comic-base",
        eventType: "partnership",
        eventSubject: "百度与淄博师范高等专科学校",
        eventAction: "合作",
        eventObject: "百度AI漫剧创作基地",
        eventDate: "2025-04-27",
        latestPublishedAt: new Date("2026-04-20T11:00:00.000Z"),
      }),
    ]);

    expect(hasClusterMergeCandidateEdge(selection.allowedPairs, "baidu-ai-comic-base", "zibo-ai-comic-base")).toBe(true);
    expect(hasClusterMergeCandidateEdge(selection.allowedPairs, "baidu-ai-comic-base", "git-am-fake-diff")).toBe(false);
    expect(hasClusterMergeCandidateEdge(selection.allowedPairs, "zibo-ai-comic-base", "git-am-fake-diff")).toBe(false);

    const input = JSON.parse(buildClusterMergeInput(selection.candidates, selection.allowedPairs)) as {
      pairs: Array<{ left: { id: string }; right: { id: string }; score: number }>;
    };

    expect(input.pairs).toEqual([
      expect.objectContaining({
        left: expect.objectContaining({ id: "baidu-ai-comic-base" }),
        right: expect.objectContaining({ id: "zibo-ai-comic-base" }),
        score: expect.any(Number),
      }),
    ]);
  });

  it("filters AI returned merge groups by local target edges before execution", () => {
    const allowedPairs = [
      {
        leftId: "baidu-ai-comic-base",
        rightId: "zibo-ai-comic-base",
        score: 95,
      },
    ];

    expect(
      filterClusterMergeSourcesByAllowedEdges(
        "baidu-ai-comic-base",
        ["zibo-ai-comic-base", "git-am-fake-diff"],
        allowedPairs,
      ),
    ).toEqual(["zibo-ai-comic-base"]);
  });

  it("rejects multi-subject bridge pairs when explicit event dates differ", () => {
    const candidates = buildClusterMergeCandidates([
      createCandidate({
        id: "openai-stargate-shift",
        title: "OpenAI 调整 Stargate 星际之门计划转向算力租赁",
        summary: "OpenAI 的 Stargate 星际之门计划转向算力租赁和算力基础设施合作。",
        fingerprint: "openai-stargate-shift",
        eventType: "infrastructure",
        eventSubject: "OpenAI",
        eventAction: "调整战略",
        eventObject: "星际之门计划",
        eventDate: "2026-04-20",
      }),
      createCandidate({
        id: "oracle-stargate-infra",
        title: "Oracle 支持 OpenAI Stargate 算力租赁基础设施",
        summary: "Oracle 支持 OpenAI Stargate 算力租赁基础设施合作。",
        fingerprint: "oracle-stargate-infra",
        eventType: "infrastructure",
        eventSubject: "Oracle",
        eventAction: "支持建设",
        eventObject: "OpenAI 算力基础设施",
        eventDate: "2026-04-21",
        latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
      }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("accepts equivalent and lower-precision dates after canonicalization", () => {
    const candidates = buildClusterMergeCandidates([
      createCandidate({
        id: "acme-date-format-a",
        title: "Acme 发布 Widget",
        summary: "Acme 发布 Widget。",
        eventType: "launch",
        eventSubject: "Acme 公司",
        eventAction: "正式发布",
        eventObject: "新版 Widget 服务",
        eventDate: "2026/4/10",
      }),
      createCandidate({
        id: "acme-date-format-b",
        title: "Acme 发布 Widget",
        summary: "Acme 发布 Widget。",
        eventType: "launch",
        eventSubject: "Acme",
        eventAction: "发布",
        eventObject: "Widget",
        eventDate: "2026-04-10",
        latestPublishedAt: new Date("2026-04-10T10:00:00.000Z"),
      }),
    ]);

    expect(candidates.map((candidate) => candidate.id).sort()).toEqual([
      "acme-date-format-a",
      "acme-date-format-b",
    ]);

    const monthCandidates = buildClusterMergeCandidates([
      createCandidate({
        id: "acme-month-date",
        title: "Acme 发布 Widget",
        summary: "Acme 发布 Widget。",
        eventType: "launch",
        eventSubject: "Acme",
        eventAction: "发布",
        eventObject: "Widget",
        eventDate: "2026年4月",
      }),
      createCandidate({
        id: "acme-day-date",
        title: "Acme 发布 Widget",
        summary: "Acme 发布 Widget。",
        eventType: "launch",
        eventSubject: "Acme",
        eventAction: "发布",
        eventObject: "Widget",
        eventDate: "2026-04-10",
        latestPublishedAt: new Date("2026-04-10T10:00:00.000Z"),
      }),
    ]);

    expect(monthCandidates.map((candidate) => candidate.id).sort()).toEqual([
      "acme-day-date",
      "acme-month-date",
    ]);

    expect(
      buildClusterMergeCandidateInputHash(createCandidate({ eventDate: "2026/4/10" })),
    ).toBe(buildClusterMergeCandidateInputHash(createCandidate({ eventDate: "2026-04-10" })));
  });

  it("rejects multi-subject bridge pairs when overlap is only generic wording", () => {
    const candidates = buildClusterMergeCandidates([
      createCandidate({
        id: "acme-product",
        title: "Acme 发布新产品",
        summary: "Acme 发布新产品。",
        fingerprint: "acme-product",
        eventType: "launch",
        eventSubject: "Acme",
        eventAction: "发布",
        eventObject: "产品 A",
        eventDate: "2026-04-20",
      }),
      createCandidate({
        id: "beta-product",
        title: "Beta 发布新产品",
        summary: "Beta 发布新产品。",
        fingerprint: "beta-product",
        eventType: "launch",
        eventSubject: "Beta",
        eventAction: "发布",
        eventObject: "产品 B",
        eventDate: "2026-04-20",
        latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
      }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("skips already evaluated merge pairs when neither side changed", () => {
    const openaiContract = createCandidate({
      id: "openai-contract",
      title: "OpenAI 与微软调整合作合同",
      summary: "OpenAI 和微软调整云服务合作合同条款。",
      fingerprint: "openai-contract",
      eventType: "partnership",
      eventSubject: "OpenAI",
      eventAction: "变更",
      eventObject: "微软合同",
      eventDate: "2026-04-20",
      itemCount: 10,
    });
    const microsoftContract = createCandidate({
      id: "microsoft-contract",
      title: "微软和 OpenAI 调整合作协议",
      summary: "微软与 OpenAI 对合作合同进行变更。",
      fingerprint: "microsoft-contract",
      eventType: "partnership",
      eventSubject: "微软",
      eventAction: "变更",
      eventObject: "OpenAI 合同",
      eventDate: "2026-04-20",
      itemCount: 1,
      latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
    });

    const candidates = buildClusterMergeCandidates([
      {
        ...openaiContract,
        mergeInputHash: buildClusterMergeCandidateInputHash(openaiContract),
      },
      {
        ...microsoftContract,
        mergeInputHash: buildClusterMergeCandidateInputHash(microsoftContract),
      },
    ]);

    expect(candidates).toEqual([]);
  });

  it("skips clean-clean merge pairs before local scoring", () => {
    const openaiContract = createCandidate({
      id: "openai-contract",
      title: "OpenAI 与微软调整合作合同",
      summary: "OpenAI 和微软调整云服务合作合同条款。",
      fingerprint: "openai-contract",
      eventType: "partnership",
      eventSubject: "OpenAI",
      eventAction: "变更",
      eventObject: "微软合同",
      eventDate: "2026-04-20",
    });
    const microsoftContract = createCandidate({
      id: "microsoft-contract",
      title: "微软和 OpenAI 调整合作协议",
      summary: "微软与 OpenAI 对合作合同进行变更。",
      fingerprint: "microsoft-contract",
      eventType: "partnership",
      eventSubject: "微软",
      eventAction: "变更",
      eventObject: "OpenAI 合同",
      eventDate: "2026-04-20",
      latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
    });

    const selection = buildClusterMergeCandidateSelection([
      {
        ...openaiContract,
        mergeInputHash: buildClusterMergeCandidateInputHash(openaiContract),
      },
      {
        ...microsoftContract,
        mergeInputHash: buildClusterMergeCandidateInputHash(microsoftContract),
      },
    ]);

    expect(selection.candidates).toEqual([]);
    expect(selection.allowedPairs).toEqual([]);
    expect(selection.diagnostics.totalPairs).toBe(0);
    expect(selection.diagnostics.cleanPairsSkipped).toBe(2);
  });

  it("keeps evaluated neighbors when a related candidate is new or changed", () => {
    const evaluatedContract = createCandidate({
      id: "openai-contract",
      title: "OpenAI 与微软调整合作合同",
      summary: "OpenAI 和微软调整云服务合作合同条款。",
      fingerprint: "openai-contract",
      eventType: "partnership",
      eventSubject: "OpenAI",
      eventAction: "变更",
      eventObject: "微软合同",
      eventDate: "2026-04-20",
    });
    const changedContract = createCandidate({
      id: "microsoft-contract",
      title: "微软和 OpenAI 调整合作协议",
      summary: "微软与 OpenAI 对合作合同进行变更。",
      fingerprint: "microsoft-contract",
      eventType: "partnership",
      eventSubject: "微软",
      eventAction: "变更",
      eventObject: "OpenAI 合同",
      eventDate: "2026-04-20",
      latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
    });

    const candidates = buildClusterMergeCandidates([
      {
        ...evaluatedContract,
        mergeInputHash: buildClusterMergeCandidateInputHash(evaluatedContract),
      },
      {
        ...changedContract,
        mergeInputHash: "stale-hash",
      },
    ]);

    expect(candidates.map((candidate) => candidate.id)).toEqual(["microsoft-contract", "openai-contract"]);
  });

  it("limits live dirty neighbor scoring while keeping highly related clean neighbors", () => {
    const dirtyContract = createCandidate({
      id: "openai-contract-dirty",
      title: "OpenAI 与微软调整合作合同",
      summary: "OpenAI 和微软调整云服务合作合同条款。",
      fingerprint: "openai-contract-dirty",
      mergeInputHash: "stale-hash",
      eventType: "partnership",
      eventSubject: "OpenAI",
      eventAction: "变更",
      eventObject: "微软合同",
      eventDate: "2026-04-20",
    });
    const cleanContract = createCandidate({
      id: "microsoft-contract-clean",
      title: "微软和 OpenAI 调整合作协议",
      summary: "微软与 OpenAI 对合作合同进行变更。",
      fingerprint: "microsoft-contract-clean",
      eventType: "partnership",
      eventSubject: "微软",
      eventAction: "变更",
      eventObject: "OpenAI 合同",
      eventDate: "2026-04-20",
      latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
    });
    const cleanNoise = Array.from({ length: CLUSTER_MERGE_DIRTY_NEIGHBOR_SCAN_LIMIT + 40 }, (_, index) => {
      const candidate = createCandidate({
        id: `clean-noise-${index}`,
        title: `无关事件 ${index}`,
        summary: `无关事件摘要 ${index}`,
        fingerprint: `clean-noise-${index}`,
        eventType: "other",
        eventSubject: `Company ${index}`,
        eventAction: "发布",
        eventObject: `Product ${index}`,
        eventDate: "2026-04-19",
        latestPublishedAt: new Date(`2026-04-19T${String(index % 24).padStart(2, "0")}:00:00.000Z`),
      });

      return {
        ...candidate,
        mergeInputHash: buildClusterMergeCandidateInputHash(candidate),
      };
    });

    const selection = buildClusterMergeCandidateSelection([
      dirtyContract,
      {
        ...cleanContract,
        mergeInputHash: buildClusterMergeCandidateInputHash(cleanContract),
      },
      ...cleanNoise,
    ]);

    expect(selection.diagnostics.totalPairs).toBeLessThanOrEqual(CLUSTER_MERGE_DIRTY_NEIGHBOR_SCAN_LIMIT);
    expect(hasClusterMergeCandidateEdge(
      selection.allowedPairs,
      "openai-contract-dirty",
      "microsoft-contract-clean",
    )).toBe(true);
  });

  it("scores only scoped live clusters when live cluster ids are provided", () => {
    const currentDirty = createCandidate({
      id: "current-dirty",
      title: "OpenAI 与微软调整合作合同",
      summary: "OpenAI 和微软调整云服务合作合同条款。",
      fingerprint: "current-dirty",
      mergeInputHash: "stale-current",
      eventType: "partnership",
      eventSubject: "OpenAI",
      eventAction: "变更",
      eventObject: "微软合同",
      eventDate: "2026-04-20",
    });
    const currentNeighbor = createCandidate({
      id: "current-neighbor",
      title: "微软和 OpenAI 调整合作协议",
      summary: "微软与 OpenAI 对合作合同进行变更。",
      fingerprint: "current-neighbor",
      eventType: "partnership",
      eventSubject: "微软",
      eventAction: "变更",
      eventObject: "OpenAI 合同",
      eventDate: "2026-04-20",
      latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
    });
    const historicalDirty = createCandidate({
      id: "historical-dirty",
      title: "DeepSeek 灰度测试识图模式",
      summary: "DeepSeek 在网页版灰度测试上线识图模式。",
      fingerprint: "historical-dirty",
      mergeInputHash: "stale-historical",
      eventType: "update",
      eventSubject: "DeepSeek",
      eventAction: "上线",
      eventObject: "识图模式",
      latestPublishedAt: new Date("2026-04-20T11:00:00.000Z"),
    });
    const historicalNeighbor = createCandidate({
      id: "historical-neighbor",
      title: "DeepSeek 开启识图模式灰度测试",
      summary: "DeepSeek 新增识图模式入口和视觉理解能力。",
      fingerprint: "historical-neighbor",
      eventType: "update",
      eventSubject: "DeepSeek",
      eventAction: "开启灰度测试",
      eventObject: "多模态识图功能",
      latestPublishedAt: new Date("2026-04-20T12:00:00.000Z"),
    });

    const selection = buildClusterMergeCandidateSelection(
      [
        currentDirty,
        {
          ...currentNeighbor,
          mergeInputHash: buildClusterMergeCandidateInputHash(currentNeighbor),
        },
        historicalDirty,
        {
          ...historicalNeighbor,
          mergeInputHash: buildClusterMergeCandidateInputHash(historicalNeighbor),
        },
      ],
      { liveClusterIds: ["current-dirty"] },
    );

    expect(selection.candidates.map((candidate) => candidate.id).sort()).toEqual([
      "current-dirty",
      "current-neighbor",
    ]);
    expect(hasClusterMergeCandidateEdge(selection.allowedPairs, "historical-dirty", "historical-neighbor")).toBe(false);
  });

  it("rejects pairs that only share subject, action, and date but conflict on object", () => {
    const candidates = buildClusterMergeCandidates([
      createCandidate({
        id: "product-a",
        title: "Acme 发布产品 A",
        summary: "Acme 发布产品 A。",
        fingerprint: "product-a",
        eventType: "launch",
        eventSubject: "Acme",
        eventAction: "发布",
        eventObject: "产品 A",
        eventDate: "2026-04-20",
      }),
      createCandidate({
        id: "product-b",
        title: "Acme 发布产品 B",
        summary: "Acme 发布产品 B。",
        fingerprint: "product-b",
        eventType: "launch",
        eventSubject: "Acme",
        eventAction: "发布",
        eventObject: "产品 B",
        eventDate: "2026-04-20",
        latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
      }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("rejects object-conflict pairs even when subject and text overlap are strong", () => {
    const candidates = buildClusterMergeCandidates([
      createCandidate({
        id: "deepseek-vision-mode",
        title: "DeepSeek灰度测试识图模式拓展图文交互",
        summary: "DeepSeek 在网页版灰度测试上线识图模式，支持图片理解和多模态识别能力。",
        fingerprint: "deepseek-vision-mode",
        eventType: "update",
        eventSubject: "DeepSeek",
        eventAction: "上线",
        eventObject: "识图模式",
      }),
      createCandidate({
        id: "deepseek-multimodal-vision",
        title: "DeepSeek 开启识图模式灰度测试，多模态视觉理解能力正式落地",
        summary: "DeepSeek 正式开启多模态识图功能灰度测试，新增识图模式入口和视觉理解能力。",
        fingerprint: "deepseek-multimodal-vision",
        eventType: "update",
        eventSubject: "DeepSeek",
        eventAction: "开启灰度测试",
        eventObject: "多模态识图功能",
        latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
      }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("caps large merge candidate pools before sending them to AI", () => {
    const candidates = buildClusterMergeCandidates(
      Array.from({ length: CLUSTER_MERGE_CANDIDATE_LIMIT + 20 }, (_, index) =>
        createCandidate({
          id: `openai-contract-${index}`,
          title: `OpenAI 与微软调整合作合同 ${index}`,
          summary: "OpenAI 和微软调整云服务合作合同条款。",
          fingerprint: `openai-contract-${index}`,
          eventType: "partnership",
          eventSubject: index % 2 === 0 ? "OpenAI" : "微软",
          eventAction: "变更",
          eventObject: index % 2 === 0 ? "微软合同" : "OpenAI 合同",
          eventDate: "2026-04-20",
          latestPublishedAt: new Date(`2026-04-20T${String(index % 24).padStart(2, "0")}:00:00.000Z`),
        }),
      ),
    );

    expect(candidates).toHaveLength(CLUSTER_MERGE_CANDIDATE_LIMIT);
  });
});
