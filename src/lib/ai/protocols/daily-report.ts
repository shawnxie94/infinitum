import { normalizeModelResponseText } from "@/lib/ai/response-format";
import type {
  DailyReportCandidateAssessment,
  DailyReportDraft,
  DailyReportModelDraft,
  DailyReportPlanSelection,
  DailyReportRepairPatchResult,
  DailyReportReviewResult,
  RecentDailyReportTopic,
} from "@/lib/daily-report/types";
import { DAILY_REPORT_REVIEW_VIOLATION_CODES } from "@/lib/daily-report/types";
import type {
  DailyReportTemplateSectionBlock,
  NormalizedDailyReportTemplate,
} from "@/lib/daily-report/template";
import { getJsonParseErrorMessage } from "@/lib/ai/provider-types";
import { InvalidJsonModelResponseError } from "@/lib/ai/provider-types";

export const DAILY_REPORT_JSON_SYNTAX_RULE =
  "JSON 语法是硬约束：所有字符串内部的双引号必须转义为 \\\"，换行必须转义为 \\n；字段之间的逗号和所有括号必须完整；不要把自然语言示例或 Markdown 放在 JSON 对象外。";

export const DAILY_REPORT_MODEL_CANDIDATE_KEYS = [
  "id",
  "clusterId",
  "title",
  "summary",
  "sourceName",
  "qualityScore",
  "candidateScore",
  "sourceCount",
  "itemCount",
  "createdAt",
  "publishedAt",
  "publishedAtKnown",
  "eventType",
  "eventSubject",
  "eventAction",
  "eventObject",
  "eventDate",
  "isFollowUp",
  "newItemCountOnDate",
  "newSourceCountOnDate",
] as const;

export const DAILY_REPORT_WRITE_CANDIDATE_KEYS = [
  "title",
  "summary",
  "sourceName",
  "publishedAt",
  "publishedAtKnown",
  "eventType",
  "eventSubject",
  "eventAction",
  "eventObject",
  "eventDate",
  "isFollowUp",
  "newItemCountOnDate",
  "newSourceCountOnDate",
] as const;

export const DAILY_REPORT_CANDIDATE_FIELD_GUIDE = [
  "id：候选编号；ASSESS 输出的 candidateId 必须原样引用。",
  "title：候选标题；summary：已有中文摘要；sourceName：代表性来源。",
  "qualityScore：内容质量分；candidateScore：本地日报候选排序分；两者都是排序信号，不是事实可信度。",
  "sourceCount：互证来源数；itemCount：候选聚合包含的内容数。",
  "createdAt：系统入库时间；publishedAt：源站发布时间；publishedAtKnown：发布时间是否可靠。",
  "eventType/eventSubject/eventAction/eventObject/eventDate：系统已有的结构化事件线索，优先作为事实线索，不要重新发明事件。",
  "isFollowUp：是否是已有主题的事实增量；newItemCountOnDate/newSourceCountOnDate：日报日期新增内容和来源数量。",
  "evidenceItems：候选的简短来源证据；只读取其中的 title/sourceName/publishedAt 核对事实，不要逐条复述。",
].join("\n");

export const DAILY_REPORT_ASSESSMENT_FIELD_GUIDE = [
  "candidateId：输入候选的 id；isWorthReading：是否进入 PLAN；relevanceScore：0 到 100 的选题相关性分。",
  "suggestedBlockKey：建议的 section blockKey，必须来自模板 sections，无法判断时为 null；它只是软提示，最终以 PLAN 和本地校验为准。",
  "historyDecision：与 recentTopics 比较后的历史关系，只能是 new、duplicate、follow_up 或 uncertain。duplicate 表示近期开过的日报已覆盖同一事件；follow_up 表示同一事件有新的动作、事实、数据或影响；new 表示新事件；uncertain 表示无法确定。",
  "matchedRecentTopicTitle：当 historyDecision=duplicate 时，填写命中的历史主题标题；其他情况必须为 null。它只用于人工追溯，不改变去重判断。",
  "template.sections 中 blockKey 是稳定栏目键，blockTitle 只是展示名，description 是选题方向；只根据栏目语义判断 suggestedBlockKey。",
  "template.selectionRules：后台配置的候选选题与栏目分配策略。",
  "template.historyTopicRules：后台配置的历史主题判断策略，只用于辅助判断重复报道和后续进展；不改变系统硬过滤、历史数据来源或输出枚举。",
  "recentTopics 是完整的近期已发布日报主题集合。逐一将每个候选与整个集合比较，不要假设代码已经提供了候选与历史主题的关联关系；不要因为主体、来源或 cluster 相同就直接判定重复。",
  "只返回上述六个字段，不附带其他解释字段。",
].join("\n");

