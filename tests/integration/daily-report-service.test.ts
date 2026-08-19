import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";
import {
  buildDailyReportTitle,
  executeDailyReportTask,
  generateDailyReport,
} from "@/lib/daily-report/service";
import { getDailyReportByDate, listDailyReportCandidates } from "@/lib/daily-report/repository";
import { updateBriefingPreferenceConfig, updateEventBriefingConfig } from "@/lib/settings/service";
import { ensureRuntimeConfigSeeded } from "@/lib/settings/core";

const {
  assessDailyReportCandidatesMock,
  planDailyReportMock,
  writeDailyReportMock,
} = vi.hoisted(() => ({
  assessDailyReportCandidatesMock: vi.fn(),
  planDailyReportMock: vi.fn(),
  writeDailyReportMock: vi.fn(),
}));

vi.mock("@/lib/ai/provider", () => ({
  createAiProvider: vi.fn(() => ({
    assessDailyReportCandidates: assessDailyReportCandidatesMock,
    planDailyReport: planDailyReportMock,
    writeDailyReport: async (input: unknown) => {
      const output = await writeDailyReportMock(input);
      return typeof output === "string" ? JSON.parse(output) : output;
    },
  })),
}));

const REPORT_DATE = "2026-04-24";

type SelectedTopicFixture = {
  topicId: string;
  blockKey: string;
  candidateIds: number[];
};

function buildDailyReportOutput(input: number | SelectedTopicFixture[] = 2) {
  const selectedTopics = typeof input === "number"
    ? Array.from({ length: input }, (_, index) => ({
        topicId: `topic-${index + 1}`,
        blockKey: index < Math.ceil(input / 2) ? "hot-topics" : "changes-practice",
        candidateIds: [index + 1],
      }))
    : input;
  const makeItems = (topics: Array<{ topicId: string; candidateIds: number[] }>, prefix: string) => topics.map((topic, index) => ({
    topicId: topic.topicId,
    title: index === 0 && prefix === "热点" ? "OpenAI 发布新模型" : `${prefix}条目 ${index + 1}`,
    body: `${prefix}主题正文，说明事件主体、动作、结果和影响。`,
    ...(prefix === "热点" && index === 0 ? { notes: [{ label: "重点", text: "模型能力继续增强" }] } : {}),
    sourceIds: topic.candidateIds,
  }));
  const hotTopics = selectedTopics.filter((topic) => topic.blockKey === "hot-topics");
  const changeTopics = selectedTopics.filter((topic) => topic.blockKey === "changes-practice");
  const blocks = [
    {
      type: "text" as const,
      title: "摘要",
      body: "今天 AI 生态的重点变化集中在模型发布、开发者工具更新与工程实践调整，值得关注其对产品迭代和开发流程的影响。",
    },
    ...(hotTopics.length > 0 ? [{
      type: "section" as const,
      blockKey: "hot-topics",
      title: "热点事件",
      items: makeItems(hotTopics, "热点"),
    }] : []),
    ...(changeTopics.length > 0 ? [{
      type: "section" as const,
      blockKey: "changes-practice",
      title: "变更与实践",
      items: makeItems(changeTopics, "实践"),
    }] : []),
    {
      type: "text" as const,
      title: "趋势观察",
      body: "整体来看，今天的主线仍是模型能力与工程工具继续耦合，后续需要观察实际开发效率是否随之改善。",
    },
  ];
  return JSON.stringify({
    headline: "OpenAI 发布新模型、开发者工具更新",
    blocks,
  });
}

function getLastGeneratedDailyReportArticles() {
  return getLastGeneratedDailyReportInput()?.articles ?? [];
}

function getLastGeneratedDailyReportInput() {
  const selectedTopics = writeDailyReportMock.mock.calls.at(-1)?.[0]?.selectedTopics;
  const recentTopics = planDailyReportMock.mock.calls.at(-1)?.[0]?.recentTopics;
  if (!selectedTopics) return undefined;
  return {
    articles: selectedTopics.flatMap((topic: { candidates?: unknown[] }) => topic.candidates ?? []),
    recentTopics,
  } as {
    articles: Array<{
      id: number;
      itemId: string;
      clusterId: string | null;
      title: string;
      eventType: string | null;
      eventSubject: string | null;
      eventAction: string | null;
      eventObject: string | null;
      eventDate: string | null;
      qualityScore: number;
      candidateScore: number;
      sourceCount: number;
      itemCount: number;
      isFollowUp?: boolean;
      newItemCountOnDate?: number;
      newSourceCountOnDate?: number;
      evidenceItems?: Array<{
        title: string;
        sourceName: string;
        summary: string;
        url: string;
        publishedAt: string;
        createdAt: string;
        qualityScore: number;
      }>;
    }>;
    recentTopics: Array<{
      date: string;
      sourceNumber: number | null;
      sectionName: string | null;
      topic: string | null;
      title: string;
      eventSubject: string | null;
      eventObject: string | null;
    }>;
  } | undefined;
}

