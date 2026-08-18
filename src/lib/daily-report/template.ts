import { createHash } from "node:crypto";

export type DailyReportTemplateNote = {
  label: string;
  required: boolean;
  instruction: string;
};

export type DailyReportTemplateTextBlock = {
  type: "text";
  title: string;
  bodyInstruction: string;
};

export type DailyReportTemplateSectionBlock = {
  type: "section";
  /** Backend-owned stable identity. Admin does not edit this field. */
  key?: string;
  title: string;
  description: string;
  required?: boolean;
  minItems?: number;
  maxItems?: number | null;
  item: {
    bodyInstruction: string;
    bodyRequired?: boolean;
    notes: DailyReportTemplateNote[];
  };
};

export type DailyReportTemplateBlock = DailyReportTemplateTextBlock | DailyReportTemplateSectionBlock;

export type DailyReportTemplateConfig = {
  schemaVersion?: 2;
  headlineInstruction: string;
  recentTopicRules: string[];
  blocks: DailyReportTemplateBlock[];
  globalRules: string[];
};

export type NormalizedDailyReportTemplate = DailyReportTemplateConfig & { schemaVersion: 2 };

export const DAILY_REPORT_TEMPLATE_SCHEMA_VERSION = 2 as const;

export const DAILY_REPORT_SYSTEM_ROLE_PROMPT =
  "你是中文 AI 新闻日报编辑。请只基于输入候选内容生成一份 Briefing 型 AI 日报。最终响应必须是单个合法 JSON 对象；不要输出代码块、Markdown 文档、前后说明或任何 JSON 之外的文本。JSON 字段内仅在模板规则允许时使用有限行内 Markdown。";

export const DEFAULT_DAILY_REPORT_HEADLINE_INSTRUCTION =
  "基于最终输出的“热点事件”栏目全部条目生成标题主题，在 64 字限制内尽量覆盖每个热点事件的核心主体或动作；主题数量不固定，不强行凑数，也不要从其他栏目或其他值得看中提炼抽象主题；用“、”分隔；不要包含日期、年份、日报、AI 日报、Markdown、引号或尾随标点；会与“MM-DD日报 | ”前缀合成最终标题。";

export const DEFAULT_DAILY_REPORT_RECENT_TOPIC_RULES = [
  "如果候选内容与历史主题召回窗口内已写主题只是同一事件的重复报道，不要再次写入。",
  "如果确有新动作、新数据、新影响或状态变化，可以写入，但必须写成后续进展，避免重复介绍背景。",
  "不要因为同一公司、同一模型或同一抽象主题相似就机械过滤；判断重点是是否有新的事实增量。",
];