export const DAILY_REPORT_PLAN_TOPIC_CONTRACT = [
  "主题单位是一个独立事实命题，不是一个栏目主题、行业方向或资讯合集。一个 topic 默认只表达一个主体、一个具体动作、一个对象，以及一个结果或状态变化。",
  "只有以下情况允许把多个候选放入同一个 topic：它们报道同一具体事件、同一次发布或版本变化、同一个项目的同一项能力、同一份报告/数据集，或同一事件的互证来源。",
  "同一栏目、同一公司、同一技术方向、同一天发布、能够共同支持一个宏观趋势，都不足以证明是同一 topic。",
  "如果候选的事件主体、动作或对象明显不同，且不是同一事实的互证来源，必须拆成多个 topic；不允许生成合集式汇总或其他资讯拼盘。",
  "跨 cluster 合并只能在候选明确指向同一具体事实时使用；cluster 只是上游来源聚合线索，不是合并许可。无法确认时宁可拆开。",
  "归类分两步执行：先按 template.selectionRules 与各栏目 description，从全部通过评估的候选中确定最值得入选的主题；同一主题只进入一个栏目，不得在其他栏目重复。",
  "对未入选主题，再按 template.selectionRules 中的分配/优先顺序和各栏目 description 归类；selectionRules 未声明优先顺序时按栏目语义分配，展示顺序不得隐式变成选题优先级。",
  "同一 topic 只能进入一个栏目；如果候选同时符合多个栏目，按 template.selectionRules 的取舍规则决定，不硬编码任何固定栏目优先级。",
  "数量是硬约束，不是候选池提示：template.sections[].topics 只表示最终要写入日报的主题，不得输出待裁剪主题。每个 section 的 topics 数量必须在 minItems 与 maxItems 之间：不能超过 maxItems，达到 maxItems 后立即停止继续添加；可选栏目在可规划候选充足且有足够高价值候选时，应尽量接近 maxItems，而不是只输出少量主题；候选不足时不要为了凑数补造、合并合集或选择低价值候选。",
].join("\n");

