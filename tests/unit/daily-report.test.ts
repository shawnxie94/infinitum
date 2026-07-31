import { describe, expect, it } from "vitest";

import {
  assertDailyReportDateIsNotFuture,
  formatDailyReportDateTime,
  getDailyReportDateRange,
  normalizeDailyReportDate,
} from "@/lib/daily-report/date";
import { buildDailyReportDetailMarkdown, buildDailyReportExportMarkdown } from "@/lib/daily-report/export";
import { normalizeDailyReportContent } from "@/lib/daily-report/content";
import { renderDailyReportMarkdown } from "@/lib/daily-report/renderer";
import {
  buildDailyReportCandidateCoverage,
  deduplicateDailyReportContentByCandidate,
} from "@/lib/daily-report/service";
import type { DailyReportCandidate, DailyReportContent, DailyReportDetailDTO } from "@/lib/daily-report/types";
import { parseDailyReportContent } from "@/lib/daily-report/validator";

const candidates: DailyReportCandidate[] = [
  {
    id: 1,
    sourceKey: "item:item-1",
    itemId: "item-1",
    clusterId: null,
    title: "OpenAI 发布新模型",
    itemTitle: "OpenAI 发布新模型",
    sourceName: "Source A",
    url: "https://example.com/a",
    summary: "OpenAI 发布新模型摘要",
    qualityScore: 90,
    candidateScore: 90,
    sourceCount: 1,
    itemCount: 1,
    createdAt: "2026-04-24T01:00:00.000Z",
    publishedAt: "2026-04-24T01:00:00.000Z",
    eventType: "release",
    eventSubject: "OpenAI",
    eventAction: "发布",
    eventObject: "新模型",
    eventDate: "2026-04-24",
  },
  {
    id: 2,
    sourceKey: "item:item-2",
    itemId: "item-2",
    clusterId: null,
    title: "开发者工具更新",
    itemTitle: "开发者工具更新",
    sourceName: "Source B",
    url: "https://example.com/b",
    summary: "开发者工具更新摘要",
    qualityScore: 80,
    candidateScore: 80,
    sourceCount: 1,
    itemCount: 1,
    createdAt: "2026-04-24T02:00:00.000Z",
    publishedAt: "2026-04-24T02:00:00.000Z",
    eventType: "update",
    eventSubject: "Tool",
    eventAction: "更新",
    eventObject: "CLI",
    eventDate: null,
  },
];

const content: DailyReportContent = {
  blocks: [
    {
      type: "text",
      title: "摘要",
      body: "今天 AI 生态的重点变化集中在模型发布、开发者工具更新与工程实践调整，值得关注其对产品迭代和开发流程的影响。",
    },
    {
      type: "section",
      title: "热点事件",
      items: [
        {
          title: "OpenAI 发布新模型",
          body: "OpenAI 发布新模型，带来更强的推理和工具调用能力，短期内会影响开发者选型和产品功能设计。",
          notes: [{ label: "重点", text: "模型能力继续上探" }],
          sourceIds: [1, 2],
        },
      ],
    },
    {
      type: "section",
      title: "变更与实践",
      items: [
        {
          title: "开发者工具更新",
          body: "关注 CLI 与 IDE 工作流是否需要调整。",
          sourceIds: [2],
        },
      ],
    },
    {
      type: "section",
      title: "安全与风险",
      items: [
        {
          title: "AI 安全事件",
          body: "说明风险事件主体、背景和影响范围。",
          notes: [
            { label: "影响", text: "使用相关模型的普通用户和企业团队" },
            { label: "建议", text: "关注官方修复说明并避免上传敏感数据" },
          ],
          sourceIds: [1],
        },
      ],
    },
    { type: "section", title: "开源与工具", items: [] },
    { type: "section", title: "数据与洞察", items: [] },
    {
      type: "text",
      title: "趋势观察",
      body: "整体来看，今天的主线仍是模型能力与工程工具继续耦合，后续需要观察实际开发效率是否随之改善。",
    },
  ],
};