export const DEFAULT_DAILY_REPORT_TEMPLATE: DailyReportTemplateConfig = {
  schemaVersion: DAILY_REPORT_TEMPLATE_SCHEMA_VERSION,
  headlineInstruction: DEFAULT_DAILY_REPORT_HEADLINE_INSTRUCTION,
  recentTopicRules: DEFAULT_DAILY_REPORT_RECENT_TOPIC_RULES,
  blocks: [
    {
      type: "text",
      title: "摘要",
      bodyInstruction:
        "约 100-180 字。概括本期 AI 领域最关键的事项和主线变化，优先覆盖重大发布、模型/产品进展、产业合作、安全风险、开源工具或关键数据。格式固定为“{{date}} AI 领域呈现...，值得关注的信息：...”，例如：“2026-04-29 AI 领域呈现多线并进格局，值得关注的信息：...”。可使用有限 Markdown 行内标记突出关键信息：用 **加粗** 标注事件主体、关键变化、数字或结论，用 *斜体* 标注必要背景或不确定性；不要使用链接、图片、标题、表格或列表。",
    },
    {
      type: "section",
      key: "hot-topics",
      title: "热点事件",
      description:
        "优先综合参考 candidateScore、sourceCount、itemCount 和日期相关性；在新闻价值接近时优先选择更热、多源确认、eventDate 明确等于日报日期，或能从 publishedAt/正文判断发生于日报日期的事项。不要机械按日期或热度排序。",
      required: true,
      minItems: 3,
      maxItems: 5,
      item: {
        bodyInstruction:
          "每条正文约 120-260 字。覆盖事件主体、动作、结果、背景与影响；可使用有限 Markdown 行内标记：**加粗** 用于主体、关键结果、数字或建议，*斜体* 用于背景或不确定性。",
        bodyRequired: true,
        notes: [
          {
            label: "重点",
            required: true,
            instruction: "不超过 30 字，说明为什么值得关注。",
          },
        ],
      },
    },
    {
      type: "section",
      key: "changes-practice",
      title: "变更与实践",
      description: "聚焦产品、模型、工程实践和生态变化。每条只覆盖一个独立事件或实践变化；不要为了压缩篇幅把无关更新并列到同一条。",
      required: true,
      minItems: 2,
      maxItems: 5,
      item: {
        bodyInstruction: "每条正文约 80-180 字。说明变化内容、适用对象、实践价值或可能影响。",
        bodyRequired: true,
        notes: [],
      },
    },
    {
      type: "section",
      key: "security-risk",
      title: "安全与风险",
      description: "聚焦安全事件、漏洞、滥用风险、合规风险或模型行为风险；不要输出 severity、riskLevel、风险级别等风险等级字段。",
      required: false,
      minItems: 0,
      maxItems: 5,
      item: {
        bodyInstruction: "每条正文约 80-180 字。说明风险事件主体、背景和影响范围。",
        bodyRequired: true,
        notes: [
          { label: "影响", required: true, instruction: "说明受影响对象。" },
          { label: "建议", required: true, instruction: "说明建议动作。" },
        ],
      },
    },
    {
      type: "section",
      key: "open-source-tools",
      title: "开源与工具",
      description: "聚焦值得开发者关注的开源项目、工具链、框架或工程资产。",
      required: false,
      minItems: 0,
      maxItems: 5,
      item: {
        bodyInstruction: "每条正文约 80-180 字。概括工具或项目的核心变化。",
        bodyRequired: true,
        notes: [
          { label: "适用场景", required: true, instruction: "说明为什么值得关注或适用场景。" },
        ],
      },
    },
    {
      type: "section",
      key: "data-insights",
      title: "数据与洞察",
      description: "聚焦关键数据、趋势、研究结论或生态变化信号。",
      required: false,
      minItems: 0,
      maxItems: 5,
      item: {
        bodyInstruction: "每条正文约 80-180 字。概括数据、趋势或研究结论。",
        bodyRequired: true,
        notes: [
          { label: "数据", required: true, instruction: "列出关键数字或数据点。" },
          { label: "意义", required: true, instruction: "说明这些数据代表的趋势或意义。" },
        ],
      },
    },
    {
      type: "section",
      key: "other-worth-reading",
      title: "其他值得看",
      description:
        "优先选择未进入前面栏目、但仍值得关注的产品、开源项目、研究、数据、行业动态或实践信息。只保留独立且有明确事实增量的内容，不要重复已选主题或为了凑数填充。",
      required: false,
      minItems: 0,
      maxItems: 10,
      item: {
        bodyInstruction: "",
        bodyRequired: false,
        notes: [],
      },
    },
  ],
  globalRules: [
    "每个条目只描述一个独立事件、产品、漏洞、模型、政策或研究成果；不同主体、不同产品或不同事件不要合并成一条。",
    "多个来源只能用于同一事件的互证；如果只是主题相近但事实不同，应拆成不同条目或只保留最相关来源。",
    "只使用输入候选内容，不编造事实或输入之外的信息。",
    "每个输入主题生成且仅生成一个条目；不得合并、删除或新增主题，不得调整主题所属栏目。",
    "正文只写内容本身，不要带栏目名、字段名或标签前缀。",
    "除模板允许的加粗和斜体外，不要输出链接、图片、标题、表格、列表或其他 Markdown 结构。",
  ],
};

function cloneDefaultTemplate() {
  return JSON.parse(JSON.stringify(DEFAULT_DAILY_REPORT_TEMPLATE)) as NormalizedDailyReportTemplate;
}

const LEGACY_DEFAULT_SECTION_DESCRIPTIONS: Record<string, string> = {
  "今日大事":
    "输出 3-5 条。优先综合参考 candidateScore、sourceCount、itemCount 和日期相关性；在新闻价值接近时优先选择更热、多源确认、eventDate 明确等于日报日期，或能从 publishedAt/正文判断发生于日报日期的事项。不要机械按日期或热度排序。",
  "热点事件":
    "输出 3-5 条。优先综合参考 candidateScore、sourceCount、itemCount 和日期相关性；在新闻价值接近时优先选择更热、多源确认、eventDate 明确等于日报日期，或能从 publishedAt/正文判断发生于日报日期的事项。不要机械按日期或热度排序。",
  "变更与实践": "输出 2-5 条。聚焦产品、模型、工程实践和生态变化。每条只覆盖一个独立事件或实践变化；不要为了压缩篇幅把无关更新并列到同一条。",
  "安全与风险": "可为空；有相关内容时输出 1-5 条。聚焦安全事件、漏洞、滥用风险、合规风险或模型行为风险；不要输出 severity、riskLevel、风险级别等风险等级字段。",
  "开源与工具": "可为空；有相关内容时输出 1-5 条。聚焦值得开发者关注的开源项目、工具链、框架或工程资产。",
  "数据与洞察": "可为空；有相关内容时输出 1-5 条。聚焦关键数据、趋势、研究结论或生态变化信号。",
};