export const DAILY_REPORT_PLAN_FIELD_GUIDE = [
  "candidateBriefs[]：每个元素对应一个通过 ASSESS 的候选；PLAN 必须基于这些候选重新归纳最终日报主题，不要沿用或假设任何预先主题分组。",
  "candidateBriefs[].candidateId：候选编号，输出时必须原样引用；title：候选标题；summaryExcerpt：有界摘要片段，可能为空且不是全文。",
  "candidateBriefs[].clusterId：上游事件聚合编号，只表示已有来源聚合，不等于最终日报主题；只有确认是同一具体事实时才允许跨 cluster 合并。",
  "candidateBriefs[].sourceName/evidenceItems：代表来源和有限证据线索；candidateScore/qualityScore/relevanceScore/sourceCount/itemCount：排序、质量、相关性、互证来源数和聚合条目数，都是判断信号，不是事实。",
  "candidateBriefs[].publishedAt/publishedAtKnown：源站时间及其可靠性；isFollowUp/newItemCountOnDate/newSourceCountOnDate：后续进展及日报日期新增量信号。",
  "candidateBriefs[].historyDecision：ASSESS 对历史日报的判断；new、follow_up 是可规划候选，duplicate 不应出现在 candidateBriefs，uncertain 需要结合其他字段判断。",
  "candidateBriefs[].eventType/eventSubject/eventAction/eventObject/eventDate：已有结构化事件线索，只用于理解和比较；不得补造输入之外的事实。预算压缩时可选字段可能省略，但 candidateId、title、candidateScore、relevanceScore、sourceCount、itemCount 和 publishedAt 会保留。",
  "template.selectionRules：后台配置的选题偏好与栏目间取舍策略；按规则和栏目语义选择，不把展示顺序当优先级。",
  "template.historyTopicRules：后台配置的历史主题判断策略，只用于辅助识别重复事件或后续进展；recentTopics 是代码提供的历史主题数据，不是本期候选。",
  "recentTopics：近期开过的日报条目，仅用于识别重复事件或后续进展；不要把它们当作本期候选。输入中的 candidateBriefs 已经是 ASSESS 通过的候选全集。",
  "template.sections[].blockKey 是唯一栏目键；blockTitle 仅用于理解栏目，description 是栏目意图，required/minItems/maxItems 是最终主题数量的硬约束；topics 不是候选池，不能先输出全部候选再交给代码裁剪。每个 section 只能返回最终要保留的 topics，数量必须在 minItems 与 maxItems 之间：达到 maxItems 后立即停止；可选栏目在可规划候选充足且有足够高价值候选时，应尽量接近 maxItems，而不是只输出少量主题；不能为了凑数选择低价值候选。",
  "输出 sections[].topics[]：每个 topic 的 candidateIds 表示同一个最终日报主题的全部候选来源；一个候选只能属于一个主题。topicId 由代码生成，不要输出。",
].join("\n");

export const DAILY_REPORT_WRITE_FIELD_GUIDE = [
  "selectedTopics[]：每个元素对应一个最终日报条目；topicId 是内部主题编号，blockKey 是唯一栏目键。WRITE 只负责基于主题候选事实写作，不输出来源映射字段。",
  "selectedTopics[].requiredNotes：当前栏目对该主题要求输出的必填要点；每个 label 必须在 item.notes 中原样出现一次，并填写基于候选事实的非空 text。正文中已经出现相关事实时，也不能省略对应 notes。",
  "selectedTopics[].candidates：只包含写作所需事实；title 是标题，summary 是已有摘要，sourceName 是代表来源。",
  "selectedTopics[].candidates[].publishedAt/publishedAtKnown：源站时间及其可靠性；eventType/eventSubject/eventAction/eventObject/eventDate：已有结构化事件线索；isFollowUp/newItemCountOnDate/newSourceCountOnDate：后续进展信号。",
  "selectedTopics[].candidates[].evidenceItems：有限来源证据，包含标题、来源、摘要片段和发布时间；只用于核对事实，不逐条复述。",
  "候选字段只用于基于事实写作；不要把内部编号、来源名、时间或事件线索扩写成输入之外的事实。",
  "template.writingRules：后台配置的正文表达和信息侧重规则；只影响写作方式，不包含阶段流程、Topic-Candidate 映射或输出协议。",
  "每个 selectedTopics[] 必须生成一个 section item；item.topicId 必须原样复制对应 topicId；不要输出 sourceIds、candidateIds 或其他来源映射字段，来源关系由代码根据 Topic 映射生成。",
  "template.blocks：完整栏目与正文规则；text block 只写模板定义的文本块，section block 按 type/key/title、item.bodyInstruction/bodyRequired 和 notes 规则输出。",
  "输出结构：输出 JSON 对象本身就是日报内容，顶层必须直接包含 headline 和 blocks。合法结构为 {\"headline\":\"...\",\"blocks\":[...]}；禁止使用 draft、result、data、output 等外层包装键。",
].join("\n");

