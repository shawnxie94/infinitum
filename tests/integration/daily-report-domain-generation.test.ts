import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { prisma } from "@/lib/db";
import { generateDailyReport } from "@/lib/daily-report/service";
import { getDailyReportByDate } from "@/lib/daily-report/repository";
import { ensureRuntimeConfigSeeded, getIngestionRuntimeConfig } from "@/lib/settings/service";

const {
  assessDailyReportCandidatesMock,
  planDailyReportMock,
  repairDailyReportMock,
  reviewDailyReportMock,
  writeDailyReportMock,
} = vi.hoisted(() => ({
  assessDailyReportCandidatesMock: vi.fn(),
  planDailyReportMock: vi.fn(),
  repairDailyReportMock: vi.fn(),
  reviewDailyReportMock: vi.fn(),
  writeDailyReportMock: vi.fn(),
}));

vi.mock("@/lib/ai/provider-next", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createAiProvider: vi.fn(() => ({
    assessDailyReportCandidates: assessDailyReportCandidatesMock,
    planDailyReport: planDailyReportMock,
    repairDailyReportDraft: repairDailyReportMock,
    reviewDailyReport: reviewDailyReportMock,
    writeDailyReport: writeDailyReportMock,
  })),
}));

const REPORT_DATE = "2026-04-24";
const fixtureDir = resolve(__dirname, "../fixtures/domain-daily-reports");
const financeTemplateJson = readFileSync(resolve(fixtureDir, "finance-v3.json"), "utf8");
const industryTemplateJson = readFileSync(resolve(fixtureDir, "industry-brief-v3.json"), "utf8");
const mixedSamples = JSON.parse(readFileSync(resolve(fixtureDir, "mixed-samples-annotated.json"), "utf8")) as {
  samples: Array<{ id: string; title: string; summary: string }>;
};

const financeBlockPlan = ["macro-policy", "company-industry", "company-industry", "macro-policy", "market-move", "market-move", "company-industry", "company-industry"];
const industryBlockPlan = ["focus", "focus", "focus", "brief-updates", "brief-updates", "focus", "brief-updates", "focus"];
const defaultBlockPlan = ["hot-topics", "changes-practice", "changes-practice", "hot-topics", "changes-practice", "other-worth-reading", "other-worth-reading", "other-worth-reading"];

function permissiveTemplate(templateJson: string) {
  const template = JSON.parse(templateJson) as {
    blocks: Array<Record<string, unknown>>;
  };
  template.blocks = template.blocks.map((block) => block.type === "section"
    ? { ...block, required: false, minItems: 0, item: { ...(block.item as Record<string, unknown>), notes: [] } }
    : block);
  return JSON.stringify(template);
}

async function createMixedSampleCandidates() {
  const source = await prisma.source.create({
    data: { name: "Domain Source", rssUrl: "https://domain.example.com/feed.xml", siteUrl: "https://domain.example.com" },
  });
  await prisma.item.createMany({
    data: mixedSamples.samples.map((sample, index) => ({
      sourceId: source.id,
      originalUrl: `https://domain.example.com/${sample.id.toLowerCase()}`,
      canonicalUrl: `https://domain.example.com/${sample.id.toLowerCase()}`,
      urlHash: `domain-sample-${sample.id.toLowerCase()}`,
      originalTitle: sample.title,
      publishedAt: new Date(`2026-04-24T0${index % 10}:00:00.000Z`),
      createdAt: new Date(`2026-04-24T0${index % 10}:00:00.000Z`),
      status: "processed",
      moderationStatus: "allowed",
      summaryText: sample.summary,
      qualityScore: 90 - index,
    })),
  });
}