async function createReportCandidates() {
  const source = await prisma.source.create({
    data: {
      name: "Test Source",
      rssUrl: "https://example.com/feed.xml",
      siteUrl: "https://example.com",
    },
  });

  await prisma.item.createMany({
    data: [
      {
        sourceId: source.id,
        originalUrl: "https://example.com/a",
        canonicalUrl: "https://example.com/a",
        urlHash: "daily-item-a",
        originalTitle: "OpenAI 发布新模型",
        publishedAt: new Date("2026-04-24T01:00:00.000Z"),
        createdAt: new Date("2026-04-24T01:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "OpenAI 发布新模型摘要",
        qualityScore: 90,
      },
      {
        sourceId: source.id,
        originalUrl: "https://example.com/b",
        canonicalUrl: "https://example.com/b",
        urlHash: "daily-item-b",
        originalTitle: "开发者工具更新",
        publishedAt: new Date("2026-04-24T02:00:00.000Z"),
        createdAt: new Date("2026-04-24T02:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "开发者工具更新摘要",
        qualityScore: 80,
      },
      {
        sourceId: source.id,
        originalUrl: "https://example.com/c",
        canonicalUrl: "https://example.com/c",
        urlHash: "daily-item-c",
        originalTitle: "开发者社区发布插件规范",
        publishedAt: new Date("2026-04-24T03:00:00.000Z"),
        createdAt: new Date("2026-04-24T03:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "开发者社区发布插件规范摘要",
        qualityScore: 75,
      },
      {
        sourceId: source.id,
        originalUrl: "https://example.com/d",
        canonicalUrl: "https://example.com/d",
        urlHash: "daily-item-d",
        originalTitle: "Claude Code 支持子代理工作流",
        publishedAt: new Date("2026-04-24T04:00:00.000Z"),
        createdAt: new Date("2026-04-24T04:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "Claude Code 支持子代理工作流摘要",
        qualityScore: 70,
      },
    ],
  });
}

async function createEventSignatureCandidates() {
  const source = await prisma.source.create({
    data: {
      name: "Event Source",
      rssUrl: "https://event-source.example.com/feed.xml",
      siteUrl: "https://event-source.example.com",
    },
  });

  await prisma.item.createMany({
    data: [
      {
        sourceId: source.id,
        originalUrl: "https://event-source.example.com/duplicate-model-release",
        canonicalUrl: "https://event-source.example.com/duplicate-model-release",
        urlHash: "event-duplicate-model-release",
        originalTitle: "Anthropic 发布 Claude 4",
        publishedAt: new Date("2026-04-24T01:00:00.000Z"),
        createdAt: new Date("2026-04-24T01:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "Anthropic 发布 Claude 4 摘要",
        qualityScore: 99,
        eventType: "release",
        eventSubject: "Anthropic",
        eventAction: "发布",
        eventObject: "Claude 4",
        eventDate: "2026-04-20",
      },
      {
        sourceId: source.id,
        originalUrl: "https://event-source.example.com/new-date-model-release",
        canonicalUrl: "https://event-source.example.com/new-date-model-release",
        urlHash: "event-new-date-model-release",
        originalTitle: "Anthropic 发布 Claude 4 新进展",
        publishedAt: new Date("2026-04-24T02:00:00.000Z"),
        createdAt: new Date("2026-04-24T02:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "Anthropic 发布 Claude 4 新进展摘要",
        qualityScore: 94,
        eventType: "release",
        eventSubject: "Anthropic",
        eventAction: "发布",
        eventObject: "Claude 4",
        eventDate: REPORT_DATE,
      },
      {
        sourceId: source.id,
        originalUrl: "https://event-source.example.com/model-update",
        canonicalUrl: "https://event-source.example.com/model-update",
        urlHash: "event-model-update",
        originalTitle: "Anthropic 更新 Claude 4",
        publishedAt: new Date("2026-04-24T03:00:00.000Z"),
        createdAt: new Date("2026-04-24T03:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "Anthropic 更新 Claude 4 摘要",
        qualityScore: 93,
        eventType: "update",
        eventSubject: "Anthropic",
        eventAction: "更新",
        eventObject: "Claude 4",
        eventDate: "2026-04-20",
      },
      {
        sourceId: source.id,
        originalUrl: "https://event-source.example.com/other-tool",
        canonicalUrl: "https://event-source.example.com/other-tool",
        urlHash: "event-other-tool",
        originalTitle: "独立工具发布",
        publishedAt: new Date("2026-04-24T04:00:00.000Z"),
        createdAt: new Date("2026-04-24T04:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "独立工具发布摘要",
        qualityScore: 80,
        eventType: "launch",
        eventSubject: "独立团队",
        eventAction: "发布",
        eventObject: "独立工具",
        eventDate: REPORT_DATE,
      },
    ],
  });
}

async function createClusteredReportCandidates() {
  const [sourceA, sourceB, sourceC, sourceD] = await Promise.all([
    prisma.source.create({
      data: {
        name: "Source A",
        rssUrl: "https://source-a.example.com/feed.xml",
        siteUrl: "https://source-a.example.com",
      },
    }),
    prisma.source.create({
      data: {
        name: "Source B",
        rssUrl: "https://source-b.example.com/feed.xml",
        siteUrl: "https://source-b.example.com",
      },
    }),
    prisma.source.create({
      data: {
        name: "Source C",
        rssUrl: "https://source-c.example.com/feed.xml",
        siteUrl: "https://source-c.example.com",
      },
    }),
    prisma.source.create({
      data: {
        name: "Source D",
        rssUrl: "https://source-d.example.com/feed.xml",
        siteUrl: "https://source-d.example.com",
      },
    }),
  ]);
  const cluster = await prisma.contentCluster.create({
    data: {
      title: "多来源确认的模型发布",
      summary: "多家来源确认同一个模型发布事件，具备更高日报价值。",
      score: 89,
      itemCount: 3,
      latestPublishedAt: new Date("2026-04-24T05:00:00.000Z"),
      fingerprint: "daily-report-clustered-model-launch",
      eventType: "launch",
    },
  });

  await prisma.item.createMany({
    data: [
      {
        sourceId: sourceA.id,
        clusterId: cluster.id,
        originalUrl: "https://source-a.example.com/model-launch",
        canonicalUrl: "https://source-a.example.com/model-launch",
        urlHash: "clustered-item-a",
        originalTitle: "模型发布 来源 A",
        publishedAt: new Date("2026-04-24T03:00:00.000Z"),
        createdAt: new Date("2026-04-24T03:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "来源 A 模型发布摘要",
        qualityScore: 89,
      },
      {
        sourceId: sourceB.id,
        clusterId: cluster.id,
        originalUrl: "https://source-b.example.com/model-launch",
        canonicalUrl: "https://source-b.example.com/model-launch",
        urlHash: "clustered-item-b",
        originalTitle: "模型发布 来源 B",
        publishedAt: new Date("2026-04-24T04:00:00.000Z"),
        createdAt: new Date("2026-04-24T04:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "来源 B 模型发布摘要",
        qualityScore: 86,
      },
      {
        sourceId: sourceC.id,
        clusterId: cluster.id,
        originalUrl: "https://source-c.example.com/model-launch",
        canonicalUrl: "https://source-c.example.com/model-launch",
        urlHash: "clustered-item-c",
        originalTitle: "模型发布 来源 C",
        publishedAt: new Date("2026-04-24T05:00:00.000Z"),
        createdAt: new Date("2026-04-24T05:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "来源 C 模型发布摘要",
        qualityScore: 84,
      },
      {
        sourceId: sourceD.id,
        originalUrl: "https://source-d.example.com/single-high-score",
        canonicalUrl: "https://source-d.example.com/single-high-score",
        urlHash: "daily-single-high-score",
        originalTitle: "单篇高分工具更新",
        publishedAt: new Date("2026-04-24T06:00:00.000Z"),
        createdAt: new Date("2026-04-24T06:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "单篇高分工具更新摘要",
        qualityScore: 95,
      },
    ],
  });

  return { cluster };
}

async function createLargeClusteredReportCandidates() {
  const sources = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      prisma.source.create({
        data: {
          name: `Large Cluster Source ${index + 1}`,
          rssUrl: `https://large-${index + 1}.example.com/feed.xml`,
          siteUrl: `https://large-${index + 1}.example.com`,
        },
      }),
    ),
  );
  const cluster = await prisma.contentCluster.create({
    data: {
      title: "大型聚合模型发布",
      summary: "很多来源报道同一个模型发布事件。",
      score: 91,
      itemCount: sources.length,
      latestPublishedAt: new Date("2026-04-24T08:00:00.000Z"),
      fingerprint: "large-daily-report-cluster",
      eventType: "launch",
    },
  });

  await prisma.item.createMany({
    data: sources.map((source, index) => ({
      sourceId: source.id,
      clusterId: cluster.id,
      originalUrl: `https://large-${index + 1}.example.com/model-launch`,
      canonicalUrl: `https://large-${index + 1}.example.com/model-launch`,
      urlHash: `large-clustered-item-${index + 1}`,
      originalTitle: `大型模型发布 来源 ${index + 1}`,
      publishedAt: new Date(`2026-04-24T0${index + 1}:00:00.000Z`),
      createdAt: new Date(`2026-04-24T0${index + 1}:00:00.000Z`),
      status: "processed",
      moderationStatus: "allowed",
      summaryText: `来源 ${index + 1} 模型发布摘要`,
      qualityScore: 95 - index,
    })),
  });
  await prisma.item.create({
    data: {
      sourceId: sources[0]!.id,
      originalUrl: "https://large-1.example.com/standalone-tool",
      canonicalUrl: "https://large-1.example.com/standalone-tool",
      urlHash: "large-clustered-standalone-tool",
      originalTitle: "独立工具更新",
      publishedAt: new Date("2026-04-24T08:00:00.000Z"),
      createdAt: new Date("2026-04-24T08:00:00.000Z"),
      status: "processed",
      moderationStatus: "allowed",
      summaryText: "独立工具更新摘要",
      qualityScore: 70,
    },
  });

  return { cluster };
}

async function createSoftDuplicateReportCandidates() {
  const source = await prisma.source.create({
    data: {
      name: "Soft Duplicate Source",
      rssUrl: "https://soft-duplicate.example.com/feed.xml",
      siteUrl: "https://soft-duplicate.example.com",
    },
  });

  await prisma.item.createMany({
    data: [
      {
        sourceId: source.id,
        originalUrl: "https://soft-duplicate.example.com/openai-broadcom-chip",
        canonicalUrl: "https://soft-duplicate.example.com/openai-broadcom-chip",
        urlHash: "soft-duplicate-openai-chip",
        originalTitle: "OpenAI联合Broadcom发布自研推理芯片Jalapeño",
        publishedAt: new Date("2026-04-24T01:00:00.000Z"),
        createdAt: new Date("2026-04-24T01:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "OpenAI 和 Broadcom 推出 Jalapeño 推理芯片。",
        qualityScore: 99,
        eventType: "partnership",
        eventSubject: "OpenAI",
        eventAction: "合作",
        eventObject: "自研 AI 芯片 Jalapeño",
        eventDate: REPORT_DATE,
      },
      {
        sourceId: source.id,
        originalUrl: "https://soft-duplicate.example.com/new-agent-runtime",
        canonicalUrl: "https://soft-duplicate.example.com/new-agent-runtime",
        urlHash: "soft-duplicate-new-agent-runtime",
        originalTitle: "新 Agent 运行时发布",
        publishedAt: new Date("2026-04-24T02:00:00.000Z"),
        createdAt: new Date("2026-04-24T02:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "新 Agent 运行时摘要",
        qualityScore: 90,
        eventType: "release",
        eventSubject: "Agent Runtime",
        eventAction: "发布",
        eventObject: "运行时",
        eventDate: REPORT_DATE,
      },
      {
        sourceId: source.id,
        originalUrl: "https://soft-duplicate.example.com/new-eval",
        canonicalUrl: "https://soft-duplicate.example.com/new-eval",
        urlHash: "soft-duplicate-new-eval",
        originalTitle: "新评测基准发布",
        publishedAt: new Date("2026-04-24T03:00:00.000Z"),
        createdAt: new Date("2026-04-24T03:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "新评测基准摘要",
        qualityScore: 85,
        eventType: "release",
        eventSubject: "Eval Lab",
        eventAction: "发布",
        eventObject: "评测基准",
        eventDate: REPORT_DATE,
      },
    ],
  });
}

async function createCreatedAtBoundaryCandidates() {
  const source = await prisma.source.create({
    data: {
      name: "Date Boundary Source",
      rssUrl: "https://date-boundary.example.com/feed.xml",
      siteUrl: "https://date-boundary.example.com",
    },
  });

  await prisma.item.createMany({
    data: [
      {
        sourceId: source.id,
        originalUrl: "https://date-boundary.example.com/created-date-match",
        canonicalUrl: "https://date-boundary.example.com/created-date-match",
        urlHash: "daily-created-date-match",
        originalTitle: "入库日期命中日报日期",
        publishedAt: new Date("2026-04-20T01:00:00.000Z"),
        createdAt: new Date("2026-04-24T03:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "入库日期命中日报日期摘要",
        qualityScore: 90,
        eventDate: "2026-04-20",
      },
      {
        sourceId: source.id,
        originalUrl: "https://date-boundary.example.com/created-date-second-match",
        canonicalUrl: "https://date-boundary.example.com/created-date-second-match",
        urlHash: "daily-created-date-second-match",
        originalTitle: "入库日期再次命中日报日期",
        publishedAt: new Date("2026-04-24T02:00:00.000Z"),
        createdAt: new Date("2026-04-24T04:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "入库日期再次命中日报日期摘要",
        qualityScore: 88,
      },
      {
        sourceId: source.id,
        originalUrl: "https://date-boundary.example.com/event-date-only-match",
        canonicalUrl: "https://date-boundary.example.com/event-date-only-match",
        urlHash: "daily-event-date-only-match",
        originalTitle: "仅事件日期命中日报日期",
        publishedAt: new Date("2026-04-24T03:00:00.000Z"),
        createdAt: new Date("2026-04-20T03:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "仅事件日期命中日报日期摘要",
        qualityScore: 99,
        eventDate: REPORT_DATE,
      },
      {
        sourceId: source.id,
        originalUrl: "https://date-boundary.example.com/published-date-only-match",
        canonicalUrl: "https://date-boundary.example.com/published-date-only-match",
        urlHash: "daily-published-date-only-match",
        originalTitle: "仅发布时间命中日报日期",
        publishedAt: new Date("2026-04-24T04:00:00.000Z"),
        createdAt: new Date("2026-04-20T04:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "仅发布时间命中日报日期摘要",
        qualityScore: 98,
      },
    ],
  });
}

async function createPublishedReport() {
  return prisma.dailyReport.create({
    data: {
      date: REPORT_DATE,
      timezone: "Asia/Shanghai",
      status: "published",
      title: `${REPORT_DATE} AI 日报`,
      openingSummary: "已发布摘要",
      closingThought: "已发布观察",
      summaryJson: buildDailyReportOutput(),
      renderedMarkdown: "# 已发布日报\n",
      inputHash: "old-input",
      modelName: "old-model",
      publishedAt: new Date("2026-04-25T00:00:00.000Z"),
    },
  });
}

async function createHistoricalDailyReportSource(input: {
  date: string;
  status?: "draft" | "published" | "failed";
  itemId?: string | null;
  clusterId?: string | null;
  sourceKey?: string | null;
  title?: string;
  url?: string;
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
}) {
  const report = await prisma.dailyReport.create({
    data: {
      date: input.date,
      timezone: "Asia/Shanghai",
      status: input.status ?? "published",
      title: `${input.date} AI 日报`,
      openingSummary: "历史摘要",
      closingThought: "历史观察",
      summaryJson: buildDailyReportOutput(),
      renderedMarkdown: "# 历史日报\n",
      inputHash: `historical-${input.date}-${input.title ?? "source"}`,
      publishedAt: input.status === "draft" || input.status === "failed" ? null : new Date(`${input.date}T00:00:00.000Z`),
    },
  });

  return prisma.dailyReportSource.create({
    data: {
      dailyReportId: report.id,
      sourceNumber: 1,
      sourceKey: input.sourceKey ?? null,
      itemId: input.itemId ?? null,
      clusterId: input.clusterId ?? null,
      sourceName: "历史来源",
      title: input.title ?? "历史事件",
      url: input.url ?? `https://history.example.com/${input.date}`,
      sourceSummary: "历史来源摘要",
      sourcePublishedAt: new Date(`${input.date}T01:00:00.000Z`),
      sourceQualityScore: 90,
      eventType: input.eventType ?? null,
      eventSubject: input.eventSubject ?? null,
      eventAction: input.eventAction ?? null,
      eventObject: input.eventObject ?? null,
      eventDate: input.eventDate ?? null,
    },
  });
}

async function createDailyReportSchedule(input: { autoPublish: boolean; planningBatchSize?: number | null; recentTopicLookbackDays?: number }) {
  return prisma.taskSchedule.create({
    data: {
      key: "daily_report_default",
      enabled: false,
      cronExpression: "30 8 * * *",
      sourceConcurrency: 2,
      fullTextFetchThreshold: 80,
      perSourceItemLimit: 20,
      dailyReportCandidateLimit: 120,
      dailyReportOffsetDays: 0,
      dailyReportRecentTopicLookbackDays: input.recentTopicLookbackDays ?? 7,
      dailyReportAutoPublish: input.autoPublish,
      dailyReportPlanningBatchSize: input.planningBatchSize ?? null,
      timezone: "Asia/Shanghai",
      nextRunAt: new Date("2026-04-25T00:30:00.000Z"),
    },
  });
}

describe("daily report service", () => {
  beforeEach(async () => {
    assessDailyReportCandidatesMock.mockReset();
    planDailyReportMock.mockReset();
    writeDailyReportMock.mockReset();
    assessDailyReportCandidatesMock.mockImplementation(async ({ candidates }: { candidates: Array<{ id: number; eventType: string | null; eventSubject: string | null; eventAction: string | null; eventObject: string | null; eventDate: string | null }> }) => candidates.map((candidate) => ({
      candidateId: candidate.id,
      relevanceScore: 90,
      isWorthReading: true,
      suggestedBlockKey: "changes-practice",
      historyDecision: "new",
    })));
    planDailyReportMock.mockImplementation(async ({ candidateBriefs }: { candidateBriefs: Array<{ candidateId: number; clusterId?: string | null }> }) => ({
      schemaVersion: 2,
      sections: (() => {
        const candidateIds = candidateBriefs.map((candidate) => candidate.candidateId);
        const clusterIds = new Set(candidateBriefs.map((candidate) => candidate.clusterId).filter(Boolean));
        if (clusterIds.size === 1 && candidateBriefs.length > 1) {
          return [{ blockKey: "hot-topics", topics: [{ candidateIds }] }];
        }
        if (candidateIds.length >= 2) {
          const hotTopicCount = Math.min(3, candidateIds.length - 1);
          return [
            { blockKey: "hot-topics", topics: candidateIds.slice(0, hotTopicCount).map((candidateId) => ({ candidateIds: [candidateId] })) },
            { blockKey: "changes-practice", topics: candidateIds.slice(hotTopicCount).map((candidateId) => ({ candidateIds: [candidateId] })) },
          ];
        }
        return [{ blockKey: "changes-practice", topics: [{ candidateIds }] }];
      })(),
    }));
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: Array<{ topicId: string; blockKey: string; candidateIds: number[] }> }) => {
      return buildDailyReportOutput(selectedTopics);
    });
    await prisma.dailyReportSource.deleteMany();
    await prisma.dailyReport.deleteMany();
    await prisma.item.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.backgroundTaskRun.deleteMany();
    await prisma.promptConfig.deleteMany();
    await prisma.modelApiConfig.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();
    await prisma.blacklistKeyword.deleteMany();
    await prisma.taskSchedule.deleteMany();
    await prisma.eventBriefingConfig.deleteMany();
    await prisma.briefingPreferenceConfig.deleteMany();

    // These service tests focus on candidate/source/persistence behavior. Use a
    // deliberately permissive v2 template fixture so small synthetic pools do
    // not fail before reaching the behavior under test; cardinality itself is
    // covered by the planning contract tests.
    await ensureRuntimeConfigSeeded();
    const dailyReportPrompt = await prisma.promptConfig.findFirstOrThrow({
      where: { type: "daily_report", isDefault: true },
    });
    const testTemplate = JSON.parse(dailyReportPrompt.templateJson ?? "{}");
    testTemplate.blocks = testTemplate.blocks.map((block: Record<string, unknown>) => block.type === "section"
      ? {
          ...block,
          required: false,
          minItems: 0,
          item: { ...(block.item as Record<string, unknown>), notes: [] },
        }
      : block);
    testTemplate.blocks = testTemplate.blocks
      .filter((block: Record<string, unknown>) => block.title !== "其他值得看")
      .concat({
        type: "text",
        title: "趋势观察",
        bodyInstruction: "测试趋势观察。",
      });
    await prisma.promptConfig.update({
      where: { id: dailyReportPrompt.id },
      data: { templateJson: JSON.stringify(testTemplate) },
    });
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();
    await prisma.taskSchedule.deleteMany();
  });

  it("turns an existing published report into a clean draft when regenerated", async () => {
    await createReportCandidates();
    await createPublishedReport();
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE, force: true });

    const report = await prisma.dailyReport.findFirstOrThrow({
      where: { date: REPORT_DATE, timezone: "Asia/Shanghai" },
    });
    expect(report.status).toBe("draft");
    expect(report.publishedAt).toBeNull();
    expect(report.errorMessage).toBeNull();
    expect(report.title).toBe("04-24日报 | OpenAI 发布新模型、开发者工具更新");
    expect(report.renderedMarkdown).toContain("# 04-24日报 | OpenAI 发布新模型、开发者工具更新");
  });

  it("formats generated report titles for public-account publishing", () => {
    expect(buildDailyReportTitle("2026-06-27", {
      headline: "2026-06-27日报 | GPT-5.6 有限预览、Mythos 5 白名单恢复、",
      blocks: [],
    })).toBe("06-27日报 | GPT-5.6 有限预览、Mythos 5 白名单恢复");

    const fallbackTitle = buildDailyReportTitle("2026-06-27", {
      blocks: [{
        type: "section",
        title: "热点事件",
        items: [
          {
            title: "OpenAI 正式发布 GPT-5.6 系列，采取有限预览",
            body: "正文内容足够长，满足日报条目的基础校验要求。",
            sourceIds: [1],
          },
          {
            title: "Anthropic Mythos 5 向美国白名单机构恢复访问",
            body: "正文内容足够长，满足日报条目的基础校验要求。",
            sourceIds: [2],
          },
        ],
      }],
    });

    expect(fallbackTitle).toBe("06-27日报 | OpenAI 正式发布 GPT-5.6 系列，采取有限预览");
    expect(Array.from(fallbackTitle).length).toBeLessThanOrEqual(64);

    expect(Array.from(buildDailyReportTitle("2026-06-27", {
      headline: "GPT-5.6 有限预览、Mythos 5 白名单恢复、OpenAI 版权诉讼升温、Agent 工程化加速、企业成本路由调整",
      blocks: [],
    })).length).toBeLessThanOrEqual(64);

    expect(buildDailyReportTitle("2026-06-27", {
      headline: "GPT-5.6 有限预览、Mythos 5 白名单恢复、亚马逊加码印度、DeepSeek 开源提速、OpenAI 版权诉讼升温",
      blocks: [],
    })).toBe("06-27日报 | GPT-5.6 有限预览、Mythos 5 白名单恢复、亚马逊加码印度、DeepSeek 开源提速");
  });

  it("persists stable source numbers and source snapshots when generating a report", async () => {
    await createReportCandidates();
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    const result = await generateDailyReport({ date: REPORT_DATE, force: true });
    const sources = await prisma.dailyReportSource.findMany({
      where: { dailyReportId: result.report?.id },
      orderBy: { sourceNumber: "asc" },
    });

    expect(sources.map((source) => source.sourceNumber)).toEqual([1, 2, 3, 4]);
    expect(sources[0]).toMatchObject({
      sourceKey: expect.stringMatching(/^item:/),
      sourceSummary: "OpenAI 发布新模型摘要",
      sourceQualityScore: 90,
    });

    const storedReport = await prisma.dailyReport.findUniqueOrThrow({
      where: {
        date_timezone: {
          date: REPORT_DATE,
          timezone: "Asia/Shanghai",
        },
      },
    });
    const candidateSnapshot = JSON.parse(storedReport.candidateSnapshot ?? "{}") as {
      candidateCount?: number;
      candidates?: Array<{ title: string; candidateScore: number }>;
      excludedRecentDuplicates?: unknown[];
    };
    const detail = await getDailyReportByDate(REPORT_DATE, true);

    expect(candidateSnapshot.candidateCount).toBe(4);
    expect(candidateSnapshot.candidates?.[0]).toMatchObject({
      title: "OpenAI 发布新模型",
      candidateScore: expect.any(Number),
    });
    expect(candidateSnapshot.excludedRecentDuplicates).toEqual([]);
    expect(detail?.candidateReview).toMatchObject({
      candidateCount: 4,
      selectedCount: 4,
      excludedRecentDuplicates: [],
      excludedAssessDuplicates: [],
      excludedCurrentDuplicates: [],
      candidateCoverage: {
        candidateCount: 4,
        selectedCount: 4,
      },
    });
  });

  it("rebuilds source references from the validated topic mapping", async () => {
    await createReportCandidates();
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => {
      const output = JSON.parse(buildDailyReportOutput(selectedTopics)) as {
        blocks: Array<{ type: string; items?: Array<{ sourceIds?: number[] }> }>;
      };
      for (const block of output.blocks) {
        if (block.type !== "section" || !block.items) continue;
        for (const item of block.items) item.sourceIds = [999, 999];
      }
      return JSON.stringify(output);
    });

    const result = await generateDailyReport({ date: REPORT_DATE, force: true });
    const sources = await prisma.dailyReportSource.findMany({
      where: { dailyReportId: result.report?.id },
      orderBy: { sourceNumber: "asc" },
    });

    expect(sources.map((source) => source.sourceNumber)).toEqual([1, 2, 3, 4]);
  });

  it("counts expanded cluster items as report sources", async () => {
    await createClusteredReportCandidates();
    writeDailyReportMock.mockResolvedValue(JSON.stringify({
      blocks: [
        {
          type: "text",
          title: "摘要",
          body: "今天的 AI 生态重点集中在多来源确认的模型发布，多个独立来源围绕同一事件提供了互补信息，适合用于验证日报引用计数。",
        },
        {
          type: "section",
          title: "热点事件",
          items: [{
            topicId: "topic-1",
            title: "多来源模型发布",
            body: "多家来源确认同一个模型发布事件，可以用于观察聚合候选展开后的来源数量是否准确。",
            notes: [{ label: "重点", text: "多源确认" }],
            sourceIds: [1],
          }],
        },
        {
          type: "text",
          title: "趋势观察",
          body: "多来源引用应按展开后的单条内容计数，避免把一个聚合候选误读为一个来源。",
        },
      ],
    }));

    const result = await generateDailyReport({ date: REPORT_DATE, force: true });
    const rows = await prisma.dailyReportSource.count({
      where: { dailyReportId: result.report?.id },
    });
    const detail = await getDailyReportByDate(REPORT_DATE, true);

    expect(rows).toBe(4);
    expect(detail?.sourceCount).toBe(4);
  });

  it("ranks daily report candidates by daily composite score and collapses clustered items", async () => {
    const { cluster } = await createClusteredReportCandidates();

    const candidates = await listDailyReportCandidates(REPORT_DATE, 2);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      clusterId: cluster.id,
      title: "多来源确认的模型发布",
      summary: "多家来源确认同一个模型发布事件，具备更高日报价值。",
      eventType: "launch",
      sourceCount: 3,
      itemCount: 3,
    });
    expect(candidates[0]?.candidateScore).toBeGreaterThan(candidates[1]?.candidateScore ?? 0);
    expect(candidates[1]).toMatchObject({
      clusterId: null,
      title: "单篇高分工具更新",
      sourceCount: 1,
      itemCount: 1,
    });
    expect(candidates.filter((candidate) => candidate.clusterId === cluster.id)).toHaveLength(1);
  });

  it("uses event briefing rankScore and candidate limit when generating reports", async () => {
    const priorityGroup = await prisma.sourceGroup.create({
      data: { name: "Priority Sources" },
    });
    const [prioritySource, regularSource] = await Promise.all([
      prisma.source.create({
        data: {
          name: "Priority Source",
          rssUrl: "https://priority.example.com/feed.xml",
          siteUrl: "https://priority.example.com",
          groupId: priorityGroup.id,
        },
      }),
      prisma.source.create({
        data: {
          name: "Regular Source",
          rssUrl: "https://regular.example.com/feed.xml",
          siteUrl: "https://regular.example.com",
        },
      }),
    ]);
    await prisma.item.createMany({
      data: [
        {
          sourceId: regularSource.id,
          originalUrl: "https://regular.example.com/high-quality",
          canonicalUrl: "https://regular.example.com/high-quality",
          urlHash: "daily-event-rank-regular",
          originalTitle: "高质量但未偏好内容",
          publishedAt: new Date("2026-04-24T01:00:00.000Z"),
          createdAt: new Date("2026-04-24T01:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          summaryText: "这条内容质量很高，但没有命中事件偏好。",
          qualityScore: 99,
          eventType: "other",
        },
        {
          sourceId: prioritySource.id,
          originalUrl: "https://priority.example.com/security",
          canonicalUrl: "https://priority.example.com/security",
          urlHash: "daily-event-rank-priority",
          originalTitle: "安全事件需要优先进入日报",
          publishedAt: new Date("2026-04-24T02:00:00.000Z"),
          createdAt: new Date("2026-04-24T02:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          summaryText: "这条内容质量较低，但命中事件类型偏好，应通过事件速览排序进入日报。",
          qualityScore: 70,
          eventType: "security",
        },
      ],
    });
    await updateEventBriefingConfig({
      minRankScore: 0,
      channels: [
        {
          id: "important",
          name: "重点事件",
          sourceGroupIds: [],
          enabled: true,
          sortOrder: 0,
        },
      ],
    });
    await prisma.taskSchedule.create({
      data: {
        key: "daily_report_default",
        enabled: false,
        cronExpression: "30 8 * * *",
        sourceConcurrency: 2,
        fullTextFetchThreshold: 80,
        perSourceItemLimit: 20,
        dailyReportCandidateLimit: 2,
        dailyReportOffsetDays: 0,
        dailyReportAutoPublish: false,
        timezone: "Asia/Shanghai",
        nextRunAt: new Date("2026-04-25T00:30:00.000Z"),
      },
    });
    await updateEventBriefingConfig({ minRankScore: 0 });
    await updateBriefingPreferenceConfig({
      weightedRules: [
        { type: "event_type", value: "security", weight: 30 },
      ],
      maxCuratorBoost: 30,
      maxCuratorPenalty: 20,
    });
    writeDailyReportMock.mockResolvedValue(JSON.stringify({
      headline: "安全事件优先",
      blocks: [
        {
          type: "text",
          title: "摘要",
          body: "今天日报候选应来自事件速览排序结果，而不是旧的质量分候选池。",
        },
        {
          type: "section",
          title: "热点事件",
          items: [
            {
              topicId: "topic-1",
              title: "安全事件需要优先进入日报",
              body: "该事件命中事件速览偏好规则，即使质量分不是最高，也应作为日报候选。",
              sourceIds: [1],
            },
          ],
        },
        {
          type: "section",
          title: "变更与实践",
          items: [{
            topicId: "topic-2",
            title: "高质量内容作为补充入选",
            body: "该候选作为独立主题补充进入日报，保留事件速览排序后的候选覆盖。",
            sourceIds: [2],
          }],
        },
        {
          type: "text",
          title: "趋势观察",
          body: "候选池切换后，日报会跟随事件速览的主理人偏好和排序逻辑，减少两套重点判断互相打架的问题。",
        },
      ],
    }));

    const result = await generateDailyReport({ date: REPORT_DATE, force: true });
    const articles = getLastGeneratedDailyReportArticles();
    const snapshot = JSON.parse(result.report?.candidateSnapshot ?? "{}") as {
      candidateSource?: string;
      candidates?: Array<{ title: string; candidateScore: number }>;
    };

    expect(articles).toHaveLength(2);
    expect(articles[0]).toMatchObject({
      title: "安全事件需要优先进入日报",
      candidateScore: expect.any(Number),
    });
    expect(snapshot.candidateSource).toBe("event_briefing");
    expect(snapshot.candidates?.map((candidate) => candidate.title)).toEqual([
      "安全事件需要优先进入日报",
      "高质量但未偏好内容",
    ]);
  });

  it("fills the daily report limit after removing recent duplicates", async () => {
    await createReportCandidates();
    const topItem = await prisma.item.findFirstOrThrow({
      where: { originalUrl: "https://example.com/a" },
    });
    await createHistoricalDailyReportSource({
      date: "2026-04-20",
      itemId: topItem.id,
      sourceKey: `item:${topItem.id}`,
      title: "OpenAI 发布新模型",
    });
    const schedule = await createDailyReportSchedule({ autoPublish: false });
    await prisma.taskSchedule.update({
      where: { id: schedule.id },
      data: { dailyReportCandidateLimit: 2 },
    });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE, force: true });

    expect(getLastGeneratedDailyReportArticles().map((article) => article.title)).toEqual([
      "开发者工具更新",
      "开发者社区发布插件规范",
    ]);
  });

  it("rejects a topic repeated in the WRITE draft", async () => {
    await createReportCandidates();
    await createDailyReportSchedule({ autoPublish: false });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => {
      const output = JSON.parse(buildDailyReportOutput(selectedTopics)) as {
        blocks: Array<{ type: string; items?: Array<Record<string, unknown>> }>;
      };
      const section = output.blocks.find((block) => block.type === "section");
      if (section?.items?.[0]) section.items.push({ ...section.items[0], title: "重复主题条目" });
      return JSON.stringify(output);
    });

    await expect(generateDailyReport({ date: REPORT_DATE, force: true })).rejects.toThrow("主题 topic-1 在草稿中生成了多个条目");
  });

  it("keeps a same-cluster follow-up when the current day adds new cluster items", async () => {
    const { cluster } = await createClusteredReportCandidates();
    const existingItem = await prisma.item.findFirstOrThrow({
      where: { clusterId: cluster.id },
    });
    await prisma.item.create({
      data: {
        sourceId: existingItem.sourceId,
        clusterId: cluster.id,
        originalUrl: "https://source-a.example.com/model-launch-history",
        canonicalUrl: "https://source-a.example.com/model-launch-history",
        urlHash: "clustered-item-history",
        originalTitle: "模型发布历史报道",
        publishedAt: new Date("2026-04-20T03:00:00.000Z"),
        createdAt: new Date("2026-04-20T03:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "历史聚合来源摘要",
        qualityScore: 82,
      },
    });
    await createHistoricalDailyReportSource({
      date: "2026-04-20",
      clusterId: cluster.id,
      sourceKey: `cluster:${cluster.id}`,
      title: "多来源确认的模型发布",
    });
    await createDailyReportSchedule({ autoPublish: false });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE, force: true });

    const clusterArticle = getLastGeneratedDailyReportArticles().find((article) => article.clusterId === cluster.id);
    expect(clusterArticle).toMatchObject({
      isFollowUp: true,
      newItemCountOnDate: 3,
      newSourceCountOnDate: 3,
    });
  });

  it("passes current multi-source evidence into daily report candidates", async () => {
    const { cluster } = await createClusteredReportCandidates();
    await createDailyReportSchedule({ autoPublish: false });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE, force: true });

    const clusterArticle = getLastGeneratedDailyReportArticles().find((article) => article.clusterId === cluster.id);
    expect(clusterArticle?.evidenceItems).toHaveLength(3);
    expect(clusterArticle?.evidenceItems?.map((item) => item.title)).toEqual([
      "模型发布 来源 C",
      "模型发布 来源 B",
      "模型发布 来源 A",
    ]);
  });

  it("expands selected clustered candidates into all clustered source links", async () => {
    const { cluster } = await createClusteredReportCandidates();
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    const result = await generateDailyReport({ date: REPORT_DATE, force: true });
    const clusteredSources = await prisma.dailyReportSource.findMany({
      where: {
        dailyReportId: result.report?.id,
        sourceNumber: 1,
      },
      orderBy: { title: "asc" },
    });

    expect(clusteredSources).toHaveLength(3);
    expect(new Set(clusteredSources.map((source) => source.clusterId))).toEqual(new Set([cluster.id]));
    expect(clusteredSources.map((source) => source.title)).toEqual([
      "模型发布 来源 A",
      "模型发布 来源 B",
      "模型发布 来源 C",
    ]);
    expect(result.report?.renderedMarkdown).toContain("[模型发布 来源 A](https://source-a.example.com/model-launch)");
    expect(result.report?.renderedMarkdown).toContain("[模型发布 来源 B](https://source-b.example.com/model-launch)");
    expect(result.report?.renderedMarkdown).toContain("[模型发布 来源 C](https://source-c.example.com/model-launch)");
  });

  it("limits expanded clustered source links per selected candidate", async () => {
    const { cluster } = await createLargeClusteredReportCandidates();
    writeDailyReportMock.mockResolvedValue(JSON.stringify({
      blocks: [
        { type: "text", title: "摘要", body: "今天多来源模型发布事件集中出现，日报只展示代表性来源，避免相似引用过多影响阅读。" },
        {
          type: "section",
          title: "热点事件",
          items: [{
            topicId: "topic-1",
            title: "大型聚合模型发布",
            body: "多家来源报道同一模型发布事件，保存和渲染时应限制代表性来源数量。",
            notes: [{ label: "重点", text: "限制引用展开" }],
            sourceIds: [1],
          }],
        },
        {
          type: "text",
          title: "趋势观察",
          body: "聚合来源需要代表性展示，而不是把所有相似来源全部铺开；这样既能保留多源确认的可信度，也能避免读者在同一主题下反复看到高度相似的标题。",
        },
      ],
    }));

    const result = await generateDailyReport({ date: REPORT_DATE, force: true });
    const clusteredSources = await prisma.dailyReportSource.findMany({
      where: {
        dailyReportId: result.report?.id,
        sourceNumber: 1,
      },
      orderBy: { title: "asc" },
    });

    expect(new Set(clusteredSources.map((source) => source.clusterId))).toEqual(new Set([cluster.id]));
    expect(clusteredSources).toHaveLength(5);
    expect(result.report?.renderedMarkdown).toContain("[大型模型发布 来源 1](https://large-1.example.com/model-launch)");
    expect(result.report?.renderedMarkdown).toContain("[大型模型发布 来源 5](https://large-5.example.com/model-launch)");
    expect(result.report?.renderedMarkdown).not.toContain("[大型模型发布 来源 6](https://large-6.example.com/model-launch)");
  });

  it("uses created date for daily report candidate boundaries", async () => {
    await createCreatedAtBoundaryCandidates();

    const candidates = await listDailyReportCandidates(REPORT_DATE, 10);
    const titles = candidates.map((candidate) => candidate.title);

    expect(titles).toContain("入库日期命中日报日期");
    expect(titles).toContain("入库日期再次命中日报日期");
    expect(titles).not.toContain("仅事件日期命中日报日期");
    expect(titles).not.toContain("仅发布时间命中日报日期");
  });

  it("limits scheduled daily report candidates and expanded cluster sources to selected channels", async () => {
    const [groupA, groupB] = await Promise.all([
      prisma.sourceGroup.create({ data: { name: "Scoped A" } }),
      prisma.sourceGroup.create({ data: { name: "Scoped B" } }),
    ]);
    const [sourceA, sourceB] = await Promise.all([
      prisma.source.create({
        data: {
          name: "Scoped Source A",
          rssUrl: "https://scoped-a.example.com/feed.xml",
          siteUrl: "https://scoped-a.example.com",
          groupId: groupA.id,
        },
      }),
      prisma.source.create({
        data: {
          name: "Scoped Source B",
          rssUrl: "https://scoped-b.example.com/feed.xml",
          siteUrl: "https://scoped-b.example.com",
          groupId: groupB.id,
        },
      }),
    ]);
    const cluster = await prisma.contentCluster.create({
      data: {
        title: "分组内聚合候选",
        summary: "分组内聚合候选摘要",
        score: 90,
        itemCount: 2,
        latestPublishedAt: new Date("2026-04-24T03:00:00.000Z"),
        fingerprint: "daily-report-scoped-cluster",
      },
    });
    await prisma.item.createMany({
      data: [
        {
          sourceId: sourceA.id,
          clusterId: cluster.id,
          originalUrl: "https://scoped-a.example.com/cluster",
          canonicalUrl: "https://scoped-a.example.com/cluster",
          urlHash: "scoped-a-cluster",
          originalTitle: "分组 A 聚合条目",
          publishedAt: new Date("2026-04-24T01:00:00.000Z"),
          createdAt: new Date("2026-04-24T01:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          summaryText: "分组 A 聚合条目摘要",
          qualityScore: 95,
        },
        {
          sourceId: sourceB.id,
          clusterId: cluster.id,
          originalUrl: "https://scoped-b.example.com/cluster",
          canonicalUrl: "https://scoped-b.example.com/cluster",
          urlHash: "scoped-b-cluster",
          originalTitle: "分组 B 聚合条目",
          publishedAt: new Date("2026-04-24T02:00:00.000Z"),
          createdAt: new Date("2026-04-24T02:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          summaryText: "分组 B 聚合条目摘要",
          qualityScore: 94,
        },
        {
          sourceId: sourceA.id,
          originalUrl: "https://scoped-a.example.com/standalone",
          canonicalUrl: "https://scoped-a.example.com/standalone",
          urlHash: "scoped-a-standalone",
          originalTitle: "分组 A 独立条目",
          publishedAt: new Date("2026-04-24T03:00:00.000Z"),
          createdAt: new Date("2026-04-24T03:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          summaryText: "分组 A 独立条目摘要",
          qualityScore: 70,
        },
      ],
    });
    await updateEventBriefingConfig({
      minRankScore: 0,
      channels: [
        {
          id: "important",
          name: "重点事件",
          sourceGroupIds: [groupA.id],
          enabled: true,
          sortOrder: 0,
        },
      ],
    });
    await prisma.taskSchedule.create({
      data: {
        key: "daily_report_default",
        enabled: false,
        cronExpression: "30 8 * * *",
        sourceConcurrency: 2,
        fullTextFetchThreshold: 80,
        perSourceItemLimit: 20,
        dailyReportCandidateLimit: 10,
        dailyReportOffsetDays: 0,
        dailyReportAutoPublish: false,
        dailyReportChannelIdsJson: JSON.stringify(["important"]),
        timezone: "Asia/Shanghai",
        nextRunAt: new Date("2026-04-25T00:30:00.000Z"),
      },
    });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    const result = await generateDailyReport({ date: REPORT_DATE, force: true });
    const articleTitles = getLastGeneratedDailyReportArticles().map((article) => article.title);
    const savedSources = await prisma.dailyReportSource.findMany({
      where: { dailyReportId: result.report?.id },
      orderBy: { title: "asc" },
    });

    expect(articleTitles).toEqual(["分组 A 聚合条目", "分组 A 独立条目"]);
    expect(savedSources.map((source) => source.title)).toEqual(["分组 A 独立条目", "分组 A 聚合条目"]);
    expect(savedSources.map((source) => source.url)).not.toContain("https://scoped-b.example.com/cluster");
  });

  it("filters candidates that match a source from the previous 7 days by cluster", async () => {
    const { cluster } = await createClusteredReportCandidates();
    await createReportCandidates();
    await createHistoricalDailyReportSource({
      date: "2026-04-20",
      clusterId: cluster.id,
      sourceKey: `cluster:${cluster.id}`,
      title: "多来源确认的模型发布",
    });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE, force: true });

    const articles = getLastGeneratedDailyReportArticles();
    expect(articles).toHaveLength(5);
    expect(articles.map((article) => article.id)).toEqual([1, 2, 3, 4, 5]);
    expect(articles.some((article) => article.clusterId === cluster.id)).toBe(false);
    expect(articles.map((article) => article.title)).not.toContain("多来源确认的模型发布");
  });

  it("filters different-source candidates with the same strict event signature from recent reports", async () => {
    await createEventSignatureCandidates();
    await createHistoricalDailyReportSource({
      date: "2026-04-20",
      title: "另一来源报道 Anthropic 发布 Claude 4",
      eventType: "release",
      eventSubject: "Anthropic",
      eventAction: "发布",
      eventObject: "Claude 4",
      eventDate: "2026-04-20",
    });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE, force: true });

    const articles = getLastGeneratedDailyReportArticles();
    expect(articles.map((article) => article.title)).not.toContain("Anthropic 发布 Claude 4");
    expect(articles.map((article) => article.title)).toEqual(expect.arrayContaining([
      "Anthropic 发布 Claude 4 新进展",
      "Anthropic 更新 Claude 4",
      "独立工具发布",
    ]));
  });

  it("passes recent report topics to the model without failed or out-of-window reports", async () => {
    await createReportCandidates();
    await createHistoricalDailyReportSource({
      date: "2026-04-20",
      title: "历史日报已写主题",
      eventType: "release",
      eventSubject: "OpenAI",
      eventAction: "发布",
      eventObject: "GPT-5",
      eventDate: "2026-04-20",
    });
    await createHistoricalDailyReportSource({
      date: "2026-04-19",
      status: "failed",
      title: "失败日报主题",
      eventSubject: "Failed",
      eventObject: "Topic",
    });
    await createHistoricalDailyReportSource({
      date: "2026-04-21",
      status: "draft",
      title: "草稿日报主题",
      eventSubject: "Draft",
      eventObject: "Topic",
    });
    await createHistoricalDailyReportSource({
      date: "2026-04-16",
      title: "七天外主题",
      eventSubject: "Old",
      eventObject: "Topic",
    });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE, force: true });

    const recentTopics = getLastGeneratedDailyReportInput()?.recentTopics ?? [];
    expect(recentTopics).toEqual([
      expect.objectContaining({
        date: "2026-04-20",
        title: "历史日报已写主题",
        eventSubject: "OpenAI",
        eventObject: "GPT-5",
      }),
    ]);
    expect(recentTopics.map((topic) => topic.title)).not.toContain("失败日报主题");
    expect(recentTopics.map((topic) => topic.title)).not.toContain("草稿日报主题");
    expect(recentTopics.map((topic) => topic.title)).not.toContain("七天外主题");
  });

  it("uses the configured lookback window when collecting recent report topics", async () => {
    await createReportCandidates();
    await createDailyReportSchedule({ autoPublish: false, recentTopicLookbackDays: 10 });
    await createHistoricalDailyReportSource({
      date: "2026-04-16",
      title: "十天窗口内主题",
      eventType: "release",
      eventSubject: "OpenAI",
      eventAction: "发布",
      eventObject: "GPT-5",
      eventDate: "2026-04-16",
    });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE, force: true });

    expect(getLastGeneratedDailyReportInput()?.recentTopics).toEqual([
      expect.objectContaining({ date: "2026-04-16", title: "十天窗口内主题" }),
    ]);
  });

  it("filters soft duplicate candidates with similar recent event core", async () => {
    await createSoftDuplicateReportCandidates();
    await createHistoricalDailyReportSource({
      date: "2026-04-20",
      title: "OpenAI 与 Broadcom 发布 Jalapeño 推理芯片",
      eventType: "release",
      eventSubject: "OpenAI",
      eventAction: "发布",
      eventObject: "Jalapeño推理芯片",
      eventDate: "2026-04-20",
    });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE, force: true });

    const articles = getLastGeneratedDailyReportArticles();
    expect(articles.map((article) => article.title)).not.toContain("OpenAI联合Broadcom发布自研推理芯片Jalapeño");
    expect(articles.map((article) => article.title)).toEqual([
      "新 Agent 运行时发布",
      "新评测基准发布",
    ]);
  });

  it("keeps same-subject follow-ups when event date or action changed", async () => {
    await createEventSignatureCandidates();
    await createHistoricalDailyReportSource({
      date: "2026-04-20",
      title: "另一来源报道 Anthropic 发布 Claude 4",
      eventType: "release",
      eventSubject: "Anthropic",
      eventAction: "发布",
      eventObject: "Claude 4",
      eventDate: "2026-04-20",
    });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE, force: true });

    const articles = getLastGeneratedDailyReportArticles();
    expect(articles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Anthropic 发布 Claude 4 新进展",
        eventDate: REPORT_DATE,
      }),
      expect.objectContaining({
        title: "Anthropic 更新 Claude 4",
        eventAction: "更新",
      }),
    ]));
  });

  it("does not filter candidates against reports older than 7 days", async () => {
    await createEventSignatureCandidates();
    await createHistoricalDailyReportSource({
      date: "2026-04-16",
      title: "另一来源报道 Anthropic 发布 Claude 4",
      eventType: "release",
      eventSubject: "Anthropic",
      eventAction: "发布",
      eventObject: "Claude 4",
      eventDate: "2026-04-20",
    });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE, force: true });

    expect(getLastGeneratedDailyReportArticles().map((article) => article.title)).toContain("Anthropic 发布 Claude 4");
  });

  it("does not filter candidates against failed historical reports", async () => {
    await createEventSignatureCandidates();
    await createHistoricalDailyReportSource({
      date: "2026-04-20",
      status: "failed",
      title: "另一来源报道 Anthropic 发布 Claude 4",
      eventType: "release",
      eventSubject: "Anthropic",
      eventAction: "发布",
      eventObject: "Claude 4",
      eventDate: "2026-04-20",
    });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE, force: true });

    expect(getLastGeneratedDailyReportArticles().map((article) => article.title)).toContain("Anthropic 发布 Claude 4");
  });

  it("publishes the report immediately when daily report auto publish is enabled", async () => {
    await createDailyReportSchedule({ autoPublish: true });
    await createReportCandidates();
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE, force: true });

    const report = await prisma.dailyReport.findFirstOrThrow({
      where: { date: REPORT_DATE, timezone: "Asia/Shanghai" },
    });
    expect(report.status).toBe("published");
    expect(report.publishedAt).toBeInstanceOf(Date);
  });

  it("passes the full recent topic set to ASSESS and records model history filtering", async () => {
    await createReportCandidates();
    await createDailyReportSchedule({ autoPublish: true });
    await createHistoricalDailyReportSource({
      date: "2026-04-20",
      title: "历史日报已写主题",
      eventType: "research",
      eventSubject: "历史主体",
      eventAction: "研究",
      eventObject: "历史对象",
      eventDate: "2026-04-20",
    });
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "queued",
        label: "AI 日报生成",
        entityId: REPORT_DATE,
      },
    });
    assessDailyReportCandidatesMock.mockImplementationOnce(async ({
      candidates,
      recentTopics,
    }: {
      candidates: Array<{ id: number }>;
      recentTopics: Array<{ title: string }>;
    }) => {
      expect(recentTopics).toEqual([expect.objectContaining({ title: "历史日报已写主题" })]);
      return candidates.map((candidate) => ({
        candidateId: candidate.id,
        relevanceScore: 90,
        isWorthReading: true,
        suggestedBlockKey: "changes-practice",
        historyDecision: candidate.id === 1 ? "duplicate" : "new",
        matchedRecentTopicTitle: candidate.id === 1 ? "历史日报已写主题" : null,
      }));
    });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await executeDailyReportTask(taskRun);

    expect(getLastGeneratedDailyReportArticles().map((article) => article.id)).toEqual([2, 3, 4]);
    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    const timeline = JSON.parse(storedTaskRun.taskTimelineJson ?? "[]") as Array<{
      key: string;
      metrics: Array<{ label: string; value: number }>;
    }>;
    expect(timeline.find((node) => node.key === "daily_report_assess")).toMatchObject({
      metrics: expect.arrayContaining([{ label: "历史重复过滤", value: 1 }]),
    });
    const storedReport = await prisma.dailyReport.findUniqueOrThrow({
      where: { date_timezone: { date: REPORT_DATE, timezone: "Asia/Shanghai" } },
    });
    const snapshot = JSON.parse(storedReport.candidateSnapshot ?? "{}") as {
      excludedAssessDuplicates?: Array<Record<string, unknown>>;
      excludedRecentDuplicates?: unknown[];
      excludedCurrentDuplicates?: unknown[];
    };
    expect(snapshot).toMatchObject({
      excludedAssessDuplicates: [
        expect.objectContaining({
          title: "OpenAI 发布新模型",
          relevanceScore: 90,
          suggestedBlockKey: "changes-practice",
          historyDecision: "duplicate",
          matchedRecentTopicTitle: "历史日报已写主题",
          excludedReason: "ASSESS 判定为历史重复",
        }),
      ],
      excludedRecentDuplicates: [],
      excludedCurrentDuplicates: [],
    });
    const detail = await getDailyReportByDate(REPORT_DATE, true);
    expect(detail?.candidateReview).toMatchObject({
      excludedAssessDuplicates: [
        expect.objectContaining({
          title: "OpenAI 发布新模型",
          relevanceScore: 90,
          historyDecision: "duplicate",
          matchedRecentTopicTitle: "历史日报已写主题",
        }),
      ],
      excludedRecentDuplicates: [],
      excludedCurrentDuplicates: [],
    });
  });

  it("records candidate and selected counts in the daily report task timeline", async () => {
    await createReportCandidates();
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "queued",
        label: "AI 日报生成",
        entityId: REPORT_DATE,
      },
    });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await executeDailyReportTask(taskRun);

    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    const timeline = JSON.parse(storedTaskRun.taskTimelineJson ?? "[]") as Array<{
      key: string;
      label: string;
      metrics: Array<{ label: string; value: number }>;
      audit?: { planning?: { topicPriorityVersion?: string } };
    }>;

    expect(timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "daily_report_generate",
        metrics: [
          { label: "总候选数", value: 4 },
          { label: "批次数", value: 1 },
          { label: "批次大小", value: 4 },
          { label: "最后入选数", value: 4 },
        ],
      }),
      expect.objectContaining({
        key: "daily_report_prepare",
        label: "准备候选",
        metrics: [{ label: "总候选数", value: 4 }],
      }),
      expect.objectContaining({
        key: "daily_report_assess",
        label: "分批选题评估",
        metrics: [
          { label: "批次数", value: 1 },
          { label: "批次大小", value: 4 },
          { label: "历史重复过滤", value: 0 },
          { label: "修复轮数", value: 0 },
          { label: "完整重试", value: 0 },
        ],
      }),
      expect.objectContaining({
        key: "daily_report_merge",
        label: "准备规划输入",
        metrics: [{ label: "可规划候选", value: 4 }],
      }),
      expect.objectContaining({
        key: "daily_report_plan",
        metrics: [
          { label: "计划栏目", value: 2 },
          { label: "计划入选", value: 4 },
          { label: "截取主题", value: 0 },
          { label: "违规数", value: 0 },
          { label: "修复轮数", value: 0 },
          { label: "完整重试", value: 0 },
        ],
        audit: expect.objectContaining({
          planning: expect.objectContaining({ topicPriorityVersion: "v1" }),
        }),
      }),
      expect.objectContaining({
        key: "daily_report_write",
        metrics: [
          { label: "入选数", value: 4 },
          { label: "违规数", value: 0 },
          { label: "修复轮数", value: 0 },
          { label: "完整重试", value: 0 },
          { label: "上下文超限", value: 0 },
        ],
      }),
      expect.objectContaining({
        key: "daily_report_persist_publish",
      }),
      expect.objectContaining({
        key: "task_finished",
        label: "已完成",
        metrics: [{ label: "最后入选数", value: 4 }],
      }),
    ]));
  });

  it("invalidates an existing report when the configured planning batch size changes", async () => {
    await createDailyReportSchedule({ autoPublish: false, planningBatchSize: 2 });
    await createReportCandidates();
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));

    await generateDailyReport({ date: REPORT_DATE });
    expect(writeDailyReportMock).toHaveBeenCalledTimes(1);

    await prisma.taskSchedule.update({
      where: { key: "daily_report_default" },
      data: { dailyReportPlanningBatchSize: 3 },
    });
    writeDailyReportMock.mockClear();

    const result = await generateDailyReport({ date: REPORT_DATE });

    expect(result.skipped).toBe(false);
    expect(writeDailyReportMock).toHaveBeenCalledTimes(1);
  });

  it("repairs an invalid PLAN in the same stage context", async () => {
    await createDailyReportSchedule({ autoPublish: false });
    await createReportCandidates();
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => buildDailyReportOutput(selectedTopics));
    let retryInput: { stageContext?: { messages?: unknown[] }; validationFeedback?: { violations?: unknown[] } } | undefined;
    planDailyReportMock.mockImplementationOnce(async () => ({
      schemaVersion: 2,
      sections: [{ blockKey: "text", topics: [{ candidateIds: [] }] }],
    })).mockImplementationOnce(async (input: { stageContext?: { messages?: unknown[] }; validationFeedback?: { violations?: unknown[] } }) => {
      retryInput = input;
      return {
        schemaVersion: 2,
        sections: [
          { blockKey: "hot-topics", topics: [{ candidateIds: [1, 2, 3] }] },
          { blockKey: "changes-practice", topics: [{ candidateIds: [4] }] },
        ],
      };
    });
    const checkpoints: Array<{ stage: string; stageAttempts?: Record<string, number> }> = [];

    await generateDailyReport({
      date: REPORT_DATE,
      force: true,
      onCheckpoint: async (checkpoint) => {
        checkpoints.push({ stage: checkpoint.stage, stageAttempts: checkpoint.stageAttempts });
      },
    });

    expect(planDailyReportMock).toHaveBeenCalledTimes(2);
    expect(retryInput?.stageContext).toBeDefined();
    expect(retryInput?.validationFeedback?.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unknown_block" }),
    ]));
    expect(checkpoints.find((checkpoint) => checkpoint.stage === "plan")?.stageAttempts).toMatchObject({
      PLAN: 1,
    });
  });

  it("truncates a Block over maxItems by priority without retrying PLAN", async () => {
    await createDailyReportSchedule({ autoPublish: false });
    await createReportCandidates();
    await createEventSignatureCandidates();
    planDailyReportMock.mockImplementation(async ({ candidateBriefs }: { candidateBriefs: Array<{ candidateId: number }> }) => {
      const candidateIds = candidateBriefs.map((candidate) => candidate.candidateId);
      return {
        schemaVersion: 2,
        sections: [
          { blockKey: "hot-topics", topics: candidateIds.slice(0, 6).map((candidateId) => ({ candidateIds: [candidateId] })) },
          { blockKey: "changes-practice", topics: candidateIds.slice(6).map((candidateId) => ({ candidateIds: [candidateId] })) },
        ],
      };
    });

    const checkpoints: Array<{ stage: string; planningAudit?: unknown }> = [];
    await generateDailyReport({
      date: REPORT_DATE,
      force: true,
      onCheckpoint: async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });

    expect(planDailyReportMock).toHaveBeenCalledTimes(1);
    const selectedTopics = writeDailyReportMock.mock.calls.at(-1)?.[0]?.selectedTopics as SelectedTopicFixture[];
    expect(selectedTopics.filter((topic) => topic.blockKey === "hot-topics")).toHaveLength(5);
    expect(selectedTopics.filter((topic) => topic.blockKey === "changes-practice")).toHaveLength(2);
    expect(checkpoints.filter((checkpoint) => checkpoint.stage === "plan").at(-1)?.planningAudit).toMatchObject({
      topicPriorityVersion: "v1",
      truncatedTopicCount: 1,
      sections: expect.arrayContaining([
        expect.objectContaining({ blockKey: "hot-topics", truncatedTopicCount: 1 }),
      ]),
    });
  });

  it("keeps the invalid plan and violations in the failed checkpoint", async () => {
    await createDailyReportSchedule({ autoPublish: false });
    await createReportCandidates();
    const invalidPlan = {
      schemaVersion: 2,
      sections: [{ blockKey: "text", topics: [{ candidateIds: [] }] }],
    };
    planDailyReportMock.mockResolvedValue(invalidPlan);
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "queued",
        label: "AI 日报生成",
        entityId: REPORT_DATE,
      },
    });

    await executeDailyReportTask(taskRun);

    const failedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    const checkpoint = JSON.parse(failedTaskRun.pipelineCheckpointJson ?? "{}");
    expect(checkpoint).toMatchObject({
      failedStage: "plan",
      plan: invalidPlan,
      violations: expect.arrayContaining([
        expect.objectContaining({ code: "unknown_block" }),
      ]),
    });
    expect(JSON.parse(failedTaskRun.taskTimelineJson ?? "[]")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "daily_report_plan",
        status: "failed",
        metrics: expect.arrayContaining([
          { label: "计划栏目", value: 1 },
          { label: "计划入选", value: 0 },
          { label: "违规数", value: expect.any(Number) },
        ]),
      }),
    ]));
  });

  it("stops a cancelled task before persisting or publishing the report", async () => {
    await createDailyReportSchedule({ autoPublish: true });
    await createReportCandidates();
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "queued",
        label: "AI 日报生成",
        entityId: REPORT_DATE,
      },
    });
    assessDailyReportCandidatesMock.mockImplementationOnce(async ({ candidates }: { candidates: Array<{ id: number; eventType: string | null; eventSubject: string | null; eventAction: string | null; eventObject: string | null; eventDate: string | null }> }) => {
      await prisma.backgroundTaskRun.update({
        where: { id: taskRun.id },
        data: { cancelRequestedAt: new Date() },
      });
      return candidates.map((candidate) => ({
        candidateId: candidate.id,
        relevanceScore: 90,
        isWorthReading: true,
        suggestedBlockKey: "changes-practice",
        historyDecision: "new",
      }));
    });

    await executeDailyReportTask(taskRun);

    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    expect(storedTaskRun.status).toBe("cancelled");
    expect(storedTaskRun.errorSummary).toBe("管理员手动终止任务。");
    expect(JSON.parse(storedTaskRun.pipelineCheckpointJson ?? "{}")).toMatchObject({
      failedStage: "assess",
      failureCode: "cancelled",
      resumeEligible: true,
    });
    expect(JSON.parse(storedTaskRun.taskTimelineJson ?? "[]")).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "task_finished", label: "已取消", status: "cancelled" }),
    ]));
    await expect(prisma.dailyReport.findUnique({
      where: { date_timezone: { date: REPORT_DATE, timezone: "Asia/Shanghai" } },
    })).resolves.toBeNull();
  });

  it("does not retry or resume an assessment batch after context overflow", async () => {
    await createDailyReportSchedule({ autoPublish: false, planningBatchSize: 2 });
    await createReportCandidates();
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "queued",
        label: "AI 日报生成",
        entityId: REPORT_DATE,
      },
    });
    assessDailyReportCandidatesMock.mockRejectedValue(new Error("context length exceeded"));

    await executeDailyReportTask(taskRun);

    expect(assessDailyReportCandidatesMock).toHaveBeenCalledTimes(2);
    const failedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    expect(JSON.parse(failedTaskRun.pipelineCheckpointJson ?? "{}")).toMatchObject({
      failedStage: "assess",
      failureCode: "context_overflow",
      resumeEligible: false,
      data: { batchCount: 2, batchSize: 2 },
      assessmentBatches: expect.arrayContaining([
        expect.objectContaining({ status: "failed", attempt: 2 }),
      ]),
      stageLoop: expect.objectContaining({
        stage: "assess",
        cleanRetryAttempt: 1,
        contextOverflow: true,
      }),
    });
    const timeline = JSON.parse(failedTaskRun.taskTimelineJson ?? "[]") as Array<{ key: string; status: string; startedAt: string | null; finishedAt: string | null }>;
    expect(timeline.find((node) => node.key === "daily_report_prepare")).toMatchObject({ status: "succeeded" });
    expect(timeline.find((node) => node.key === "daily_report_assess")).toMatchObject({ status: "failed" });
    expect(timeline.find((node) => node.key === "daily_report_merge")).toMatchObject({ status: "pending", startedAt: null, finishedAt: null });
    expect(timeline.find((node) => node.key === "daily_report_persist_publish")).toMatchObject({ status: "pending", startedAt: null, finishedAt: null });
  });

  it("keeps full ASSESS checkpoint coverage while sending only eligible candidates to PLAN", async () => {
    await createDailyReportSchedule({ autoPublish: false });
    await createReportCandidates();
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "queued",
        label: "AI 日报生成",
        entityId: REPORT_DATE,
      },
    });
    const excludedCandidateId = 1;
    assessDailyReportCandidatesMock.mockImplementationOnce(async ({ candidates }: { candidates: Array<{ id: number }> }) => candidates.map((candidate) => ({
      candidateId: candidate.id,
      relevanceScore: candidate.id === excludedCandidateId ? 10 : 90,
      isWorthReading: candidate.id !== excludedCandidateId,
      suggestedBlockKey: "changes-practice",
      historyDecision: "new",
    })));
    let planInput: { candidateBriefs: Array<{ candidateId: number }>; recentTopics?: unknown[] } | undefined;
    planDailyReportMock.mockImplementation(async (input: typeof planInput) => {
      planInput = input as typeof planInput;
      throw new Error("stop after PLAN input inspection");
    });

    await executeDailyReportTask(taskRun);

    expect(planInput?.candidateBriefs.map((candidate) => candidate.candidateId)).not.toContain(excludedCandidateId);
    expect(planInput?.recentTopics).toBeDefined();

    const failedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    const checkpoint = JSON.parse(failedTaskRun.pipelineCheckpointJson ?? "{}") as {
      assessmentBatches?: Array<{ assessments?: Array<{ candidateId: number }> }>;
    };
    expect(checkpoint.assessmentBatches?.[0]?.assessments?.map((item) => item.candidateId)).toEqual([1, 2, 3, 4]);
  });

  it("preserves an existing report status and content when regeneration fails", async () => {
    await createReportCandidates();
    const existing = await createPublishedReport();
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "queued",
        label: "AI 日报生成",
        entityId: REPORT_DATE,
      },
    });
    writeDailyReportMock.mockResolvedValue(JSON.stringify({
      openingSummary: "太短",
      sections: {},
      closingThought: "太短",
    }));

    await executeDailyReportTask(taskRun);

    const report = await prisma.dailyReport.findFirstOrThrow({
      where: { date: REPORT_DATE, timezone: "Asia/Shanghai" },
    });
    expect(report.id).toBe(existing.id);
    expect(report.status).toBe("published");
    expect(report.renderedMarkdown).toBe("# 已发布日报\n");
    expect(report.errorMessage).toBeNull();
    expect(report.taskRunId).toBe(existing.taskRunId);
  });

  it("does not create a failed report placeholder when first generation fails", async () => {
    await createReportCandidates();
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "queued",
        label: "AI 日报生成",
        entityId: REPORT_DATE,
      },
    });
    writeDailyReportMock.mockResolvedValue(JSON.stringify({
      openingSummary: "太短",
      sections: {},
      closingThought: "太短",
    }));

    await executeDailyReportTask(taskRun);

    await expect(prisma.dailyReport.findFirst({
      where: { date: REPORT_DATE, timezone: "Asia/Shanghai" },
    })).resolves.toBeNull();
    const failedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    expect(failedTaskRun).toMatchObject({
      status: "failed",
      errorSummary: expect.stringContaining("WRITE 校验失败"),
      aiCallCountActual: 8,
      aiCallCountEstimated: 8,
    });
    expect(writeDailyReportMock).toHaveBeenCalledTimes(6);
    expect(writeDailyReportMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      validationFeedback: expect.objectContaining({
        violations: expect.arrayContaining([
          expect.objectContaining({ code: "draft_schema" }),
        ]),
      }),
    }));
    expect(JSON.parse(failedTaskRun.aiCallBreakdownJson ?? "[]")).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "daily_report", actual: 8, estimated: 8 }),
    ]));
    expect(JSON.parse(failedTaskRun.pipelineCheckpointJson ?? "{}")).toMatchObject({
      failedStage: "write",
      failureCode: "stage_failed",
      resumeEligible: false,
      data: { writeRetryCount: 1, writeRepairRound: 2 },
    });
  });

  it("repairs WRITE structural and note violations in the same context", async () => {
    await createReportCandidates();
    const dailyReportPrompt = await prisma.promptConfig.findFirstOrThrow({
      where: { type: "daily_report", isDefault: true },
    });
    const template = JSON.parse(dailyReportPrompt.templateJson ?? "{}");
    template.blocks = template.blocks.map((block: Record<string, unknown>) => block.key === "hot-topics"
      ? {
          ...block,
          item: {
            ...(block.item as Record<string, unknown>),
            notes: [{ label: "重点", required: true, instruction: "说明为什么值得关注。" }],
          },
        }
      : block);
    await prisma.promptConfig.update({
      where: { id: dailyReportPrompt.id },
      data: { templateJson: JSON.stringify(template) },
    });
    writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: SelectedTopicFixture[] }) => {
      const output = JSON.parse(buildDailyReportOutput(selectedTopics)) as { blocks: Array<{ type: string; items?: unknown[] }> };
      if (writeDailyReportMock.mock.calls.length === 1) {
        const hotBlock = output.blocks.find((block) => block.type === "section" && Array.isArray(block.items));
        if (hotBlock?.items) hotBlock.items = hotBlock.items.slice(0, -1);
      } else {
        for (const block of output.blocks) {
          if (block.type !== "section" || !Array.isArray(block.items)) continue;
          if ((block as { blockKey?: string }).blockKey !== "hot-topics") continue;
          block.items = (block.items as Array<Record<string, unknown>>).map((item) => ({
            ...item,
            notes: [{ label: "重点", text: "基于候选事实补充的重点说明。" }],
          }));
        }
      }
      return JSON.stringify(output);
    });
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "queued",
        label: "AI 日报生成",
        entityId: REPORT_DATE,
      },
    });

    await executeDailyReportTask(taskRun);

    const completedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    expect(completedTaskRun.status).toBe("succeeded");
    expect(writeDailyReportMock).toHaveBeenCalledTimes(2);
    expect(writeDailyReportMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      validationFeedback: expect.objectContaining({ violations: expect.any(Array) }),
    }));
    expect(completedTaskRun.aiCallCountActual).toBe(4);
    expect(JSON.parse(completedTaskRun.taskTimelineJson ?? "[]")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "daily_report_write",
        metrics: expect.arrayContaining([
          { label: "修复轮数", value: 1 },
          { label: "完整重试", value: 0 },
        ]),
      }),
    ]));
  });
});