export const DAILY_REPORT_REVIEW_FEEDBACK_GUIDE = [
  "reviewFeedback：仅在 Review 触发的重试中出现，包含上一次审核发现的问题、输入证据和具体修复指导。它是系统维护的定向反馈，不是用户可编辑的输出协议。",
  "reviewFeedback.violations：优先处理 severity=error 的问题；每条 guidance 都是下一次重试的修复方向，必须结合 evidence 和当前阶段输入执行，不得臆测输入之外的事实。",
  "PLAN 重试可以调整主题归纳、候选覆盖和栏目分配；WRITE 重试只能在 selectedTopics 和候选证据范围内修正正文、主题表达和重复内容，不得改变主题候选关系或补造事实。",
  "如果某条指导与当前阶段职责冲突，保留当前阶段边界并在可执行范围内修复；不能因为 reviewFeedback 而输出内部协议、解释文字或额外字段。",
].join("\n");

export const DAILY_REPORT_REPAIR_FIELD_GUIDE = [
  "input.draft：待修复日报，仅用于查看现有条目的 notes；不要重写其中的 headline、blocks、正文、主题、候选、栏目或顺序。",
  "violations：本地校验指出的具体问题；code/stage/message 描述原因，blockKey/topicId/candidateIds/itemIndex/itemTitle/noteLabel/noteInstruction 用于精确定位。",
  "missingNotes：按 topicId + noteLabel 列出必须补齐的 notes；每个目标只补对应 label，不要扩大影响范围。",
  "repairTargets：受影响主题及其候选事实；requiredNotes 是该主题允许补齐的必填要点，candidates 是唯一可用的事实来源。",
  "template.blocks：模板定义的 block 和 notes 规则；只按 violation 补齐缺失字段。template.writingRules 只影响表达方式，不能改变修复范围或数据关系。",
  "只修复 violations 指定的问题，不重新归纳主题、不改写正文、不新增来源或栏目。",
  "输出结构：只返回 {\"patches\":[{\"topicId\":\"...\",\"notes\":[{\"label\":\"...\",\"text\":\"...\"}]}]}；不要返回 headline、blocks、draft、result、data、output 或 sourceIds。",
].join("\n");

/**
 * 阶段固定协议的唯一来源：buildDailyReportStageConfig/buildDailyReportStagePrompt
 * 与 getDailyReportProtocolMaterial（有效协议指纹）都从这里取文本。
 * 修改任何一条都会同时改变实际模型请求与协议指纹，从而失效旧 checkpoint。
 */

export const DAILY_REPORT_STAGE_ROLE =
  "你是中文资讯日报阶段执行器。只基于输入内容工作，不补造事实。";