const LEGACY_DEFAULT_OPENING_INSTRUCTION =
  "约 100-180 字。概括当天 AI 领域最关键的事项和主线变化，优先覆盖重大发布、模型/产品进展、产业合作、安全风险、开源工具或关键数据。格式固定为“{{date}} AI 领域呈现...，值得关注的信息：...”，例如：“2026-04-29 AI 领域呈现多线并进格局，值得关注的信息：...”。可使用有限 Markdown 行内标记突出关键信息：用 **加粗** 标注事件主体、关键变化、数字或结论，用 *斜体* 标注必要背景或不确定性；不要使用链接、图片、标题、表格或列表。";
const LEGACY_DEFAULT_CLOSING_INSTRUCTION =
  "约 80-140 字。总结当天值得持续关注的主线，说明这些变化可能如何影响普通用户、开发者、内容创作者、企业采购或日常工作流；可基于当天信息给出谨慎判断，但不要引入输入之外的新事实。可使用有限 Markdown 行内标记突出关键信息。";
const PREVIOUS_DEFAULT_HEADLINE_INSTRUCTION =
  "基于最终输出的“热点事件”栏目全部条目生成标题主题，在 64 字限制内尽量覆盖每个热点事件的核心主体或动作；主题数量不固定，不强行凑数，也不要从其他栏目或趋势观察中提炼抽象主题；用“、”分隔；不要包含日期、年份、日报、AI 日报、Markdown、引号或尾随标点；会与“MM-DD日报 | ”前缀合成最终标题。";
const PREVIOUS_DEFAULT_RECENT_TOPIC_RULES = [
  "如果候选内容与最近 7 天已写主题只是同一事件的重复报道，不要再次写入。",
  ...DEFAULT_DAILY_REPORT_RECENT_TOPIC_RULES.slice(1),
];
const PREVIOUS_DEFAULT_GLOBAL_RULES = [
  ...DEFAULT_DAILY_REPORT_TEMPLATE.globalRules.slice(0, 3),
  "同一事件只出现一次，避免跨栏目重复。",
  ...DEFAULT_DAILY_REPORT_TEMPLATE.globalRules.slice(4),
];
const PREVIOUS_INTERMEDIATE_GLOBAL_RULES = [
  ...DEFAULT_DAILY_REPORT_TEMPLATE.globalRules.slice(0, 3),
  "严格按输入中的已确定主题逐条写作；不要合并、删除、改栏目或新增主题。主题之间的重复关系由上游选题和本地校验处理。",
  ...DEFAULT_DAILY_REPORT_TEMPLATE.globalRules.slice(4),
];

function getLegacyDefaultDailyReportTemplate() {
  const template = cloneDefaultTemplate();
  template.blocks = template.blocks.map((block) => {
    if (block.type !== "section") return block;
    const description = LEGACY_DEFAULT_SECTION_DESCRIPTIONS[block.title];
    return description ? { ...block, description } : block;
  });
  return template;
}

function getPreviousDefaultDailyReportTemplate() {
  const template = cloneDefaultTemplate();
  template.blocks = template.blocks
    .filter((block) => !(block.type === "section" && block.title === "其他值得看"));
  template.blocks.push({
    type: "text",
    title: "趋势观察",
    bodyInstruction:
      "约 80-140 字。不要复述摘要或逐条回顾事件；从本期信息中提炼 1 条后续趋势、潜在影响或需要继续观察的判断，说明它可能如何影响普通用户、开发者、内容创作者、企业采购或日常工作流。只基于输入信息给出谨慎判断，不引入输入之外的新事实。可使用有限 Markdown 行内标记突出关键信息。",
  });
  return template;
}

function getPreviouslySeededV2DefaultDailyReportTemplate() {
  const template = getPreviousDefaultDailyReportTemplate();
  template.headlineInstruction = PREVIOUS_DEFAULT_HEADLINE_INSTRUCTION;
  template.recentTopicRules = PREVIOUS_DEFAULT_RECENT_TOPIC_RULES;
  template.blocks = template.blocks.map((block) => {
    if (block.type !== "section") return block;
    return {
      ...block,
      key: generatedSectionKey(block.title),
      description: LEGACY_DEFAULT_SECTION_DESCRIPTIONS[block.title] ?? block.description,
    };
  });
  return template;
}

