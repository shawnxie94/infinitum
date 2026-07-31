import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";
import {
  buildDailyReportTitle,
  executeDailyReportTask,
  generateDailyReport,
} from "@/lib/daily-report/service";
import { getDailyReportByDate, listDailyReportCandidates } from "@/lib/daily-report/repository";
import { updateBriefingPreferenceConfig, updateEventBriefingConfig } from "@/lib/settings/service";

const {
  generateDailyReportMock,
  repairDailyReportJsonMock,
} = vi.hoisted(() => ({
  generateDailyReportMock: vi.fn(),
  repairDailyReportJsonMock: vi.fn(),
}));

vi.mock("@/lib/ai/provider", () => ({
  createAiProvider: vi.fn(() => ({
    generateDailyReport: generateDailyReportMock,
    repairDailyReportJson: repairDailyReportJsonMock,
  })),
}));

const REPORT_DATE = "2026-04-24";

function buildDailyReportOutput() {
  return JSON.stringify({
    headline: "OpenAI 发布新模型、开发者工具更新",
    blocks: [
      {
        type: "text",
        title: "摘要",
        body: "今天 AI 生态的重点变化集中在模型发布、开发者工具更新与工程实践调整，值得关注其对产品迭代和开发流程的影响。",
      },
      {
        type: "section",
        title: "今日大事",
        items: [{
          title: "OpenAI 发布新模型",
          body: "OpenAI 发布新模型，带来更强的推理和工具调用能力，短期内会影响开发者选型和产品功能设计。",
          notes: [{ label: "重点", text: "模型能力继续上探" }],
          sourceIds: [1],
        }],
      },
      {
        type: "section",
        title: "变更与实践",
        items: [{
          title: "开发者工具更新",
          body: "开发者工具更新后，团队需要关注 CLI 与 IDE 工作流是否需要调整，以降低后续迁移成本。",
          sourceIds: [2],
        }],
      },
      {
        type: "text",
        title: "趋势观察",
        body: "整体来看，今天的主线仍是模型能力与工程工具继续耦合，后续需要观察实际开发效率是否随之改善。",
      },
    ],
  });
}

function buildDailyReportOutputWithRepeatedSources() {
  const parsed = JSON.parse(buildDailyReportOutput()) as {
    blocks: Array<
      | { type: "text"; title: string; body: string }
      | { type: "section"; title: string; items: Array<{ title: string; body: string; notes?: unknown[]; sourceIds: number[] }> }
    >;
  };

  return JSON.stringify({
    ...parsed,
    blocks: parsed.blocks.map((block) => {
      if (block.type !== "section" || block.title !== "变更与实践") return block;
      return {
        ...block,
        items: [
          {
            title: "OpenAI 发布新模型实践影响",
            body: "跟进同一事件对开发工作流的影响，避免只按模型发布本身判断后续工程投入。",
            sourceIds: [1],
          },
          {
            title: "开发者工具更新数据",
            body: "同一来源编号即使跨栏目出现也只应计为一个逻辑引用，避免日报来源数量被重复放大。",
            notes: [{ label: "关键数字", text: "2 个来源编号去重" }],
            sourceIds: [2],
          },
        ],
      };
    }),
  });
}

function getLastGeneratedDailyReportArticles() {
  return getLastGeneratedDailyReportInput()?.articles ?? [];
}

function getLastGeneratedDailyReportInput() {
  return generateDailyReportMock.mock.calls.at(-1)?.[0] as {
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

async function createDailyReportSchedule(input: { autoPublish: boolean }) {
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
      dailyReportAutoPublish: input.autoPublish,
      timezone: "Asia/Shanghai",
      nextRunAt: new Date("2026-04-25T00:30:00.000Z"),
    },
  });
}