describe("daily report utilities", () => {
  it("uses Asia/Shanghai single-day createdAt boundaries", () => {
    const range = getDailyReportDateRange("2026-04-24");

    expect(range.start.toISOString()).toBe("2026-04-23T16:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-04-24T16:00:00.000Z");
  });

  it("rejects invalid and future daily report dates", () => {
    expect(() => normalizeDailyReportDate("2026-02-30")).toThrow("日报日期不存在");
    expect(() => assertDailyReportDateIsNotFuture(
      "2026-04-26",
      new Date("2026-04-25T10:00:00.000Z"),
    )).toThrow("不能生成未来日期");
    expect(assertDailyReportDateIsNotFuture(
      "2026-04-25",
      new Date("2026-04-25T10:00:00.000Z"),
    )).toBe("2026-04-25");
  });

  it("formats daily report timestamps in Asia/Shanghai", () => {
    expect(formatDailyReportDateTime("2026-04-24T01:30:00.000Z")).toBe("2026/04/24 09:30");
  });

  it("validates block model output and rejects invalid source ids", () => {
    const parsed = parseDailyReportContent(JSON.stringify({
      ...content,
      title: "模型返回的标题会被忽略",
      headline: "2026-04-24日报 | OpenAI 发布新模型、开发者工具更新、",
    }), 2);

    expect(parsed).not.toHaveProperty("title");
    expect(parsed.headline).toBe("OpenAI 发布新模型、开发者工具更新");
    expect(parsed.blocks[1]).toMatchObject({ type: "section", title: "热点事件" });
    expect(parseDailyReportContent(JSON.stringify({
      ...content,
      headline: "GPT-5.6 有限预览、Mythos 5 白名单恢复、亚马逊加码印度、DeepSeek 开源提速、OpenAI 版权诉讼升温",
    }), 2).headline).toBe("GPT-5.6 有限预览、Mythos 5 白名单恢复、亚马逊加码印度、DeepSeek 开源提速、OpenAI 版权诉讼升温");
    expect(() => parseDailyReportContent(JSON.stringify({
      blocks: content.blocks.map((block) =>
        block.type === "section" && block.title === "热点事件"
          ? { ...block, items: [{ ...block.items[0], sourceIds: [99] }] }
          : block,
      ),
    }), 2)).toThrow(/sourceIds/);
  });

  it("allows compact section items without body and renders title with sources", () => {
    const parsed = parseDailyReportContent(JSON.stringify({
      blocks: [
        {
          type: "text",
          title: "摘要",
          body: "今天 AI 生态的重点变化集中在模型发布、开发者工具更新与工程实践调整，值得关注其对产品迭代和开发流程的影响。",
        },
        {
          type: "section",
          title: "其他值得关注",
          items: [
            {
              title: "开发者工具更新",
              sourceIds: [2],
            },
          ],
        },
      ],
    }), 2);

    const compactSection = parsed.blocks[1];
    expect(compactSection.type).toBe("section");
    if (compactSection.type === "section") {
      expect(compactSection.items[0]).toMatchObject({
        title: "开发者工具更新",
        body: "",
        sourceIds: [2],
      });
    }

    const markdown = renderDailyReportMarkdown(parsed, candidates, "2026-04-24 AI 日报");

    expect(markdown).toContain("### 开发者工具更新");
    expect(markdown).toContain("**来源：**");
    expect(markdown).toContain("[开发者工具更新](https://example.com/b)");
    expect(markdown).not.toContain("undefined");
  });

  it("drops auxiliary section items without legal source ids but keeps strict source checks elsewhere", () => {
    const parsed = parseDailyReportContent(JSON.stringify({
      blocks: [
        content.blocks[0],
        {
          type: "section",
          title: "其他值得关注",
          items: [
            {
              title: "无来源补充条目",
              body: "缺少来源时应丢弃。",
              sourceIds: [],
            },
            {
              title: "开发者工具更新",
              body: "",
              sourceIds: [2],
            },
          ],
        },
      ],
    }), 2);
    const auxiliarySection = parsed.blocks[1];

    expect(auxiliarySection.type).toBe("section");
    if (auxiliarySection.type === "section") {
      expect(auxiliarySection.items).toHaveLength(1);
      expect(auxiliarySection.items[0].title).toBe("开发者工具更新");
    }

    expect(() => parseDailyReportContent(JSON.stringify({
      blocks: [
        content.blocks[0],
        {
          type: "section",
          title: "热点事件",
          items: [{
            title: "无来源主栏目条目",
            body: "",
            sourceIds: [],
          }],
        },
      ],
    }), 2)).toThrow(/sourceIds/);
  });

  it("strips generated labels from text block bodies and notes", () => {
    const parsed = parseDailyReportContent(JSON.stringify({
      blocks: [
        {
          type: "text",
          title: "摘要",
          body: "摘要：今天 AI 生态的重点变化集中在模型发布、开发者工具更新与工程实践调整，值得关注其对产品迭代和开发流程的影响。",
        },
        {
          type: "section",
          title: "热点事件",
          items: [{
            title: "OpenAI 发布新模型",
            body: "OpenAI 发布新模型，带来更强的推理和工具调用能力，短期内会影响开发者选型和产品功能设计。",
            notes: [{ label: "重点", text: "重点：模型能力继续上探" }],
            sourceIds: [1],
          }],
        },
        {
          type: "text",
          title: "趋势观察",
          body: "趋势观察：整体来看，今天的主线仍是模型能力与工程工具继续耦合，后续需要观察实际开发效率是否随之改善。",
        },
      ],
    }), 2);

    expect(parsed.blocks[0]).toMatchObject({ type: "text", body: expect.not.stringMatching(/^摘要：/) });
    const section = parsed.blocks[1];
    expect(section.type).toBe("section");
    if (section.type === "section") {
      expect(section.items[0].notes?.[0].text).toBe("模型能力继续上探");
    }
    expect(parsed.blocks[2]).toMatchObject({ type: "text", body: expect.not.stringMatching(/^趋势观察：/) });
  });

  it("drops malformed optional notes without failing the whole report", () => {
    const parsed = parseDailyReportContent(JSON.stringify({
      ...content,
      blocks: content.blocks.map((block) => (
        block.type === "section" && block.title === "热点事件"
          ? {
              ...block,
              items: [{
                ...block.items[0],
                notes: [
                  { label: "", text: "缺少标签的补充内容" },
                  { label: "重点", text: "有效的重点内容" },
                  { label: "影响", text: "" },
                  null,
                ],
              }],
            }
          : block
      )),
    }), 2);

    const section = parsed.blocks.find((block) => block.type === "section" && block.title === "热点事件");
    expect(section?.type).toBe("section");
    if (section?.type === "section") {
      expect(section.items[0]?.notes).toEqual([{ label: "重点", text: "有效的重点内容" }]);
    }
  });

  it("allows duplicate item titles across section blocks", () => {
    const parsed = parseDailyReportContent(JSON.stringify({
      blocks: [
        content.blocks[0],
        content.blocks[1],
        {
          type: "section",
          title: "变更与实践",
          items: [
            {
              title: "开发者工具更新",
              body: "当前工作流需要调整。",
              sourceIds: [2],
            },
            {
              title: "OpenAI 发布新模型",
              body: "重复主题也会保留，用于验证解析不去重。",
              sourceIds: [1],
            },
            {
              title: "开发者工具更新",
              body: "同栏目重复主题也会保留，用于验证顺序稳定。",
              sourceIds: [2],
            },
          ],
        },
      ],
    }), 2);
    const practice = parsed.blocks.find((block) => block.type === "section" && block.title === "变更与实践");

    expect(practice?.type).toBe("section");
    if (practice?.type === "section") {
      expect(practice.items.map((item) => item.title)).toEqual([
        "开发者工具更新",
        "OpenAI 发布新模型",
        "开发者工具更新",
      ]);
    }
  });

  it("renders Markdown with inline sources and no arbitrary field fallback", () => {
    const markdown = renderDailyReportMarkdown(content, candidates, "2026-04-24 AI 日报");

    expect(markdown).toContain("# 2026-04-24 AI 日报");
    expect(markdown).toContain("> 声明：完全使用AI生成，可能存在错误，需谨慎甄别。");
    expect(markdown).toContain("## 摘要");
    expect(markdown).toContain("## 热点事件");
    expect(markdown).not.toContain("风险级别");
    expect(markdown).toContain("关注 CLI 与 IDE 工作流是否需要调整。");
    expect(markdown).toContain("**重点：**");
    expect(markdown).toContain("**来源：**");
    expect(markdown).toContain("[OpenAI 发布新模型](https://example.com/a)");
    expect(markdown).toContain("## 趋势观察");
    expect(markdown).not.toContain("深挖");
  });

  it("renders multiple links for one selected clustered source number", () => {
    const markdown = renderDailyReportMarkdown(content, candidates, "2026-04-24 AI 日报", [
      {
        sourceNumber: 1,
        title: "OpenAI 发布新模型 来源 A",
        url: "https://example.com/a",
        sourceName: "Source A",
      },
      {
        sourceNumber: 1,
        title: "OpenAI 发布新模型 来源 B",
        url: "https://example.com/a-2",
        sourceName: "Source B",
      },
      {
        sourceNumber: 2,
        title: "开发者工具更新",
        url: "https://example.com/b",
        sourceName: "Source B",
      },
    ]);

    expect(markdown).toContain("[OpenAI 发布新模型 来源 A](https://example.com/a)");
    expect(markdown).toContain("[OpenAI 发布新模型 来源 B](https://example.com/a-2)");
    expect(markdown).toContain("[开发者工具更新](https://example.com/b)");
  });

  it("hides empty section headings by default", () => {
    const markdown = renderDailyReportMarkdown({
      blocks: [
        { type: "text", title: "摘要", body: "本期摘要内容覆盖主要变化，用于验证空栏目渲染策略。" },
        { type: "section", title: "安全与风险", items: [] },
        { type: "section", title: "开源与工具", items: [] },
      ],
    }, candidates, "2026-04-24 AI 日报");

    expect(markdown).not.toContain("## 安全与风险");
    expect(markdown).not.toContain("## 开源与工具");
  });

  it("escapes only link-breaking markdown characters in source link titles", () => {
    const markdown = renderDailyReportMarkdown(content, candidates, "2026-04-24 AI 日报", [
      {
        sourceNumber: 1,
        title: "[相关]*特性*_汇总_ `AI` (v1)! #1 + A-B | <tag>",
        url: "https://example.com/a",
        sourceName: "Source A",
      },
      {
        sourceNumber: 2,
        title: "开发者工具更新",
        url: "https://example.com/b",
        sourceName: "Source B",
      },
    ]);

    expect(markdown).toContain(
      "[\\[相关\\]\\*特性\\*\\_汇总\\_ \\`AI\\` \\(v1\\)! #1 + A-B | <tag>](https://example.com/a)",
    );
  });
});

