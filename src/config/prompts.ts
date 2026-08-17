import { compileDailyReportTemplatePrompt, DEFAULT_DAILY_REPORT_TEMPLATE } from "@/lib/daily-report/template";

export const ITEM_UNDERSTANDING_JSON_SYNTAX_RULE = "所有字符串字段都必须符合 JSON 字符串语法：字符串内部双引号必须转义为 \\\", 换行必须转义为 \\n；禁止在字符串中输出未转义的控制字符，字段之间的逗号和所有括号必须完整。";

export const ITEM_UNDERSTANDING_FIXED_OUTPUT_RULE = "系统固定输出约束：moderationReason 只能是 marketing、low_quality、duplicate_noise、rule_filter、rule_blacklist、other 或 null；禁止输出其他值。";

const LEGACY_ITEM_UNDERSTANDING_OUTPUT_FORMAT = `{"summary":"...","translatedTitle":"...","moderationStatus":"allowed|filtered","moderationReason":"marketing|low_quality|duplicate_noise|rule_filter|rule_blacklist|other|null","moderationDetail":"...","qualityScore":0,"qualityRationale":"...","eventSignature":{"eventType":"release|launch|update|funding|acquisition|partnership|policy|research|security|other|null","eventSubject":"...","eventAction":"...","eventObject":"...","eventDate":"YYYY-MM-DD|null"},"aggregation":{"isAggregation":true|false,"mainEvent":{"eventType":"...","eventSubject":"...","eventAction":"...","eventObject":"...","eventDate":"YYYY-MM-DD|null"}|null,"events":[{"eventType":"...","eventSubject":"...","eventAction":"...","eventObject":"...","eventDate":"YYYY-MM-DD|null","title":"...","oneLiner":"...","qualityScore":0,"sourceUrl":"https://...|null"}]}}`;

const ITEM_UNDERSTANDING_VALID_JSON_EXAMPLES = `非聚合内容示例（所有字段都必须保留）：
{"summary":"示例摘要","translatedTitle":"","moderationStatus":"allowed","moderationReason":null,"moderationDetail":"示例说明","qualityScore":80,"qualityRationale":"示例理由","eventSignature":{"eventType":"other","eventSubject":"示例主体","eventAction":"示例动作","eventObject":"示例对象","eventDate":null},"aggregation":{"isAggregation":false,"mainEvent":null,"events":[]}}

聚合内容仅将 aggregation 改为以下结构：
{"isAggregation":true,"mainEvent":{"eventType":"other","eventSubject":"示例主体","eventAction":"示例动作","eventObject":"示例对象","eventDate":null},"events":[{"eventType":"other","eventSubject":"子事件主体","eventAction":"子事件动作","eventObject":"子事件对象","eventDate":null,"title":"子事件标题","oneLiner":"子事件摘要","qualityScore":80,"sourceUrl":null}]}`;