export const DAILY_REPORT_STAGE_CONTRACTS = {
  ASSESS:
    "不得写正文、不得合并主题、不得重新编号或遗漏候选；必须逐一返回输入中的每个 candidateId。只返回 candidateId、isWorthReading、relevanceScore、suggestedBlockKey、historyDecision、matchedRecentTopicTitle 六个字段。suggestedBlockKey 必须来自模板 sections 或为 null；historyDecision 必须是 new、duplicate、follow_up、uncertain 之一。historyDecision=duplicate 时 matchedRecentTopicTitle 填写命中的历史主题标题，否则为 null。若 historyDecision=duplicate，isWorthReading 必须为 false。依据输入模板 selectionRules 和栏目描述判断，不假设固定领域顺序。",
  PLAN:
    `必须返回 schemaVersion=2；template.sections 是唯一可规划栏目清单；sections 中的 blockKey 只能使用 template.sections[].blockKey，禁止使用 text、type、栏目标题或自造 key；text block 不属于 sections。每个 topics[].candidateIds 必须非空；一个 candidateId 只能属于一个 topic。topicId 由代码生成，不要输出。若输入包含 reviewFeedback，必须优先根据其中的 guidance 修复对应问题，并继续遵守 candidateBriefs、template 和 recentTopics 的输入边界。\n${DAILY_REPORT_PLAN_TOPIC_CONTRACT}`,
  WRITE:
    "只能使用 selectedTopics 中的主题和候选；不得重新归纳主题、换栏目、增加栏目或补造事实。若输入包含 reviewFeedback，必须优先根据其中的 guidance 修复对应问题，并继续遵守 selectedTopics、template 和候选事实边界。输出对象本身就是日报内容，顶层必须直接包含 headline 和 blocks，合法结构为 {\"headline\":\"...\",\"blocks\":[...]}；禁止输出 draft、result、data、output 等外层包装键。text block 返回 {type:\"text\",title,body}，section block 返回 {type:\"section\",blockKey,title,items}，item 返回 {topicId,title,body,notes}；每个 selectedTopics 必须生成一个 item，topicId 必须原样复制；不要输出 sourceIds、candidateIds 或其他来源映射字段；notes 必须是 {label:string,text:string} 数组，模板中的 required 和 instruction 只是规则元数据，绝不能原样输出到 notes；模板中 required=true 的 note 必须按模板 label 原样输出且 text 非空，required=false 的 note 可按内容需要输出；只使用模板中定义的 text block 和已规划的 section block。正文只写内容本身，不要带栏目名、字段名或标签前缀；除模板允许的加粗和斜体外，不要输出链接、图片、标题、表格、列表或其他 Markdown 结构。",
  REPAIR:
    "只修复输入 violations 中列出的问题，不改变已有正文、主题、候选、栏目和顺序。REPAIR 只返回 notes 补丁，不返回完整日报草稿；合法结构为 {\"patches\":[{\"topicId\":\"...\",\"notes\":[{\"label\":\"...\",\"text\":\"...\"}]}]}。topicId 必须来自 repairTargets，notes 的 label 必须来自对应 requiredNotes，不能新增主题、候选、栏目或字段。补丁文本只能使用 repairTargets 中的候选事实，不得编造。每条 violation 都必须有对应补丁或已经由现有内容满足。",
} as const;

export const DAILY_REPORT_STAGE_INSTRUCTIONS = {
  ASSESS:
    `逐一评估输入中的每个 candidateId。每个候选必须返回一次，不得新增或遗漏 ID。返回 {assessments:[{candidateId,isWorthReading,relevanceScore,suggestedBlockKey,historyDecision,matchedRecentTopicTitle}]}。只做选题评估和历史重复判断，不写正文，不合并主题。依据模板 selectionRules 与栏目语义判断相关性。`,
  PLAN:
    `基于所有 candidateBriefs 做全局选题、主题归纳和栏目分配。先按“一个独立事实对应一个 topic”的规则判断候选是否属于同一主题，再决定主题是否入选和放入哪个栏目。遵循 template.selectionRules 与栏目 description；selectionRules 未声明优先级时按语义分配，不能把栏目展示顺序当作优先级。${DAILY_REPORT_PLAN_TOPIC_CONTRACT} 综合摘要、事件线索、来源数量、日期相关性、后续进展、近期重复和评分信号，不要只按单一分数排序。输出的每个 section.blockKey 必须逐字复制 template.sections[].blockKey；每个 section 的 topics 数量必须在对应模板的 minItems 与 maxItems 之间，可选栏目在可规划候选充足且有足够高价值候选时，应尽量接近 maxItems，但不能为了凑数选择低价值候选。一个 topics[].candidateIds 数组表示同一个最终日报主题的候选事实或互证来源；每个候选只能出现在一个主题中。只返回 {schemaVersion:2,sections:[{blockKey,topics:[{candidateIds:[number]}]}]}。不要输出主题编号、栏目展示名、标题、理由或其他字段；不得写正文、不得创建输入之外的候选或栏目，不得输出 text block。`,
  WRITE:
    "严格按照 selectedTopics 和对应 Block 写作，只返回完整日报内容 JSON。输出对象本身就是日报内容，顶层直接包含 headline 和 blocks，不得包在 draft、result、data 或 output 字段中。不得重新选题、合并主题、换栏目、增加栏目或补造事实。每个 section block 必须包含与输入一致的 blockKey 和模板 title；每个 section item 必须包含 topicId、title、body 和 notes，不要输出 sourceIds 或 candidateIds；每个计划主题必须且只能对应一个 item；当模板中该栏目 item.bodyRequired=false 时 body 必须为空字符串或省略，不能输出正文，否则 body 必须非空；每个 notes 元素只能是 {label,text}，不要输出 required 或 instruction；notes 中必须包含模板配置的全部 required=true note，label 必须逐字匹配、text 必须非空；每个 text block 必须包含 type、title、body。",
  REPAIR:
    "只修复 violations 中列出的问题。返回 notes 补丁，不要返回 headline、blocks、draft、result、data 或 output；每个补丁必须定位到 violations 中的 topicId，并使用 repairTargets 对应候选事实补齐缺失的 required note。相同主题有多个缺失要点时必须在同一个补丁中逐条补齐；只输出 {patches:[{topicId,notes:[{label,text}]}]}。",
} as const;