describe("domain-adaptable daily report generation (controlled)", () => {
  const sourceCreateOriginal = prisma.source.create.bind(prisma.source);

  beforeEach(async () => {
    assessDailyReportCandidatesMock.mockReset();
    planDailyReportMock.mockReset();
    repairDailyReportMock.mockReset();
    reviewDailyReportMock.mockReset();
    writeDailyReportMock.mockReset();
    assessDailyReportCandidatesMock.mockImplementation(async ({ candidates }: { candidates: Array<{ id: number }> }) =>
      candidates.map((candidate) => ({ candidateId: candidate.id, relevanceScore: 90, isWorthReading: true, suggestedBlockKey: null, historyDecision: "new" })));
    repairDailyReportMock.mockResolvedValue({ patches: [] });
    reviewDailyReportMock.mockResolvedValue({ verdict: "pass", violations: [], summary: "通过" });
    await prisma.dailyReportSource.deleteMany();
    await prisma.dailyReport.deleteMany();
    await prisma.dailyReportRevision.deleteMany();
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
    await prisma.sourceFollow.deleteMany();
    await prisma.eventBriefingConfig.deleteMany();
    vi.spyOn(prisma.source, "create").mockImplementation((async (args) => {
      const source = await sourceCreateOriginal(args);
      await prisma.sourceFollow.create({ data: { sourceId: source.id } });
      return source;
    }) as typeof prisma.source.create);
    await ensureRuntimeConfigSeeded();
  });

  const cases: Array<{
    name: string;
    templateJson: string;
    blockPlan: string[];
    expectTitles: string[];
    forbiddenTitles: string[];
  }> = [
    {
      name: "finance v3 template",
      templateJson: financeTemplateJson,
      blockPlan: financeBlockPlan,
      expectTitles: ["宏观与政策", "公司与产业"],
      forbiddenTitles: ["热点事件", "今日焦点"],
    },
    {
      name: "third-domain industry template",
      templateJson: industryTemplateJson,
      blockPlan: industryBlockPlan,
      expectTitles: ["今日焦点", "简讯"],
      forbiddenTitles: ["热点事件", "宏观与政策"],
    },
    {
      name: "default AI template",
      templateJson: "",
      blockPlan: defaultBlockPlan,
      expectTitles: ["热点事件"],
      forbiddenTitles: ["宏观与政策", "今日焦点"],
    },
  ];

  for (const testCase of cases) {
    it(`generates a complete report through the same pipeline for ${testCase.name} (A1/R4)`, async () => {
      await getIngestionRuntimeConfig();
      const promptConfig = await prisma.promptConfig.findFirstOrThrow({ where: { type: "daily_report", isDefault: true } });
      const templateJson = testCase.templateJson
        ? permissiveTemplate(testCase.templateJson)
        : permissiveTemplate(promptConfig.templateJson!);
      const template = JSON.parse(templateJson) as { selectionRules: string[] };
      await prisma.promptConfig.update({ where: { id: promptConfig.id }, data: { templateJson } });
      await createMixedSampleCandidates();

      planDailyReportMock.mockImplementation(async ({ candidateBriefs }: { candidateBriefs: Array<{ candidateId: number }> }) => {
        const topicsByBlock = new Map<string, Array<{ candidateIds: number[] }>>();
        candidateBriefs.forEach((brief, index) => {
          const blockKey = testCase.blockPlan[index]!;
          topicsByBlock.set(blockKey, [...(topicsByBlock.get(blockKey) ?? []), { candidateIds: [brief.candidateId] }]);
        });
        return {
          schemaVersion: 2,
          sections: [...topicsByBlock.entries()].map(([blockKey, topics]) => ({ blockKey, topics })),
        };
      });
      writeDailyReportMock.mockImplementation(async ({ selectedTopics }: { selectedTopics: Array<{ topicId: string; blockKey: string; candidateIds: number[] }> }) => {
        const parsed = JSON.parse(templateJson) as { blocks: Array<{ type: string; key?: string; title: string }> };
        const titleByKey = new Map(parsed.blocks.filter((block) => block.type === "section").map((block) => [block.key!, block.title]));
        return {
          headline: "混合样本主题标题",
          blocks: parsed.blocks.map((block) => {
            if (block.type === "text") return { type: "text", title: block.title, body: "本期主线综述正文，覆盖主要事实变化。" };
            if (block.type === "section" && !selectedTopics.some((topic) => topic.blockKey === block.key)) return null;
            const topics = selectedTopics.filter((topic) => topic.blockKey === block.key);
            if (topics.length === 0) return null;
            return {
              type: "section",
              blockKey: block.key,
              title: block.title,
              items: topics.map((topic) => ({
                topicId: topic.topicId,
                title: `${titleByKey.get(topic.blockKey)}条目 ${topic.topicId}`,
                body: "条目正文，说明事件主体、动作、结果和影响。",
                notes: [],
                sourceIds: topic.candidateIds,
              })),
            };
          }).filter(Boolean),
        };
      });

      const result = await generateDailyReport({ date: REPORT_DATE, force: true });

      expect(result.report?.id).toBeTruthy();
      expect(assessDailyReportCandidatesMock.mock.calls[0]?.[0]?.candidates).toHaveLength(mixedSamples.samples.length);
      expect(planDailyReportMock.mock.calls[0]?.[0]?.template.selectionRules).toEqual(template.selectionRules);
      const writeInput = writeDailyReportMock.mock.calls[0]?.[0];
      const plannedCount = planDailyReportMock.mock.calls[0]?.[0]?.candidateBriefs.length ?? 0;
      expect(plannedCount).toBeGreaterThanOrEqual(6);
      expect(writeInput?.selectedTopics.length).toBeGreaterThanOrEqual(6);
      expect(writeInput?.selectedTopics.length).toBeGreaterThanOrEqual(plannedCount - 1);
      expect(writeInput?.selectedTopics.length).toBeLessThanOrEqual(plannedCount);

      const detail = await getDailyReportByDate(REPORT_DATE, true);
      expect(detail?.content).toBeTruthy();
      const content = detail!.content as { blocks: Array<{ type: string; title: string; items?: unknown[] }> };
      const titles = content.blocks.filter((block) => block.type === "section").map((block) => block.title);
      for (const expectTitle of testCase.expectTitles) expect(titles).toContain(expectTitle);
      for (const forbiddenTitle of testCase.forbiddenTitles) expect(titles).not.toContain(forbiddenTitle);
      const sectionItems = content.blocks.flatMap((block) => block.items ?? []);
      expect(sectionItems.length).toBeGreaterThanOrEqual(plannedCount - 1);
    });
  }
});