describe("daily report service", () => {
  beforeEach(async () => {
    generateDailyReportMock.mockReset();
    repairDailyReportJsonMock.mockReset();
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
  });

  it("turns an existing published report into a clean draft when regenerated", async () => {
    await createReportCandidates();
    await createPublishedReport();
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

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
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

    const result = await generateDailyReport({ date: REPORT_DATE, force: true });
    const sources = await prisma.dailyReportSource.findMany({
      where: { dailyReportId: result.report?.id },
      orderBy: { sourceNumber: "asc" },
    });

    expect(sources.map((source) => source.sourceNumber)).toEqual([1, 2]);
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
      selectedCount: 2,
      excludedRecentDuplicates: [],
      candidateCoverage: {
        candidateCount: 4,
        selectedCount: 2,
      },
    });
  });

  it("reports sourceCount as distinct referenced items", async () => {
    await createReportCandidates();
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutputWithRepeatedSources());

    const result = await generateDailyReport({ date: REPORT_DATE, force: true });
    const rows = await prisma.dailyReportSource.count({
      where: { dailyReportId: result.report?.id },
    });
    const detail = await getDailyReportByDate(REPORT_DATE, true);

    expect(rows).toBe(2);
    expect(detail?.sourceCount).toBe(2);
  });

  it("counts expanded cluster items as report sources", async () => {
    await createClusteredReportCandidates();
    generateDailyReportMock.mockResolvedValue(JSON.stringify({
      blocks: [
        {
          type: "text",
          title: "摘要",
          body: "今天的 AI 生态重点集中在多来源确认的模型发布，多个独立来源围绕同一事件提供了互补信息，适合用于验证日报引用计数。",
        },
        {
          type: "section",
          title: "今日大事",
          items: [{
            title: "多来源模型发布",
            body: "多家来源确认同一个模型发布事件，可以用于观察聚合候选展开后的来源数量是否准确。",
            notes: [{ label: "重点", text: "多源确认" }],
            sourceIds: [1],
          }],
        },
        {
          type: "section",
          title: "变更与实践",
          items: [{
            title: "引用计数口径调整",
            body: "按展开后的实际单条内容核算日报来源数量，避免把一个聚合候选误读为一个来源。",
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
    generateDailyReportMock.mockResolvedValue(JSON.stringify({
      headline: "安全事件优先",
      blocks: [
        {
          type: "text",
          title: "摘要",
          body: "今天日报候选应来自事件速览排序结果，而不是旧的质量分候选池。",
        },
        {
          type: "section",
          title: "今日大事",
          items: [{
            title: "安全事件需要优先进入日报",
            body: "该事件命中事件速览偏好规则，即使质量分不是最高，也应作为日报候选。",
            sourceIds: [1],
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
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

    await generateDailyReport({ date: REPORT_DATE, force: true });

    expect(getLastGeneratedDailyReportArticles().map((article) => article.title)).toEqual([
      "开发者工具更新",
      "开发者社区发布插件规范",
    ]);
  });

  it("removes the same candidate from later report sections deterministically", async () => {
    await createReportCandidates();
    await createDailyReportSchedule({ autoPublish: false });
    generateDailyReportMock.mockResolvedValue(JSON.stringify({
      headline: "同一候选只保留一次",
      blocks: [
        {
          type: "text",
          title: "摘要",
          body: "今天的日报候选经过跨栏目去重后，同一篇内容只保留在首次出现的栏目中，避免重复总结同一事件。",
        },
        {
          type: "section",
          title: "今日大事",
          items: [{
            title: "OpenAI 发布新模型",
            body: "OpenAI 发布新模型，带来新的能力变化。",
            sourceIds: [1],
          }],
        },
        {
          type: "section",
          title: "变更与实践",
          items: [{
            title: "同一候选的补充说明",
            body: "同一候选不应在后续栏目重复出现，但本栏目仍保留另一条独立内容。",
            sourceIds: [1, 2],
          }],
        },
      ],
    }));

    const result = await generateDailyReport({ date: REPORT_DATE, force: true });
    const sources = await prisma.dailyReportSource.findMany({
      where: { dailyReportId: result.report?.id },
      orderBy: { sourceNumber: "asc" },
    });
    const summary = JSON.parse(result.report?.summaryJson ?? "{}") as {
      blocks: Array<{ type: string; items?: Array<{ sourceIds: number[] }> }>;
    };

    expect(sources.map((source) => source.sourceNumber)).toEqual([1, 2]);
    expect(summary.blocks.filter((block) => block.type === "section").flatMap((block) => block.items ?? []).map((item) => item.sourceIds)).toEqual([
      [1],
      [2],
    ]);
  });

  it("refills only a section emptied by duplicate removal", async () => {
    await createReportCandidates();
    await createDailyReportSchedule({ autoPublish: false });
    generateDailyReportMock.mockResolvedValue(JSON.stringify({
      headline: "空栏目确定性补位",
      blocks: [
        {
          type: "section",
          title: "今日大事",
          items: [{
            title: "OpenAI 发布新模型",
            body: "OpenAI 发布新模型，带来新的能力变化。",
            sourceIds: [1],
          }],
        },
        {
          type: "section",
          title: "变更与实践",
          items: [{
            title: "同一候选的补充说明",
            body: "这一条内容在去重后会变为空栏目，并使用下一个未使用候选补位。",
            sourceIds: [1],
          }],
        },
      ],
    }));

    const result = await generateDailyReport({ date: REPORT_DATE, force: true });
    const summary = JSON.parse(result.report?.summaryJson ?? "{}") as {
      blocks: Array<{ type: string; title: string; items?: Array<{ title: string; sourceIds: number[] }> }>;
    };
    const snapshot = JSON.parse(result.report?.candidateSnapshot ?? "{}") as {
      emptySectionsAfterDeduplication?: string[];
      refilledEmptySections?: string[];
      removedEmptySections?: string[];
    };

    expect(summary.blocks.filter((block) => block.type === "section").map((block) => ({
      title: block.title,
      items: block.items?.map((item) => ({ title: item.title, sourceIds: item.sourceIds })),
    }))).toEqual([
      {
        title: "今日大事",
        items: [{ title: "OpenAI 发布新模型", sourceIds: [1] }],
      },
      {
        title: "变更与实践",
        items: [{ title: "开发者工具更新", sourceIds: [2] }],
      },
    ]);
    expect(snapshot).toMatchObject({
      emptySectionsAfterDeduplication: ["变更与实践"],
      refilledEmptySections: ["变更与实践"],
      removedEmptySections: [],
    });
  });

  it("removes an empty section when duplicate removal leaves no unused candidate", async () => {
    await createReportCandidates();
    await createDailyReportSchedule({ autoPublish: false });
    generateDailyReportMock.mockResolvedValue(JSON.stringify({
      headline: "空栏目删除",
      blocks: [
        {
          type: "section",
          title: "今日大事",
          items: [{
            title: "多条内容汇总",
            body: "这一栏目已经使用候选池中的全部内容，因此后续空栏目没有可补位候选。",
            sourceIds: [1, 2, 3, 4],
          }],
        },
        {
          type: "section",
          title: "变更与实践",
          items: [{
            title: "重复内容",
            body: "这一栏目会在去重后变为空栏目，并被安全删除。",
            sourceIds: [1],
          }],
        },
      ],
    }));

    const result = await generateDailyReport({ date: REPORT_DATE, force: true });
    const summary = JSON.parse(result.report?.summaryJson ?? "{}") as {
      blocks: Array<{ type: string; title: string }>;
    };
    const snapshot = JSON.parse(result.report?.candidateSnapshot ?? "{}") as {
      emptySectionsAfterDeduplication?: string[];
      refilledEmptySections?: string[];
      removedEmptySections?: string[];
    };

    expect(summary.blocks.filter((block) => block.type === "section").map((block) => block.title)).toEqual(["今日大事"]);
    expect(snapshot).toMatchObject({
      emptySectionsAfterDeduplication: ["变更与实践"],
      refilledEmptySections: [],
      removedEmptySections: ["变更与实践"],
    });
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
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

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
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

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
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

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
    generateDailyReportMock.mockResolvedValue(JSON.stringify({
      blocks: [
        { type: "text", title: "摘要", body: "今天多来源模型发布事件集中出现，日报只展示代表性来源，避免相似引用过多影响阅读。" },
        {
          type: "section",
          title: "今日大事",
          items: [{
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
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

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
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

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
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

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
      date: "2026-04-16",
      title: "七天外主题",
      eventSubject: "Old",
      eventObject: "Topic",
    });
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

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
    expect(recentTopics.map((topic) => topic.title)).not.toContain("七天外主题");
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
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

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
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

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
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

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
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

    await generateDailyReport({ date: REPORT_DATE, force: true });

    expect(getLastGeneratedDailyReportArticles().map((article) => article.title)).toContain("Anthropic 发布 Claude 4");
  });

  it("publishes the report immediately when daily report auto publish is enabled", async () => {
    await createDailyReportSchedule({ autoPublish: true });
    await createReportCandidates();
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

    await generateDailyReport({ date: REPORT_DATE, force: true });

    const report = await prisma.dailyReport.findFirstOrThrow({
      where: { date: REPORT_DATE, timezone: "Asia/Shanghai" },
    });
    expect(report.status).toBe("published");
    expect(report.publishedAt).toBeInstanceOf(Date);
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
    generateDailyReportMock.mockResolvedValue(buildDailyReportOutput());

    await executeDailyReportTask(taskRun);

    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    const timeline = JSON.parse(storedTaskRun.taskTimelineJson ?? "[]") as Array<{
      key: string;
      label: string;
      metrics: Array<{ label: string; value: number }>;
    }>;

    expect(timeline).toMatchObject([
      {
        key: "daily_report_generate",
        label: "AI 日报生成",
        metrics: [{ label: "总候选数", value: 4 }],
      },
      {
        key: "task_finished",
        label: "已完成",
        metrics: [{ label: "最后入选数", value: 2 }],
      },
    ]);
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
    generateDailyReportMock.mockResolvedValue(JSON.stringify({
      openingSummary: "太短",
      sections: {},
      closingThought: "太短",
    }));
    repairDailyReportJsonMock.mockResolvedValue(null);

    await executeDailyReportTask(taskRun);

    const report = await prisma.dailyReport.findFirstOrThrow({
      where: { date: REPORT_DATE, timezone: "Asia/Shanghai" },
    });
    expect(report.id).toBe(existing.id);
    expect(report.status).toBe("published");
    expect(report.renderedMarkdown).toBe("# 已发布日报\n");
    expect(report.errorMessage).toContain("日报输出校验失败");
    expect(report.taskRunId).toBe(taskRun.id);
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
    generateDailyReportMock.mockResolvedValue(JSON.stringify({
      openingSummary: "太短",
      sections: {},
      closingThought: "太短",
    }));
    repairDailyReportJsonMock.mockResolvedValue(null);

    await executeDailyReportTask(taskRun);

    await expect(prisma.dailyReport.findFirst({
      where: { date: REPORT_DATE, timezone: "Asia/Shanghai" },
    })).resolves.toBeNull();
    const failedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    expect(failedTaskRun).toMatchObject({
      status: "failed",
      errorSummary: expect.stringContaining("日报输出校验失败"),
      aiCallCountActual: 2,
      aiCallCountEstimated: 2,
    });
    expect(JSON.parse(failedTaskRun.aiCallBreakdownJson ?? "[]")).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "daily_report", actual: 2, estimated: 2 }),
    ]));
  });
});