/**
 * 有效协议材料清单：全部实际进入模型请求的固定协议文本（阶段角色、四个阶段
 * 的 system 合同与 user 指令、全部字段指南、JSON 语法规则）。REVIEW 系统提示
 * 在 protocol-prompts 中与这些材料一起参与指纹。请保持该清单与请求装配一致。
 */
export function getDailyReportProtocolMaterial(): string[] {
  return [
    DAILY_REPORT_STAGE_ROLE,
    DAILY_REPORT_STAGE_CONTRACTS.ASSESS,
    DAILY_REPORT_STAGE_CONTRACTS.PLAN,
    DAILY_REPORT_STAGE_CONTRACTS.WRITE,
    DAILY_REPORT_STAGE_CONTRACTS.REPAIR,
    DAILY_REPORT_STAGE_INSTRUCTIONS.ASSESS,
    DAILY_REPORT_STAGE_INSTRUCTIONS.PLAN,
    DAILY_REPORT_STAGE_INSTRUCTIONS.WRITE,
    DAILY_REPORT_STAGE_INSTRUCTIONS.REPAIR,
    DAILY_REPORT_JSON_SYNTAX_RULE,
    DAILY_REPORT_CANDIDATE_FIELD_GUIDE,
    DAILY_REPORT_ASSESSMENT_FIELD_GUIDE,
    DAILY_REPORT_PLAN_TOPIC_CONTRACT,
    DAILY_REPORT_PLAN_FIELD_GUIDE,
    DAILY_REPORT_WRITE_FIELD_GUIDE,
    DAILY_REPORT_REPAIR_FIELD_GUIDE,
    DAILY_REPORT_REVIEW_FEEDBACK_GUIDE,
  ];
}

export function compactDailyReportModelCandidate(article: unknown) {
  if (!article || typeof article !== "object" || Array.isArray(article)) {
    return article;
  }

  const input = article as Record<string, unknown>;
  const candidate = Object.fromEntries(
    DAILY_REPORT_MODEL_CANDIDATE_KEYS
      .filter((key) => key in input)
      .map((key) => [key, input[key]]),
  ) as Record<string, unknown>;

  if (Array.isArray(input.evidenceItems)) {
    candidate.evidenceItems = input.evidenceItems
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item) => Object.fromEntries(
        ["title", "sourceName", "publishedAt"]
          .filter((key) => key in item)
          .map((key) => [key, item[key]]),
      ));
  }

  return candidate;
}