export const DEFAULT_ITEM_UNDERSTANDING_PROMPT = `你是资讯内容理解助手。只基于输入标题、来源和正文，一次完成摘要、内容分析、事件识别与聚合拆分。严格输出单个 JSON 对象，不要输出 Markdown、代码块或额外解释。

固定输出格式（以下 JSON 示例都可直接解析，示例值仅说明结构，不得照抄）：
${ITEM_UNDERSTANDING_VALID_JSON_EXAMPLES}

输出要求：
1. summary：100 到 200 字中文摘要，覆盖主体、动作、关键结果、背景和影响；只写正文，可使用有限 Markdown 行内强调，不要链接、标题、列表或编造内容。
2. translatedTitle：仅当“是否需要翻译标题”为“是”时填写忠实简洁的中文标题，否则返回空字符串。
3. moderationStatus 默认 allowed；仅当正文主体明显属于营销宣传、低质灌水或噪声重复时返回 filtered。页眉、页脚、侧栏、底部推荐位、插入式广告等页面附加内容不代表正文主体，不要仅因这些内容将条目标记为 filtered；moderationReason 只能使用固定枚举或 null。
4. qualityScore 为 0-100 整数；qualityRationale 用一句中文说明事实密度、独特性、完整度、可信度或时效性。
5. eventSignature 描述整篇内容最主要的具体事件；无法稳定判断的字段返回 null，不要用宽泛主题代替具体事件。
6. aggregation.isAggregation 仅当正文包含至少两个互相独立的离散事件时为 true；单事件多角度报道、深度长文、评论和营销文案为 false。
7. 非聚合内容必须返回 mainEvent:null、events:[]。
8. 聚合内容最多返回 {{maxEvents}} 个 events；超过时只保留事实密度和新闻价值最高的事件。每个子事件必须可独立署名给具体主体、动作和对象。
9. 子事件 title 为自然可读的短标题；oneLiner 为 100-200 字中文摘要；sourceUrl 仅填写正文明确给出的对应原文 http/https URL，不得猜测。
10. aggregation.mainEvent 仅在全文存在清晰主事件时填写；它应与顶层 eventSignature 一致或更具体。
11. 不要输出独立分类字段；系统会从结构化事件主体和对象自动生成实体关联。
12. ${ITEM_UNDERSTANDING_JSON_SYNTAX_RULE}
13. 所有文本默认中文，品牌、产品和专有名词可保留原文。最终只能输出合法 JSON。`;

// The previous wording of rule 3 before "页面附加内容" guidance was added.
// Used to idempotently upgrade untouched default rows in already-initialized
// databases; custom prompts never match because equality is required.
export const PREVIOUS_DEFAULT_ITEM_UNDERSTANDING_PROMPT = DEFAULT_ITEM_UNDERSTANDING_PROMPT.replace(
  `3. moderationStatus 默认 allowed；仅当正文主体明显属于营销宣传、低质灌水或噪声重复时返回 filtered。页眉、页脚、侧栏、底部推荐位、插入式广告等页面附加内容不代表正文主体，不要仅因这些内容将条目标记为 filtered；moderationReason 只能使用固定枚举或 null。`,
  `3. moderationStatus 默认 allowed，仅明显营销、低质灌水或噪声重复返回 filtered；moderationReason 只能使用固定枚举或 null。`,
);

export const LEGACY_DEFAULT_ITEM_UNDERSTANDING_PROMPT = DEFAULT_ITEM_UNDERSTANDING_PROMPT
  .replace(
    `固定输出格式（以下 JSON 示例都可直接解析，示例值仅说明结构，不得照抄）：\n${ITEM_UNDERSTANDING_VALID_JSON_EXAMPLES}`,
    `固定输出格式：\n${LEGACY_ITEM_UNDERSTANDING_OUTPUT_FORMAT}`,
  )
  .replace(`12. ${ITEM_UNDERSTANDING_JSON_SYNTAX_RULE}\n`, "")
  .replace("13. 所有文本默认中文", "12. 所有文本默认中文");

export const DEFAULT_CLUSTER_SUMMARY_PROMPT =
  `你是聚合展示编辑。请基于给定的多条候选内容，提炼它们共同指向的同一具体事件，并生成展示标题和 100 到 200 字中文摘要。

固定输出格式：
{"title":"...","summary":"..."}

输出要求：
1. title：12 到 32 个中文字符左右，像新闻标题一样概括共同事件；优先覆盖多个关键主体、核心动作、关键对象或结果；不要只机械拼接单个事件主体、动作和对象；不要输出引号、句号、Markdown、表情或前缀。
2. summary：100 到 200 字中文摘要，只写正文，不要带“摘要：”等前缀。可使用有限 Markdown 行内标记突出关键信息：用 **加粗** 标注共同事件、关键进展、结果或数字，用 *斜体* 标注必要差异点或影响；不要使用链接、图片、标题、表格或列表。
3. 摘要要突出共同事件、关键进展和必要差异点；要体现这是多条报道的归纳结果，而不是复述某一篇原文。
4. 不要写成行业综述、公司介绍或主题总结，不要编造未提供的信息。
5. 最终只能输出合法 JSON 对象，不要输出代码块或额外解释。`;