describe("daily report candidate guards", () => {
  it("deduplicates generated sections by cluster, event core, and source identity", () => {
    const duplicateCandidates: DailyReportCandidate[] = [
      {
        ...candidates[0],
        id: 1,
        sourceKey: "cluster:cluster-a",
        itemId: "item-a",
        clusterId: "cluster-a",
        eventSubject: "OpenAI",
        eventObject: "新模型",
      },
      {
        ...candidates[1],
        id: 2,
        sourceKey: "cluster:cluster-b",
        itemId: "item-b",
        clusterId: "cluster-b",
        eventSubject: "OpenAI",
        eventObject: "新模型",
      },
    ];
    const result = deduplicateDailyReportContentByCandidate({
      blocks: [
        { type: "section", title: "今日大事", items: [{ title: "同一事件 A", body: "事件 A", sourceIds: [1] }] },
        { type: "section", title: "变更与实践", items: [{ title: "同一事件 B", body: "事件 B", sourceIds: [2] }] },
      ],
    }, duplicateCandidates);

    expect(result.content.blocks).toEqual([
      { type: "section", title: "今日大事", items: [{ title: "同一事件 A", body: "事件 A", sourceIds: [1] }] },
    ]);
    expect(result.removedEmptySectionTitles).toEqual(["变更与实践"]);
  });

  it("audits high-rank and same-day candidate coverage without rewriting non-empty content", () => {
    const coverage = buildDailyReportCandidateCoverage({
      blocks: [
        { type: "section", title: "今日大事", items: [{ title: "低排名内容", body: "内容", sourceIds: [2] }] },
      ],
    }, [
      { ...candidates[0], id: 1, candidateScore: 95, newItemCountOnDate: 1, newSourceCountOnDate: 1 },
      { ...candidates[1], id: 2, candidateScore: 40, newItemCountOnDate: 0, newSourceCountOnDate: 0 },
    ]);

    expect(coverage).toMatchObject({
      candidateCount: 2,
      selectedCount: 1,
      topRankPoolCount: 1,
      selectedTopRankCount: 0,
      sameDayCandidateCount: 1,
      selectedSameDayCount: 0,
      lowRankSelectedCount: 1,
      warnings: [
        "selected_candidates_only_low_rank",
        "selected_candidates_miss_same_day_updates",
      ],
    });
  });
});