function truncateDailyReportWritingText(value: unknown, maxChars: number) {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

export function compactDailyReportWritingCandidate(article: unknown) {
  if (!article || typeof article !== "object" || Array.isArray(article)) return article;
  const input = article as Record<string, unknown>;
  const candidate = Object.fromEntries(
    DAILY_REPORT_WRITE_CANDIDATE_KEYS
      .filter((key) => key in input)
      .map((key) => [key, key === "title" ? truncateDailyReportWritingText(input[key], 180) : key === "summary" ? truncateDailyReportWritingText(input[key], 2400) : ["eventSubject", "eventAction", "eventObject"].includes(key) ? truncateDailyReportWritingText(input[key], 240) : input[key]]),
  ) as Record<string, unknown>;
  if (Array.isArray(input.evidenceItems)) {
    candidate.evidenceItems = input.evidenceItems
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .slice(0, 3)
      .map((item) => ({
        title: truncateDailyReportWritingText(item.title, 180),
        sourceName: truncateDailyReportWritingText(item.sourceName, 100),
        summaryExcerpt: truncateDailyReportWritingText(item.summary ?? item.summaryExcerpt, 360),
        publishedAt: item.publishedAt,
      }));
  }
  return candidate;
}

export function compactDailyReportRepairDraft(draft: DailyReportModelDraft | DailyReportDraft) {
  return {
    blocks: draft.blocks.flatMap((block) => block.type === "section"
      ? [{
          blockKey: block.blockKey,
          items: block.items.map((item) => ({
            topicId: item.topicId,
            notes: item.notes ?? [],
          })),
        }]
      : []),
  };
}

export function compactDailyReportRecentTopic(topic: RecentDailyReportTopic) {
  return Object.fromEntries(
    Object.entries(topic).filter(([key]) => key !== "sourceNumber"),
  );
}

export const parseDailyReportStageObject = (output: string) => {
    const normalized = normalizeModelResponseText(output);
    if (!normalized) {
      throw new InvalidJsonModelResponseError("日报阶段模型未返回 JSON 内容。");
    }
    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("顶层必须是 JSON 对象");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      throw new InvalidJsonModelResponseError(
        `日报阶段模型返回了无法解析的 JSON：${getJsonParseErrorMessage(error)}`,
      );
    }
  };

export const buildDailyReportStagePrompt = (
    stage: string,
    instructions: string,
    payload: Record<string, unknown>,
    inputFieldGuide: string,
  ) => [
    `阶段：${stage}`,
    instructions,
    `输入字段说明：\n${inputFieldGuide}`,
    "只输出一个合法 JSON 对象，不要输出 Markdown、代码块或解释。",
    `模板 JSON：${JSON.stringify(payload.template)}`,
    `输入 JSON：${JSON.stringify(payload.input)}`,
  ].join("\n");

export const buildDailyReportAssessmentTemplate = (template: NormalizedDailyReportTemplate, recentTopicLookbackDays?: number) => ({
    schemaVersion: 2,
    sections: template.blocks
      .filter((block): block is DailyReportTemplateSectionBlock => block.type === "section")
      .map((section) => ({
        blockKey: section.key,
        blockTitle: section.title,
        description: section.description,
      })),
    selectionRules: template.selectionRules,
    historyTopicRules: template.recentTopicRules,
    recentTopicLookbackDays: recentTopicLookbackDays ?? null,
  });

export const buildDailyReportPlanningTemplate = (template: NormalizedDailyReportTemplate, recentTopicLookbackDays?: number) => {
    const sections = template.blocks.filter(
      (block): block is DailyReportTemplateSectionBlock => block.type === "section",
    );
    return {
      schemaVersion: 2,
      selectionRules: template.selectionRules,
      historyTopicRules: template.recentTopicRules,
      recentTopicLookbackDays: recentTopicLookbackDays ?? null,
      sections: sections.map((section) => ({
        blockKey: section.key,
        blockTitle: section.title,
        description: section.description,
        required: section.required === true,
        minItems: section.minItems ?? 0,
        maxItems: section.maxItems,
      })),
    };
  };

export const buildDailyReportWritingTemplate = (template: NormalizedDailyReportTemplate, selectedBlockKeys?: string[]) => ({
    schemaVersion: 2,
    headlineInstruction: template.headlineInstruction,
    writingRules: template.globalRules,
    blocks: selectedBlockKeys && selectedBlockKeys.length > 0
      ? template.blocks.filter((block) => block.type === "text" || (block.key && selectedBlockKeys.includes(block.key)))
      : template.blocks,
  });

export const getRequiredNotesForBlock = (template: NormalizedDailyReportTemplate, blockKey: string) => {
    const block = template.blocks.find((entry): entry is DailyReportTemplateSectionBlock => entry.type === "section" && entry.key === blockKey);
    return block?.item.notes
      .filter((note) => note.required)
      .map((note) => ({ label: note.label, instruction: note.instruction })) ?? [];
  };