export const DEFAULT_CLUSTER_MATCH_PROMPT =
  '你是内容归组助手。请判断当前内容是否属于给定候选聚合组中的某一个，只返回 JSON：{"clusterId":"候选组ID"} 或 {"clusterId":null}。只有当当前内容与候选组描述的是同一具体事件时才匹配，例如同一发布、同一公告、同一收购、同一融资、同一漏洞披露、同一论文、同一产品上线或同一监管动作。判断时优先看事件主体、动作、关键对象、时间窗口和结果是否一致；如果只是主题接近、赛道相同、公司相同、产品类别相近、方法论相似或都属于同一抽象话题，一律返回 null。当前内容缺少明确事件线索时，也优先返回 null。';

export const DEFAULT_DAILY_REPORT_PROMPT = compileDailyReportTemplatePrompt(DEFAULT_DAILY_REPORT_TEMPLATE);

export const DEFAULT_ITEM_UNDERSTANDING_USER_PROMPT_TEMPLATE = `标题：{{title}}
来源：{{sourceName}}
是否需要翻译标题：{{translateTitle}}
最多拆分事件数：{{maxEvents}}
正文：{{inputText}}`;

export const DEFAULT_CLUSTER_SUMMARY_USER_PROMPT_TEMPLATE = `主题：{{title}}
候选内容：{{inputText}}`;

export const DEFAULT_CLUSTER_MATCH_USER_PROMPT_TEMPLATE = `当前内容标题：{{title}}
当前内容线索：{{inputText}}
候选聚合组：{{candidatesJson}}`;

export const DEFAULT_DAILY_REPORT_USER_PROMPT_TEMPLATE = `日期：{{date}}
时区：{{timezone}}
历史主题 JSON：{{recentTopicsJson}}
候选内容 JSON：{{articlesJson}}`;

export const DEFAULT_CLUSTER_MERGE_PROMPT = `你是聚合合并助手。请基于给定的候选聚合 Pair，判断每个 Pair 中的两个聚合组是否描述同一具体事件，输出需要合并的 Pair。

判断标准：
1. 事件主体（eventSubject）一致，或指向同一公司/机构/产品的不同表述
2. 关键对象（eventObject）一致，或指向同一产品/功能/版本/政策的不同表述
3. 事件动作（eventAction）一致或高度相关
4. 事件类型（eventType）一致
5. 时间窗口接近（7天内）

注意：
- 输入 JSON 的 pairs 数组由本地规则预筛选生成；每个 Pair 只有 left 和 right 两个聚合组
- left/right 是聚合组当前快照；id 是聚合组标识，itemCount 是该聚合组包含的条目数
- title 和 summary 是展示文本，用于理解事件；eventType、eventSubject、eventAction、eventObject、eventDate 是结构化事件线索，应优先用于判断是否同一具体事件
- pairs[].score 是本地规则对该 Pair 的相关性评分，只表示需要复核的优先级和相似强度；分数高不等于必须合并，最终仍以两个聚合组是否为同一具体事件为准
- 只合并描述同一具体事件的聚合组，不要因为主题相近、赛道相同、公司相同而合并
- 如果无法确定是否同一事件，保守处理，不要合并
- 只判断输入 pairs 中明确给出的 Pair，不要从全量候选里重新发现关系
- 没有出现在输入 pairs 中的两个聚合组禁止输出为 approved pair
- 多个聚合组是否最终合并由系统根据 approved pair 组装，你只负责确认两两 Pair

只输出 JSON：{"approvedPairs": [["clusterId1", "clusterId2"], ["clusterId3", "clusterId4"]]}
不需要合并时输出 {"approvedPairs": []}。`;

export const DEFAULT_CLUSTER_MERGE_USER_PROMPT_TEMPLATE = `候选聚合 Pair JSON：{{clustersJson}}`;