function getPreviouslyMigratedV2DefaultDailyReportTemplate() {
  const template = cloneDefaultTemplate();
  const otherWorthReading = template.blocks.find(
    (block) => block.type === "section" && block.title === "其他值得看",
  );
  if (otherWorthReading?.type === "section") {
    otherWorthReading.item.bodyInstruction = "不要求输出正文，仅保留条目标题和来源；如确有必要可补充简短说明。";
  }
  return template;
}

function getPreviouslyMigratedV2DefaultWithPreviousGlobalRules() {
  const template = getPreviouslyMigratedV2DefaultDailyReportTemplate();
  template.globalRules = PREVIOUS_DEFAULT_GLOBAL_RULES;
  return template;
}

function getCurrentShapeDefaultWithPreviousGlobalRules() {
  const template = cloneDefaultTemplate();
  template.globalRules = PREVIOUS_DEFAULT_GLOBAL_RULES;
  return template;
}

function getCurrentShapeDefaultWithPreviousIntermediateRules() {
  const template = cloneDefaultTemplate();
  template.globalRules = PREVIOUS_INTERMEDIATE_GLOBAL_RULES;
  return template;
}

export function getLegacyDefaultDailyReportSystemPrompt() {
  return compileDailyReportTemplatePrompt(getLegacyDefaultDailyReportTemplate());
}