export const parseAssessmentOutput = (output: string): DailyReportCandidateAssessment[] => {
    const parsed = parseDailyReportStageObject(output);
    const raw = Array.isArray(parsed.assessments) ? parsed.assessments : parsed;
    if (!Array.isArray(raw)) {
      throw new InvalidJsonModelResponseError("ASSESS 返回必须是 assessments 数组。");
    }
    return raw as unknown as DailyReportCandidateAssessment[];
  };

export const parsePlanOutput = (output: string): DailyReportPlanSelection => parseDailyReportStageObject(output) as unknown as DailyReportPlanSelection;
export const parseDraftOutput = (output: string): DailyReportModelDraft => parseDailyReportStageObject(output) as unknown as DailyReportModelDraft;
export const parseRepairPatchOutput = (output: string): DailyReportRepairPatchResult => {
    const parsed = parseDailyReportStageObject(output);
    if (!Array.isArray(parsed.patches)) {
      throw new InvalidJsonModelResponseError("REPAIR 返回必须是 patches 数组。");
    }
    return { patches: parsed.patches as DailyReportRepairPatchResult["patches"] };
  };
export const parseReviewOutput = (output: string): DailyReportReviewResult => {
    const parsed = parseDailyReportStageObject(output) as Record<string, unknown>;
    if (parsed.verdict !== "pass" && parsed.verdict !== "reject") {
      throw new InvalidJsonModelResponseError("REVIEW 返回的 verdict 必须是 pass 或 reject。");
    }
    if (!Array.isArray(parsed.violations)) {
      throw new InvalidJsonModelResponseError("REVIEW 返回必须包含 violations 数组。");
    }
    const violations = parsed.violations.map((rawViolation) => {
      if (!rawViolation || typeof rawViolation !== "object") {
        throw new InvalidJsonModelResponseError("REVIEW violations 包含无效对象。");
      }
      const violation = rawViolation as Record<string, unknown>;
      if (!DAILY_REPORT_REVIEW_VIOLATION_CODES.includes(violation.code as typeof DAILY_REPORT_REVIEW_VIOLATION_CODES[number])) {
        throw new InvalidJsonModelResponseError(`REVIEW 返回未知 violation code：${String(violation.code)}`);
      }
      if (violation.severity !== "error" && violation.severity !== "warning") {
        throw new InvalidJsonModelResponseError("REVIEW violation severity 必须是 error 或 warning。");
      }
      const topicIds = violation.topicIds === undefined
        ? undefined
        : Array.isArray(violation.topicIds) && violation.topicIds.every((value) => typeof value === "string")
          ? violation.topicIds as string[]
          : null;
      const candidateIds = violation.candidateIds === undefined
        ? undefined
        : Array.isArray(violation.candidateIds) && violation.candidateIds.every((value) => typeof value === "number" && Number.isInteger(value))
          ? violation.candidateIds as number[]
          : null;
      if (topicIds === null || candidateIds === null || typeof violation.message !== "string") {
        throw new InvalidJsonModelResponseError("REVIEW violation 字段格式无效。");
      }
      if (typeof violation.evidence !== "string" || !violation.evidence.trim()) {
        throw new InvalidJsonModelResponseError("REVIEW violation 必须包含非空 evidence。");
      }
      if (typeof violation.guidance !== "string" || !violation.guidance.trim()) {
        throw new InvalidJsonModelResponseError("REVIEW violation 必须包含非空 guidance。");
      }
      return {
        code: violation.code as DailyReportReviewResult["violations"][number]["code"],
        severity: violation.severity as "error" | "warning",
        message: violation.message,
        ...(topicIds ? { topicIds } : {}),
        ...(candidateIds ? { candidateIds } : {}),
        evidence: violation.evidence,
        guidance: violation.guidance,
      };
    });
    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    return { verdict: parsed.verdict, violations, summary };
  };