describe("daily report block rendering and legacy normalization", () => {
  it("renders custom text and section blocks", () => {
    const customContent: DailyReportContent = {
      blocks: [
        {
          type: "text",
          title: "今日速览",
          body: "本期覆盖模型发布、产业合作与开源工具三条主线，附带工程实践与生态影响评估。",
        },
        {
          type: "section",
          title: "模型动态",
          items: [
            {
              title: "新模型发布",
              body: "模型能力继续上探，对工程实践与下游选型都有影响。",
              notes: [{ label: "价值", text: "成本和稳定性需要重新评估。" }],
              sourceIds: [1],
            },
          ],
        },
        {
          type: "text",
          title: "编辑视角",
          body: "整体来看主线还是收敛在模型能力和工程工具上，后续需要持续观察实际落地情况。",
        },
      ],
    };

    const markdown = renderDailyReportMarkdown(customContent, candidates, "2026-04-24 AI 日报");

    expect(markdown).toContain("## 今日速览");
    expect(markdown).toContain("## 模型动态");
    expect(markdown).toContain("### 新模型发布");
    expect(markdown).toContain("模型能力继续上探，对工程实践与下游选型都有影响。");
    expect(markdown).toContain("**价值：**");
    expect(markdown).toContain("## 编辑视角");
  });

  it("normalizes legacy persisted content into blocks", () => {
    const normalized = normalizeDailyReportContent({
      headline: "04-24日报 | OpenAI 发布新模型、开发者工具更新、",
      openingLabel: "今日速览",
      openingSummary: "本期覆盖模型发布、产业合作与开源工具三条主线，附带工程实践与生态影响评估。",
      sections: {
        模型动态: [
          {
            topic: "新模型发布",
            summary: "模型能力继续上探，对工程实践与下游选型都有影响。",
            impact: "成本和稳定性需要重新评估。",
            sourceIds: [1],
          },
        ],
        安全与风险: [
          {
            topic: "AI 安全事件",
            affected: "使用相关模型的普通用户和企业团队",
            action: "关注官方修复说明并避免上传敏感数据",
            sourceIds: [1],
          },
        ],
      },
      closingLabel: "编辑视角",
      closingThought: "整体来看主线还是收敛在模型能力和工程工具上，后续需要持续观察实际落地情况。",
    });

    expect(normalized.headline).toBe("OpenAI 发布新模型、开发者工具更新");
    expect(normalized.blocks[0]).toMatchObject({ type: "text", title: "今日速览" });
    expect(normalized.blocks[1]).toMatchObject({
      type: "section",
      title: "模型动态",
      items: [
        {
          title: "新模型发布",
          body: "模型能力继续上探，对工程实践与下游选型都有影响。",
          notes: [{ label: "impact", text: "成本和稳定性需要重新评估。" }],
          sourceIds: [1],
        },
      ],
    });
    expect(normalized.blocks[2]).toMatchObject({
      type: "section",
      title: "安全与风险",
      items: [
        {
          title: "AI 安全事件",
          notes: [
            { label: "影响", text: "使用相关模型的普通用户和企业团队" },
            { label: "建议", text: "关注官方修复说明并避免上传敏感数据" },
          ],
          sourceIds: [1],
        },
      ],
    });
    expect(normalized.blocks[3]).toMatchObject({ type: "text", title: "编辑视角" });
  });

  it("keeps custom blocks in detail and export markdown", () => {
    const customContent: DailyReportContent = {
      blocks: [
        {
          type: "text",
          title: "今日速览",
          body: "本期覆盖模型发布、产业合作与开源工具三条主线，附带工程实践与生态影响评估。",
        },
        {
          type: "section",
          title: "模型动态",
          items: [{ title: "新模型发布", body: "模型能力继续上探。", sourceIds: [1] }],
        },
        {
          type: "text",
          title: "编辑视角",
          body: "整体来看主线还是收敛在模型能力和工程工具上，后续需要持续观察实际落地情况。",
        },
      ],
    };
    const renderedMarkdown = renderDailyReportMarkdown(customContent, candidates, "2026-04-24 AI 日报");
    const report: DailyReportDetailDTO = {
      id: "report-1",
      date: "2026-04-24",
      timezone: "Asia/Shanghai",
      status: "published",
      title: "2026-04-24 AI 日报",
      openingSummary: "本期覆盖模型发布、产业合作与开源工具三条主线，附带工程实践与生态影响评估。",
      sourceCount: 1,
      generatedAt: "2026-04-24T00:00:00.000Z",
      publishedAt: "2026-04-24T01:00:00.000Z",
      errorMessage: null,
      closingThought: "整体来看主线还是收敛在模型能力和工程工具上，后续需要持续观察实际落地情况。",
      content: customContent,
      renderedMarkdown,
      sources: [],
      previous: null,
      next: null,
    };

    const detailMarkdown = buildDailyReportDetailMarkdown(report);
    const exportMarkdown = buildDailyReportExportMarkdown(report);

    expect(detailMarkdown).toContain("## 今日速览");
    expect(detailMarkdown).toContain("## 编辑视角");
    expect(exportMarkdown).toContain("# 2026-04-24 AI 日报");
    expect(exportMarkdown).toContain("## 今日速览");
    expect(exportMarkdown).toContain("## 编辑视角");
  });

  it("preserves standardized note labels when normalizing saved markdown", () => {
    const report: DailyReportDetailDTO = {
      id: "report-1",
      date: "2026-04-24",
      timezone: "Asia/Shanghai",
      status: "published",
      title: "2026-04-24 AI 日报",
      openingSummary: "本期覆盖安全风险。",
      sourceCount: 0,
      generatedAt: "2026-04-24T00:00:00.000Z",
      publishedAt: "2026-04-24T01:00:00.000Z",
      errorMessage: null,
      closingThought: "继续观察。",
      content: {
        blocks: [
          { type: "text", title: "摘要", body: "本期覆盖安全风险。" },
          {
            type: "section",
            title: "安全与风险",
            items: [
              {
                title: "风险事件",
                body: "风险正文。",
                notes: [
                  { label: "影响", text: "影响对象。" },
                  { label: "建议", text: "建议动作。" },
                ],
                sourceIds: [],
              },
            ],
          },
        ],
      },
      renderedMarkdown: [
        "# 2026-04-24 AI 日报",
        "",
        "## 摘要",
        "",
        "摘要：本期覆盖安全风险。",
        "",
        "## 安全与风险",
        "",
        "### 风险事件",
        "风险正文。",
        "",
        "**影响：** 影响对象。",
        "",
        "**建议：** 建议动作。",
      ].join("\n"),
      sources: [],
      previous: null,
      next: null,
    };

    const detailMarkdown = buildDailyReportDetailMarkdown(report);

    expect(detailMarkdown).toContain("本期覆盖安全风险。");
    expect(detailMarkdown).toContain("**影响：** 影响对象。");
    expect(detailMarkdown).toContain("**建议：** 建议动作。");
    expect(detailMarkdown).not.toContain("摘要：本期覆盖安全风险。");
  });
});