function nonEmptyText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function generatedSectionKey(title: string) {
  return `section-${stableHash(title.trim())}`;
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function normalizeNote(note: Partial<DailyReportTemplateNote>): DailyReportTemplateNote {
  return {
    label: nonEmptyText(note.label, "要点"),
    required: note.required !== false,
    instruction: nonEmptyText(note.instruction, "写清楚该要点内容。"),
  };
}

function isModelOwnedSourceMappingRule(rule: string) {
  return rule.includes("sourceIds") && (
    rule.includes("section item") || rule.includes("合法候选编号") || rule.includes("来源编号")
  );
}

export function normalizeDailyReportTemplateConfig(value: unknown): NormalizedDailyReportTemplate {
  if (!isObject(value)) {
    return cloneDefaultTemplate();
  }

  const input = value as Partial<DailyReportTemplateConfig>;
  const sourceBlocks = Array.isArray(input.blocks) && input.blocks.length > 0
    ? input.blocks
    : cloneDefaultTemplate().blocks;

  return {
    schemaVersion: DAILY_REPORT_TEMPLATE_SCHEMA_VERSION,
    headlineInstruction: nonEmptyText(input.headlineInstruction, DEFAULT_DAILY_REPORT_TEMPLATE.headlineInstruction),
    recentTopicRules:
      Array.isArray(input.recentTopicRules) && input.recentTopicRules.length > 0
        ? input.recentTopicRules.filter((rule): rule is string => typeof rule === "string" && Boolean(rule.trim())).map((rule) => rule.trim())
        : [...DEFAULT_DAILY_REPORT_TEMPLATE.recentTopicRules],
    blocks: sourceBlocks.map((block, index) => {
      const defaultBlock = DEFAULT_DAILY_REPORT_TEMPLATE.blocks[index] ?? DEFAULT_DAILY_REPORT_TEMPLATE.blocks[0];
      if (block.type === "section") {
        const defaultSection = DEFAULT_DAILY_REPORT_TEMPLATE.blocks.find(
          (entry) => entry.type === "section" && entry.title === block.title,
        ) as DailyReportTemplateSectionBlock | undefined;
        const minItems = validPositiveInteger(block.minItems)
          ? block.minItems
          : defaultSection?.minItems ?? 0;
        const maxItems = block.maxItems === null
          ? null
          : validPositiveInteger(block.maxItems)
          ? block.maxItems
          : defaultSection?.maxItems ?? null;
        const fallbackSectionTitle = defaultSection?.title ?? "自定义栏目";
        const bodyRequired = block.item?.bodyRequired !== false;
        return {
          type: "section",
          key: typeof block.key === "string" && block.key.trim() ? block.key.trim() : generatedSectionKey(nonEmptyText(block.title, fallbackSectionTitle)),
          title: nonEmptyText(block.title, fallbackSectionTitle),
          description: nonEmptyText(block.description, defaultSection?.description ?? "输出该栏目内容。"),
          required: typeof block.required === "boolean" ? block.required : defaultSection?.required ?? false,
          minItems,
          maxItems: maxItems == null ? null : Math.max(minItems, maxItems),
          item: {
            bodyInstruction: bodyRequired
              ? nonEmptyText(block.item?.bodyInstruction, defaultSection?.item.bodyInstruction ?? "说明条目内容。")
              : typeof block.item?.bodyInstruction === "string" ? block.item.bodyInstruction.trim() : "",
            bodyRequired,
            notes: Array.isArray(block.item?.notes) ? block.item.notes.map(normalizeNote) : [],
          },
        };
      }
      const defaultText = defaultBlock.type === "text" ? defaultBlock : DEFAULT_DAILY_REPORT_TEMPLATE.blocks[0] as DailyReportTemplateTextBlock;
      return {
        type: "text",
        title: nonEmptyText(block.title, defaultText.title),
        bodyInstruction: nonEmptyText(block.bodyInstruction, defaultText.bodyInstruction),
      };
    }),
    globalRules:
      Array.isArray(input.globalRules) && input.globalRules.length > 0
        ? input.globalRules
          .filter((rule): rule is string => typeof rule === "string" && Boolean(rule.trim()))
          .map((rule) => rule.trim())
          .filter((rule) => !isModelOwnedSourceMappingRule(rule))
        : [...DEFAULT_DAILY_REPORT_TEMPLATE.globalRules],
  };
}

/**
 * Upgrade only the untouched official default template after wording changes.
 * A custom template is returned as-is, even if it uses similar section names.
 */
export function upgradeDefaultDailyReportTemplate(templateInput: DailyReportTemplateConfig) {
  const template = normalizeDailyReportTemplateConfig(templateInput);
  const defaultTemplate = normalizeDailyReportTemplateConfig(DEFAULT_DAILY_REPORT_TEMPLATE);
  const previousDefaultTemplate = getPreviousDefaultDailyReportTemplate();
  const legacyDefaultTemplate = getLegacyDefaultDailyReportTemplate();
  const previouslySeededV2DefaultTemplate = getPreviouslySeededV2DefaultDailyReportTemplate();
  const previouslyMigratedV2DefaultTemplate = getPreviouslyMigratedV2DefaultDailyReportTemplate();
  const previouslyMigratedV2DefaultWithPreviousGlobalRules = getPreviouslyMigratedV2DefaultWithPreviousGlobalRules();
  const currentShapeDefaultWithPreviousGlobalRules = getCurrentShapeDefaultWithPreviousGlobalRules();
  const currentShapeDefaultWithPreviousIntermediateRules = getCurrentShapeDefaultWithPreviousIntermediateRules();
  const isUntouchedDefault = [
    defaultTemplate,
    previousDefaultTemplate,
    legacyDefaultTemplate,
    previouslySeededV2DefaultTemplate,
    previouslyMigratedV2DefaultTemplate,
    previouslyMigratedV2DefaultWithPreviousGlobalRules,
    currentShapeDefaultWithPreviousGlobalRules,
    currentShapeDefaultWithPreviousIntermediateRules,
  ].some(
    (candidate) => JSON.stringify(template) === JSON.stringify(candidate),
  );
  if (!isUntouchedDefault) {
    return template;
  }
  return defaultTemplate;
}

function assertNonEmptyText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}不能为空。`);
  }
}

function withDailyReportTemplateCompatibilityDefaults(template: Record<string, unknown>): Record<string, unknown> {
  return {
    ...template,
    schemaVersion: template.schemaVersion ?? DAILY_REPORT_TEMPLATE_SCHEMA_VERSION,
    headlineInstruction: nonEmptyText(template.headlineInstruction, DEFAULT_DAILY_REPORT_TEMPLATE.headlineInstruction),
    recentTopicRules: Array.isArray(template.recentTopicRules)
      ? template.recentTopicRules
      : [...DEFAULT_DAILY_REPORT_TEMPLATE.recentTopicRules],
  };
}

export function validateDailyReportTemplateConfig(
  templateInput: unknown,
  options: { allowLegacyFields?: boolean } = {},
): DailyReportTemplateConfig {
  const allowLegacyFields = options.allowLegacyFields === true;
  if (!isObject(templateInput)) {
    throw new Error("日报模板配置必须是 JSON 对象。");
  }
  const template = templateInput as DailyReportTemplateConfig;
  if (
    (!allowLegacyFields || template.schemaVersion !== undefined) &&
    template.schemaVersion !== DAILY_REPORT_TEMPLATE_SCHEMA_VERSION
  ) {
    throw new Error(`日报模板 schemaVersion 必须是 ${DAILY_REPORT_TEMPLATE_SCHEMA_VERSION}。`);
  }
  if (!Array.isArray(template.blocks) || template.blocks.length === 0) {
    throw new Error("日报模板至少需要 1 个 block。");
  }
  assertNonEmptyText(template.headlineInstruction, "标题规则");
  if (!Array.isArray(template.recentTopicRules)) {
    throw new Error("历史主题去重规则必须是数组。");
  }
  for (const [index, block] of template.blocks.entries()) {
    const label = `第 ${index + 1} 个 block`;
    if (block.type === "text") {
      assertNonEmptyText(block.title, `${label}标题`);
      assertNonEmptyText(block.bodyInstruction, `${label}正文要求`);
      continue;
    }
    if (block.type === "section") {
      assertNonEmptyText(block.title, `${label}栏目名`);
      assertNonEmptyText(block.description, `${block.title}栏目要求`);
      if ((!allowLegacyFields || block.key !== undefined) && (typeof block.key !== "string" || !block.key.trim())) {
        throw new Error(`${label} key 不能为空。`);
      }
      if ((!allowLegacyFields || block.required !== undefined) && typeof block.required !== "boolean") {
        throw new Error(`${block.title} required 必须是布尔值。`);
      }
      if ((!allowLegacyFields || block.minItems !== undefined) && !validPositiveInteger(block.minItems)) {
        throw new Error(`${block.title} minItems 必须是非负整数。`);
      }
      if ((!allowLegacyFields || block.maxItems !== undefined) && block.maxItems !== null && !validPositiveInteger(block.maxItems)) {
        throw new Error(`${block.title} maxItems 必须是非负整数或 null。`);
      }
      if (validPositiveInteger(block.minItems) && validPositiveInteger(block.maxItems) && block.minItems > block.maxItems) {
        throw new Error(`${block.title} minItems 不能大于 maxItems。`);
      }
      if (block.required === true && validPositiveInteger(block.minItems) && block.minItems < 1) {
        throw new Error(`${block.title} required=true 时 minItems 至少为 1。`);
      }
      if (!isObject(block.item)) throw new Error(`${block.title} 缺少条目配置。`);
      if (block.item.bodyRequired !== undefined && typeof block.item.bodyRequired !== "boolean") {
        throw new Error(`${block.title}.bodyRequired 必须是布尔值。`);
      }
      if (block.item.bodyRequired !== false) {
        assertNonEmptyText(block.item.bodyInstruction, `${block.title}条目正文要求`);
      } else if (typeof block.item.bodyInstruction !== "string") {
        throw new Error(`${block.title}条目正文要求必须是字符串。`);
      }
      if (!Array.isArray(block.item.notes)) throw new Error(`${block.title} 要点配置必须是数组。`);
      for (const note of block.item.notes) {
        assertNonEmptyText(note.label, `${block.title}要点标签`);
        if (typeof note.required !== "boolean") throw new Error(`${block.title}.${note.label} 必填设置必须是布尔值。`);
        assertNonEmptyText(note.instruction, `${block.title}.${note.label} 要求`);
      }
      continue;
    }
    throw new Error(`${label} type 必须是 text 或 section。`);
  }
  const sectionKeys = template.blocks
    .filter((block): block is DailyReportTemplateSectionBlock => block.type === "section")
    .map((block) => block.key)
    .filter((key): key is string => typeof key === "string");
  if ((!allowLegacyFields && new Set(sectionKeys).size !== sectionKeys.length) || new Set(sectionKeys).size !== sectionKeys.length) {
    throw new Error("日报模板 section key 必须唯一。");
  }
  if (!Array.isArray(template.globalRules)) {
    throw new Error("内容全局规则必须是数组。");
  }
  return template;
}

export function parseDailyReportTemplateJson(value: string | null | undefined): NormalizedDailyReportTemplate | null {
  if (!value?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("日报模板 JSON 格式不合法。");
  }
  if (!isObject(parsed) || !Array.isArray((parsed as Partial<DailyReportTemplateConfig>).blocks)) {
    throw new Error("日报模板 JSON 必须包含 blocks 数组。");
  }
  const input = withDailyReportTemplateCompatibilityDefaults(parsed);
  if (input.schemaVersion !== undefined && input.schemaVersion !== DAILY_REPORT_TEMPLATE_SCHEMA_VERSION) {
    throw new Error(`日报模板 schemaVersion 必须是 ${DAILY_REPORT_TEMPLATE_SCHEMA_VERSION}。`);
  }
  validateDailyReportTemplateConfig(input, { allowLegacyFields: true });
  const template = normalizeDailyReportTemplateConfig(input);
  validateDailyReportTemplateConfig(template);
  return template;
}

export type DailyReportTemplateMigrationStatus =
  | "v2"
  | "official_default_legacy"
  | "custom_legacy_requires_migration"
  | "invalid";

function isOfficialLegacyTemplate(value: Record<string, unknown>, systemPrompt?: string | null) {
  const opening = isObject(value.opening) ? value.opening : null;
  const closing = isObject(value.closing) ? value.closing : null;
  const sections = Array.isArray(value.sections) ? value.sections : [];
  const openingLabel = opening && typeof opening.label === "string" ? opening.label.trim() : "";
  const rawOpeningInstruction = opening ? opening.instruction ?? opening.bodyInstruction : null;
  const openingInstruction = typeof rawOpeningInstruction === "string"
    ? rawOpeningInstruction.trim()
    : "";
  const closingLabel = closing && typeof closing.label === "string" ? closing.label.trim() : "";
  const rawClosingInstruction = closing ? closing.instruction ?? closing.bodyInstruction : null;
  const closingInstruction = typeof rawClosingInstruction === "string"
    ? rawClosingInstruction.trim()
    : "";
  const officialSectionTitles = ["今日大事", "热点事件", "变更与实践", "安全与风险", "开源与工具", "数据与洞察"];
  return openingLabel === "摘要"
    && openingInstruction === LEGACY_DEFAULT_OPENING_INSTRUCTION
    && ["今日观察", "趋势观察", "收尾观察"].includes(closingLabel)
    && closingInstruction === LEGACY_DEFAULT_CLOSING_INSTRUCTION
    && sections.length === officialSectionTitles.length
    && sections.every((section, index) => {
      if (!isObject(section) || typeof section.title !== "string" || section.title.trim() !== officialSectionTitles[index]) {
        return false;
      }
      return typeof section.description === "string"
        && section.description === LEGACY_DEFAULT_SECTION_DESCRIPTIONS[officialSectionTitles[index]!];
    })
    && (systemPrompt == null || systemPrompt === getLegacyDefaultDailyReportSystemPrompt());
}

export function classifyDailyReportTemplateMigration(value: unknown, systemPrompt?: string | null): DailyReportTemplateMigrationStatus {
  if (!isObject(value)) return "invalid";
  if (Array.isArray(value.blocks)) {
    try {
      parseDailyReportTemplateJson(JSON.stringify(value));
      return "v2";
    } catch {
      return "invalid";
    }
  }
  if ("opening" in value || "sections" in value || "closing" in value) {
    return isOfficialLegacyTemplate(value, systemPrompt) ? "official_default_legacy" : "custom_legacy_requires_migration";
  }
  return "invalid";
}

export function migrateLegacyDailyReportTemplate(value: unknown): NormalizedDailyReportTemplate {
  if (!isObject(value)) throw new Error("旧日报模板必须是 JSON 对象。");
  if (Array.isArray(value.blocks)) {
    const parsed = parseDailyReportTemplateJson(JSON.stringify(value));
    if (!parsed) throw new Error("日报模板无法迁移。");
    return parsed;
  }
  const opening = isObject(value.opening) ? value.opening : {};
  const closing = isObject(value.closing) ? value.closing : {};
  const sections = Array.isArray(value.sections) ? value.sections : [];
  const blocks: DailyReportTemplateBlock[] = [
    {
      type: "text",
      title: nonEmptyText(opening.label, "摘要"),
      bodyInstruction: nonEmptyText(opening.instruction ?? opening.bodyInstruction, "概括本期最重要的信息和主线变化。"),
    },
    ...sections.filter(isObject).map((section) => ({
      type: "section" as const,
      title: nonEmptyText(section.title, "自定义栏目"),
      description: nonEmptyText(section.description ?? section.instruction, "输出该栏目内容。"),
      item: {
        bodyInstruction: nonEmptyText(
          isObject(section.item) ? section.item.bodyInstruction : section.bodyInstruction,
          "说明条目内容、背景和影响。",
        ),
        notes: isObject(section.item) && Array.isArray(section.item.notes)
          ? section.item.notes.map((note) => isObject(note) ? normalizeNote(note as Partial<DailyReportTemplateNote>) : normalizeNote({}))
          : [],
      },
    })),
    {
      type: "text",
      title: nonEmptyText(closing.label, "趋势观察"),
      bodyInstruction: nonEmptyText(closing.instruction ?? closing.bodyInstruction, "提炼本期信息中的后续趋势和需要继续观察的判断。"),
    },
  ];
  return normalizeDailyReportTemplateConfig({
    headlineInstruction: DEFAULT_DAILY_REPORT_HEADLINE_INSTRUCTION,
    recentTopicRules: DEFAULT_DAILY_REPORT_RECENT_TOPIC_RULES,
    blocks,
    globalRules: DEFAULT_DAILY_REPORT_TEMPLATE.globalRules,
  });
}

export function getDailyReportTemplateSignature(templateInput: DailyReportTemplateConfig) {
  const canonical = JSON.stringify(normalizeDailyReportTemplateConfig(templateInput));
  return createHash("sha256").update(canonical).digest("hex");
}

function buildBlockExample(block: DailyReportTemplateBlock) {
  if (block.type === "text") {
    return { type: "text", title: block.title, body: "..." };
  }
  return {
    type: "section",
    blockKey: block.key,
    title: block.title,
    items: [
      {
        title: "...",
        body: "...",
        notes: block.item.notes.map((note) => ({ label: note.label, text: "..." })),
      },
    ],
  };
}

export function compileDailyReportTemplatePrompt(templateInput: DailyReportTemplateConfig): string {
  const template = validateDailyReportTemplateConfig(normalizeDailyReportTemplateConfig(templateInput));
  const outputShape = {
    headline: "GPT-5.6 有限预览、Mythos 5 白名单恢复",
    blocks: template.blocks.map(buildBlockExample),
  };
  const lines = [
    DAILY_REPORT_SYSTEM_ROLE_PROMPT,
    "",
    "固定输出格式：",
    JSON.stringify(outputShape),
    "",
    "通用结构规则：",
    "1. 最终 JSON 顶层必须包含 headline 字段。",
    "2. section block 的 items 为空数组时会在渲染时自动隐藏；有 items 时，每个 item 必须包含 title，建议包含 body。",
    "3. item.title 写事件标题；item.body 写正文或轻量看点；body 为空字符串或缺失时会按紧凑模式只展示标题。",
    "4. notes 只按栏目配置输出 label/text；无配置时输出空数组。",
    "",
    "输出要求：",
  ];

  let index = 1;
  lines.push(`${index}. headline 字段：${template.headlineInstruction}`);
  index += 1;
  for (const block of template.blocks) {
    if (block.type === "text") {
      lines.push(`${index}. text block「${block.title}」：type 固定为 "text"，title 固定为“${block.title}”；body 字段：${block.bodyInstruction}`);
      index += 1;
      continue;
    }
    const noteRules = block.item.notes.length > 0
      ? block.item.notes
        .map((note) => `${note.label}${note.required ? " 必填" : " 可选"}：${note.instruction}`)
        .join("；")
      : "输出空数组";
    const itemCountRule = [
      `条目数非空校验：${block.required ? "开启" : "关闭"}`,
      `条目数量：${block.minItems ?? 0} 至 ${block.maxItems == null ? "不限" : block.maxItems} 条`,
    ].join("；");
    const bodyRule = block.item.bodyRequired === false
      ? `正文非空校验：关闭；body 字段可为空${block.item.bodyInstruction ? `；补充说明：${block.item.bodyInstruction}` : ""}`
      : `正文非空校验：开启；body 字段：${block.item.bodyInstruction}`;
    lines.push(`${index}. section block「${block.title}」：${itemCountRule}；栏目要求：${block.description}；${bodyRule}；notes 要求：${noteRules}`);
    index += 1;
  }

  for (const rule of template.globalRules) {
    if (!rule.trim()) continue;
    lines.push(`${index}. ${rule.trim()}`);
    index += 1;
  }

  if (template.recentTopicRules.length > 0) {
    lines.push("", "历史主题去重规则：");
    for (const [ruleIndex, rule] of template.recentTopicRules.entries()) {
      if (!rule.trim()) continue;
      lines.push(`${ruleIndex + 1}. ${rule.trim()}`);
    }
  }

  return lines.join("\n");
}

export function stringifyDailyReportTemplate(template: DailyReportTemplateConfig) {
  return JSON.stringify(validateDailyReportTemplateConfig(normalizeDailyReportTemplateConfig(template)), null, 2);
}

export const DEFAULT_DAILY_REPORT_TEMPLATE_JSON = stringifyDailyReportTemplate(DEFAULT_DAILY_REPORT_TEMPLATE);
