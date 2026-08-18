import { describe, expect, it } from "vitest";

import {
  compileDailyReportTemplatePrompt,
  DEFAULT_DAILY_REPORT_TEMPLATE,
  DEFAULT_DAILY_REPORT_TEMPLATE_JSON,
  classifyDailyReportTemplateMigration,
  getLegacyDefaultDailyReportSystemPrompt,
  getDailyReportTemplateSignature,
  parseDailyReportTemplateJson,
  upgradeDefaultDailyReportTemplate,
} from "@/lib/daily-report/template";

describe("daily report template config", () => {
  it("compiles the default structured template into the system prompt", () => {
    const prompt = compileDailyReportTemplatePrompt(DEFAULT_DAILY_REPORT_TEMPLATE);

    expect(prompt).toContain('"blocks"');
    expect(prompt).toContain('"headline":"GPT-5.6 有限预览、Mythos 5 白名单恢复"');
    expect(prompt).toContain('"type":"text"');
    expect(prompt).toContain('"title":"摘要"');
    expect(prompt).toContain('"title":"其他值得看"');
    expect(prompt).toContain("正文非空校验：关闭；body 字段可为空");
    expect(prompt).not.toContain('"role"');
    expect(prompt).toContain("section block「热点事件」：条目数非空校验：开启；条目数量：3 至 5 条");
    expect(prompt).toContain("section block「安全与风险」：条目数非空校验：关闭；条目数量：0 至 5 条");
    expect(prompt).toContain("section block「开源与工具」：条目数非空校验：关闭；条目数量：0 至 5 条");
    expect(prompt).toContain("section block「数据与洞察」：条目数非空校验：关闭；条目数量：0 至 5 条");
    expect(prompt).not.toContain("输出 3-5 条");
    expect(prompt).toContain("items 为空数组时会在渲染时自动隐藏");
    expect(prompt).toContain("headline 字段：基于最终输出的“热点事件”栏目全部条目生成标题主题");
    expect(prompt).toContain("历史主题去重规则：");
    expect(prompt).toContain("如果候选内容与历史主题召回窗口内已写主题只是同一事件的重复报道");
    expect(prompt).toContain("每条正文约 120-260 字");
    expect(prompt).toContain("每条正文约 80-180 字");
    expect(prompt).toContain("每个 item 必须包含 title，建议包含 body");
    expect(prompt).not.toContain("sourceIds");
    expect(prompt).toContain("body 为空字符串或缺失时会按紧凑模式只展示标题");
    expect(prompt).toContain("notes 要求：重点 必填");
    expect(prompt).toContain("只保留独立且有明确事实增量");
    expect(prompt).not.toContain("可根据管理员习惯调整");
    expect(prompt).not.toContain("openingLabel");
  });

  it("uses block and note config when compiling", () => {
    const template = parseDailyReportTemplateJson(DEFAULT_DAILY_REPORT_TEMPLATE_JSON)!;
    template.headlineInstruction = "写一个适合公众号传播的短标题主题。";
    template.recentTopicRules = ["重复事件不再写入。"];
    template.blocks = [
      {
        type: "text",
        title: "今日速览",
        bodyInstruction: "总结主线。",
      },
      {
        type: "section",
        title: "产业信号",
        description: "聚焦产业变化。",
        item: {
          bodyInstruction: "说明变化信号。",
          notes: [
            {
              label: "信号",
              required: true,
              instruction: "说明为什么重要。",
            },
          ],
        },
      },
    ];

    const prompt = compileDailyReportTemplatePrompt(template);

    expect(prompt).toContain('"title":"产业信号","items":[{"title":"...","body":"...","notes":[{"label":"信号","text":"..."}]}]');
    expect(prompt).toContain("headline 字段：写一个适合公众号传播的短标题主题。");
    expect(prompt).toContain("section block「产业信号」：条目数非空校验：关闭；条目数量：0 至 不限 条；栏目要求：聚焦产业变化。");
    expect(prompt).toContain("items 为空数组时会在渲染时自动隐藏");
    expect(prompt).toContain("信号 必填：说明为什么重要。");
    expect(prompt).toContain("1. 重复事件不再写入。");
  });

  it("removes legacy model-owned source mapping rules from normalized templates", () => {
    const template = parseDailyReportTemplateJson(JSON.stringify({
      ...DEFAULT_DAILY_REPORT_TEMPLATE,
      globalRules: [
        "只使用输入候选内容。",
        "每个 section item 的 sourceIds 必须至少包含 1 个合法候选编号。",
        "保留这条编辑规则。",
      ],
    }))!;

    expect(template.globalRules).toEqual(["只使用输入候选内容。", "保留这条编辑规则。"]);
  });

  it("backfills headline and recent topic rules for older blocks template json", () => {
    const oldTemplate = {
      blocks: DEFAULT_DAILY_REPORT_TEMPLATE.blocks,
      globalRules: DEFAULT_DAILY_REPORT_TEMPLATE.globalRules,
    };

    const template = parseDailyReportTemplateJson(JSON.stringify(oldTemplate))!;

    expect(template.headlineInstruction).toContain("MM-DD日报");
    expect(template.recentTopicRules[0]).toContain("历史主题召回窗口");
  });

  it("updates wording for an untouched official default template only", () => {
    const template = parseDailyReportTemplateJson(DEFAULT_DAILY_REPORT_TEMPLATE_JSON)!;
    const legacyDescriptions = [
      "输出 3-5 条。优先综合参考 candidateScore、sourceCount、itemCount 和日期相关性；在新闻价值接近时优先选择更热、多源确认、eventDate 明确等于日报日期，或能从 publishedAt/正文判断发生于日报日期的事项。不要机械按日期或热度排序。",
      "输出 2-5 条。聚焦产品、模型、工程实践和生态变化。每条只覆盖一个独立事件或实践变化；不要为了压缩篇幅把无关更新并列到同一条。",
      "可为空；有相关内容时输出 1-5 条。聚焦安全事件、漏洞、滥用风险、合规风险或模型行为风险；不要输出 severity、riskLevel、风险级别等风险等级字段。",
      "可为空；有相关内容时输出 1-5 条。聚焦值得开发者关注的开源项目、工具链、框架或工程资产。",
      "可为空；有相关内容时输出 1-5 条。聚焦关键数据、趋势、研究结论或生态变化信号。",
    ];
    let sectionIndex = 0;
    template.blocks = template.blocks.map((block) => {
      if (block.type !== "section") return block;
      return { ...block, description: legacyDescriptions[sectionIndex++]! };
    });

    const upgraded = upgradeDefaultDailyReportTemplate(template);
    expect(upgraded).toEqual(DEFAULT_DAILY_REPORT_TEMPLATE);

    template.headlineInstruction = "管理员自定义标题规则。";
    expect(upgradeDefaultDailyReportTemplate(template).headlineInstruction).toBe("管理员自定义标题规则。");
  });

  it("updates the previous default global rule without changing custom templates", () => {
    const previousDefault = parseDailyReportTemplateJson(JSON.stringify({
      ...DEFAULT_DAILY_REPORT_TEMPLATE,
      globalRules: [
        ...DEFAULT_DAILY_REPORT_TEMPLATE.globalRules.slice(0, 3),
        "同一事件只出现一次，避免跨栏目重复。",
        ...DEFAULT_DAILY_REPORT_TEMPLATE.globalRules.slice(4),
      ],
    }))!;

    expect(upgradeDefaultDailyReportTemplate(previousDefault)).toEqual(DEFAULT_DAILY_REPORT_TEMPLATE);
    expect(upgradeDefaultDailyReportTemplate({
      ...previousDefault,
      globalRules: ["管理员自定义规则。"],
    }).globalRules).toEqual(["管理员自定义规则。"]);
  });

  it("updates the previously seeded v2 default with generated section keys", () => {
    const template = parseDailyReportTemplateJson(JSON.stringify({
      ...DEFAULT_DAILY_REPORT_TEMPLATE,
      headlineInstruction:
        "基于最终输出的“热点事件”栏目全部条目生成标题主题，在 64 字限制内尽量覆盖每个热点事件的核心主体或动作；主题数量不固定，不强行凑数，也不要从其他栏目或趋势观察中提炼抽象主题；用“、”分隔；不要包含日期、年份、日报、AI 日报、Markdown、引号或尾随标点；会与“MM-DD日报 | ”前缀合成最终标题。",
      recentTopicRules: [
        "如果候选内容与最近 7 天已写主题只是同一事件的重复报道，不要再次写入。",
        ...DEFAULT_DAILY_REPORT_TEMPLATE.recentTopicRules.slice(1),
      ],
      blocks: DEFAULT_DAILY_REPORT_TEMPLATE.blocks
        .filter((block) => !(block.type === "section" && block.title === "其他值得看"))
        .concat({
          type: "text",
          title: "趋势观察",
          bodyInstruction:
            "约 80-140 字。不要复述摘要或逐条回顾事件；从本期信息中提炼 1 条后续趋势、潜在影响或需要继续观察的判断，说明它可能如何影响普通用户、开发者、内容创作者、企业采购或日常工作流。只基于输入信息给出谨慎判断，不引入输入之外的新事实。可使用有限 Markdown 行内标记突出关键信息。",
        })
        .map((block) => {
          if (block.type !== "section") return block;
          const legacyDescriptions: Record<string, string> = {
            "热点事件": "输出 3-5 条。优先综合参考 candidateScore、sourceCount、itemCount 和日期相关性；在新闻价值接近时优先选择更热、多源确认、eventDate 明确等于日报日期，或能从 publishedAt/正文判断发生于日报日期的事项。不要机械按日期或热度排序。",
            "变更与实践": "输出 2-5 条。聚焦产品、模型、工程实践和生态变化。每条只覆盖一个独立事件或实践变化；不要为了压缩篇幅把无关更新并列到同一条。",
            "安全与风险": "可为空；有相关内容时输出 1-5 条。聚焦安全事件、漏洞、滥用风险、合规风险或模型行为风险；不要输出 severity、riskLevel、风险级别等风险等级字段。",
            "开源与工具": "可为空；有相关内容时输出 1-5 条。聚焦值得开发者关注的开源项目、工具链、框架或工程资产。",
            "数据与洞察": "可为空；有相关内容时输出 1-5 条。聚焦关键数据、趋势、研究结论或生态变化信号。",
          };
          const legacyKeys: Record<string, string> = {
            "热点事件": "section-1e08e0da",
            "变更与实践": "section-424b7c3c",
            "安全与风险": "section-8d33ad5b",
            "开源与工具": "section-ec386769",
            "数据与洞察": "section-3a8fd4ec",
          };
          return {
            ...block,
            key: legacyKeys[block.title],
            description: legacyDescriptions[block.title],
          };
        }),
    }))!;

    expect(upgradeDefaultDailyReportTemplate(template)).toEqual(DEFAULT_DAILY_REPORT_TEMPLATE);
  });

  it("keeps optional section body instructions empty when cleared", () => {
    const template = parseDailyReportTemplateJson(JSON.stringify({
      ...DEFAULT_DAILY_REPORT_TEMPLATE,
      blocks: DEFAULT_DAILY_REPORT_TEMPLATE.blocks.map((block) =>
        block.type === "section" && block.title === "其他值得看"
          ? { ...block, item: { ...block.item, bodyInstruction: "   ", bodyRequired: false } }
          : block,
      ),
    }))!;

    expect(template.blocks.at(-1)).toMatchObject({
      type: "section",
      title: "其他值得看",
      item: { bodyInstruction: "", bodyRequired: false },
    });
  });

  it("removes the old default explanation from optional section bodies", () => {
    const template = parseDailyReportTemplateJson(JSON.stringify({
      ...DEFAULT_DAILY_REPORT_TEMPLATE,
      blocks: DEFAULT_DAILY_REPORT_TEMPLATE.blocks.map((block) =>
        block.type === "section" && block.title === "其他值得看"
          ? {
              ...block,
              item: {
                ...block.item,
                bodyInstruction: "不要求输出正文，仅保留条目标题和来源；如确有必要可补充简短说明。",
              },
            }
          : block,
      ),
    }))!;

    expect(upgradeDefaultDailyReportTemplate(template)).toEqual(DEFAULT_DAILY_REPORT_TEMPLATE);
  });

  it("always compiles empty sections as hidden by render default", () => {
    const template = parseDailyReportTemplateJson(DEFAULT_DAILY_REPORT_TEMPLATE_JSON)!;
    template.blocks = [
      {
        type: "section",
        title: "安全与风险",
        description: "没有风险也保留栏目。",
        item: {
          bodyInstruction: "说明风险内容。",
          notes: [],
        },
      },
    ];

    const prompt = compileDailyReportTemplatePrompt(template);

    expect(prompt).toContain('"title":"安全与风险","items"');
    expect(prompt).not.toContain("renderWhenEmpty");
    expect(prompt).toContain("items 为空数组时会在渲染时自动隐藏");
  });

  it("rejects legacy opening/sections/closing template json", () => {
    expect(() => parseDailyReportTemplateJson(JSON.stringify({
      opening: { label: "开场", instruction: "写开场。" },
      sections: [
        {
          title: "核心动态",
          description: "写核心动态。",
          fields: [
            { key: "summary", required: true, instruction: "写正文。" },
            { key: "whyImportant", label: "重点", required: true, instruction: "写重点。" },
          ],
        },
      ],
      closing: { label: "收束", instruction: "写收束。" },
      globalRules: ["只基于输入来源。"],
    }))).toThrow("blocks 数组");
  });

  it("rejects invalid block config", () => {
    const template = parseDailyReportTemplateJson(DEFAULT_DAILY_REPORT_TEMPLATE_JSON)!;
    template.blocks[0] = {
      type: "section",
      title: "坏栏目",
      description: "",
      item: {
        bodyInstruction: "",
        notes: [],
      },
    };

    expect(() => parseDailyReportTemplateJson(JSON.stringify(template))).toThrow("栏目要求");
  });

  it("normalizes legacy blocks to schema v2 with generated section keys and limits", () => {
    const template = parseDailyReportTemplateJson(JSON.stringify({
      blocks: [
        {
          type: "section",
          title: "自定义栏目",
          description: "输出可选内容。",
          item: { bodyInstruction: "说明内容。", notes: [] },
        },
      ],
      globalRules: ["只基于输入来源。"],
    }))!;

    expect(template.schemaVersion).toBe(2);
    expect(template.blocks[0]).toMatchObject({
      type: "section",
      key: expect.stringMatching(/^section-[0-9a-f]{8}$/),
      required: false,
      minItems: 0,
      maxItems: null,
    });
    expect(getDailyReportTemplateSignature(template)).toBe(getDailyReportTemplateSignature(template));
  });

  it("classifies official legacy templates for silent migration but keeps custom legacy templates gated", () => {
    const officialLegacyTemplate = {
      opening: { label: "摘要", instruction: "约 100-180 字。概括当天 AI 领域最关键的事项和主线变化，优先覆盖重大发布、模型/产品进展、产业合作、安全风险、开源工具或关键数据。格式固定为“{{date}} AI 领域呈现...，值得关注的信息：...”，例如：“2026-04-29 AI 领域呈现多线并进格局，值得关注的信息：...”。可使用有限 Markdown 行内标记突出关键信息：用 **加粗** 标注事件主体、关键变化、数字或结论，用 *斜体* 标注必要背景或不确定性；不要使用链接、图片、标题、表格或列表。" },
      sections: [
        { title: "今日大事", description: "输出 3-5 条。优先综合参考 candidateScore、sourceCount、itemCount 和日期相关性；在新闻价值接近时优先选择更热、多源确认、eventDate 明确等于日报日期，或能从 publishedAt/正文判断发生于日报日期的事项。不要机械按日期或热度排序。" },
        { title: "热点事件", description: "输出 3-5 条。优先综合参考 candidateScore、sourceCount、itemCount 和日期相关性；在新闻价值接近时优先选择更热、多源确认、eventDate 明确等于日报日期，或能从 publishedAt/正文判断发生于日报日期的事项。不要机械按日期或热度排序。" },
        { title: "变更与实践", description: "输出 2-5 条。聚焦产品、模型、工程实践和生态变化。每条只覆盖一个独立事件或实践变化；不要为了压缩篇幅把无关更新并列到同一条。" },
        { title: "安全与风险", description: "可为空；有相关内容时输出 1-5 条。聚焦安全事件、漏洞、滥用风险、合规风险或模型行为风险；不要输出 severity、riskLevel、风险级别等风险等级字段。" },
        { title: "开源与工具", description: "可为空；有相关内容时输出 1-5 条。聚焦值得开发者关注的开源项目、工具链、框架或工程资产。" },
        { title: "数据与洞察", description: "可为空；有相关内容时输出 1-5 条。聚焦关键数据、趋势、研究结论或生态变化信号。" },
      ],
      closing: { label: "今日观察", instruction: "约 80-140 字。总结当天值得持续关注的主线，说明这些变化可能如何影响普通用户、开发者、内容创作者、企业采购或日常工作流；可基于当天信息给出谨慎判断，但不要引入输入之外的新事实。可使用有限 Markdown 行内标记突出关键信息。" },
    };
    expect(classifyDailyReportTemplateMigration(officialLegacyTemplate)).toBe("official_default_legacy");
    expect(classifyDailyReportTemplateMigration(officialLegacyTemplate, "管理员改过的系统提示词")).toBe("custom_legacy_requires_migration");
    expect(classifyDailyReportTemplateMigration(officialLegacyTemplate, getLegacyDefaultDailyReportSystemPrompt())).toBe("official_default_legacy");
    expect(classifyDailyReportTemplateMigration({
      opening: { label: "摘要", instruction: "约 100-180 字。概括当天 AI 领域最关键的事项和主线变化，优先覆盖重大发布、模型/产品进展、产业合作、安全风险、开源工具或关键数据。格式固定为“{{date}} AI 领域呈现...，值得关注的信息：...”，例如：“2026-04-29 AI 领域呈现多线并进格局，值得关注的信息：...”。可使用有限 Markdown 行内标记突出关键信息：用 **加粗** 标注事件主体、关键变化、数字或结论，用 *斜体* 标注必要背景或不确定性；不要使用链接、图片、标题、表格或列表。" },
      sections: [
        { title: "今日大事", description: "管理员自定义的栏目要求。" },
        { title: "热点事件", description: "输出 3-5 条。优先综合参考 candidateScore、sourceCount、itemCount 和日期相关性；在新闻价值接近时优先选择更热、多源确认、eventDate 明确等于日报日期，或能从 publishedAt/正文判断发生于日报日期的事项。不要机械按日期或热度排序。" },
        { title: "变更与实践", description: "输出 2-5 条。聚焦产品、模型、工程实践和生态变化。每条只覆盖一个独立事件或实践变化；不要为了压缩篇幅把无关更新并列到同一条。" },
        { title: "安全与风险", description: "可为空；有相关内容时输出 1-5 条。聚焦安全事件、漏洞、滥用风险、合规风险或模型行为风险；不要输出 severity、riskLevel、风险级别等风险等级字段。" },
        { title: "开源与工具", description: "可为空；有相关内容时输出 1-5 条。聚焦值得开发者关注的开源项目、工具链、框架或工程资产。" },
        { title: "数据与洞察", description: "可为空；有相关内容时输出 1-5 条。聚焦关键数据、趋势、研究结论或生态变化信号。" },
      ],
      closing: { label: "今日观察", instruction: "约 80-140 字。总结当天值得持续关注的主线，说明这些变化可能如何影响普通用户、开发者、内容创作者、企业采购或日常工作流；可基于当天信息给出谨慎判断，但不要引入输入之外的新事实。可使用有限 Markdown 行内标记突出关键信息。" },
    })).toBe("custom_legacy_requires_migration");
    expect(classifyDailyReportTemplateMigration({
      opening: { label: "自定义开场", instruction: "旧开场。" },
      sections: [{ title: "核心动态", description: "旧栏目。" }],
      closing: { label: "自定义收尾", instruction: "旧收尾。" },
    })).toBe("custom_legacy_requires_migration");
  });
});
