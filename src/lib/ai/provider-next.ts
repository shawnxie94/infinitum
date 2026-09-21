import {
  DEFAULT_DAILY_REPORT_REVIEW_PROMPT,
  ITEM_UNDERSTANDING_FIXED_OUTPUT_RULE,
} from "@/config/prompts";
import { MODEL_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD, MODEL_API_CIRCUIT_BREAKER_OPEN_MS, MODEL_API_CIRCUIT_BREAKER_WINDOW_MS } from "@/config/constants";
import {
  buildAiUserContent,
  getAiTaskContract,
  normalizeAiUserInstruction,
} from "@/lib/ai/contracts";
import {
  DEFAULT_QUALITY_RUBRIC,
  parseQualityRubricJson,
  renderQualityRubricPrompt,
} from "@/lib/ai/quality-rubric";
import type { RuntimeConfig } from "@/config/runtime";
import type { PromptConfigType } from "@/lib/settings/types";
import { createEmbedTexts } from "@/lib/ai/embeddings";
import { isDailyReportNotesRepairableViolation } from "@/lib/daily-report/types";
import { normalizeModelResponseText } from "@/lib/ai/response-format";
import { InvalidJsonModelResponseError, isInvalidJsonModelResponseError } from "@/lib/ai/provider-types";
import { createModelGateway } from "@infinitum/ai/provider/gateway";
import { createAiSdkTransport, createCompatClientTransport } from "@infinitum/ai/provider/transports";
import { CLUSTER_MATCH_SCHEMA } from "@/lib/ai/protocols/cluster";
import { ENTITY_ALIAS_DECISIONS_SCHEMA } from "@/lib/ai/protocols/entity-alias";
import type { JsonCompleteRequest } from "@infinitum/ai/provider/types";
import {
  getFallbackUnderstanding,
  normalizeAggregationSplitMaxEvents,
  parseItemUnderstandingOutput,
} from "@/lib/ai/protocols/item-understanding";
import {
  compactClusterMergeInputForModel,
  parseClusterMatchCandidateId,
  parseClusterMergeDecisions,
  parseClusterMergeInputMetadata,
  parseClusterSummaryOutput,
} from "@/lib/ai/protocols/cluster";
import { parseEntityAliasDecisions } from "@/lib/ai/protocols/entity-alias";
import {
  buildDailyReportAssessmentTemplate,
  buildDailyReportPlanningTemplate,
  buildDailyReportStagePrompt,
  buildDailyReportWritingTemplate,
  compactDailyReportModelCandidate,
  compactDailyReportRecentTopic,
  compactDailyReportRepairDraft,
  compactDailyReportWritingCandidate,
  DAILY_REPORT_CANDIDATE_FIELD_GUIDE,
  DAILY_REPORT_ASSESSMENT_FIELD_GUIDE,
  DAILY_REPORT_JSON_SYNTAX_RULE,
  DAILY_REPORT_PLAN_TOPIC_CONTRACT,
  DAILY_REPORT_PLAN_FIELD_GUIDE,
  DAILY_REPORT_REVIEW_FEEDBACK_GUIDE,
  DAILY_REPORT_WRITE_FIELD_GUIDE,
  DAILY_REPORT_REPAIR_FIELD_GUIDE,
  getRequiredNotesForBlock,
  parseAssessmentOutput,
  parseDraftOutput,
  parsePlanOutput,
  parseRepairPatchOutput,
  parseReviewOutput,
} from "@/lib/ai/protocols/daily-report";
import type {
  AiProvider,
  AiProviderOptions,
  PromptOverrides,
  PromptRuntimeConfig,
} from "@/lib/ai/provider-types";

const MAX_DAILY_REPORT_REPAIR_TOKENS = 8192;

function resolvePromptConfig(
  type: PromptConfigType,
  runtimeOverride: PromptRuntimeConfig | undefined,
): PromptRuntimeConfig {
  const contract = getAiTaskContract(type);
  if (runtimeOverride) {
    return {
      // The persisted systemPrompt is legacy data and is deliberately ignored.
      systemPrompt: contract.systemPrompt,
      userInstruction: type === "daily_report"
        ? ""
        : normalizeAiUserInstruction(
            runtimeOverride.userInstruction ?? runtimeOverride.promptTemplate ?? contract.defaultUserInstruction,
          ),
      templateJson: runtimeOverride.templateJson ?? null,
      temperature: runtimeOverride.temperature,
      maxTokens: runtimeOverride.maxTokens,
      topP: runtimeOverride.topP,
      modelApi: runtimeOverride.modelApi,
    };
  }

  return {
    systemPrompt: contract.systemPrompt,
    userInstruction: type === "daily_report" ? "" : contract.defaultUserInstruction,
  };
}

/**
 * 判定/抽取类任务的采样温度由代码固定为 0：这类任务的输出直接进入排序、
 * 归组等确定性管线，温度稳定性是契约的一部分，不允许被行配置漂移破坏
 * （行值清空为 null 时不发送字段会落到 API 默认 ~1.0）。生成类任务
 * （cluster_summary、daily_report）仍允许配置。
 * 该集合同时传给网关（引擎侧强制）——双层防护，迁移期任一侧存在都成立。
 */
const TEMPERATURE_LOCKED_PROMPT_TYPES: ReadonlySet<string> = new Set<string>([
  "item_understanding",
  "cluster_match",
  "cluster_merge",
  "daily_report_review",
  "entity_alias_check",
]);

function applySamplingContract(
  type: PromptConfigType,
  config: PromptRuntimeConfig,
): PromptRuntimeConfig {
  if (!TEMPERATURE_LOCKED_PROMPT_TYPES.has(type)) {
    return config;
  }
  return { ...config, temperature: 0 };
}

/**
 * P1a：AiProvider 工厂的新引擎实现——HTTP 层切换到 @infinitum/ai 模型网关
 * （@ai-sdk/openai-compatible），协议解析/提示词契约保留在主仓。
 * 对调用方的接口与原 provider.ts 完全一致。
 */
export function createAiProvider(
  config: RuntimeConfig["modelApi"],
  promptOverrides?: PromptOverrides | null,
  clientOverrideArg?: unknown | null,
  options?: AiProviderOptions,
): AiProvider {
  const gateway = createModelGateway({
    defaultModelApi: config as never,
    transport: clientOverrideArg
      ? createCompatClientTransport(clientOverrideArg, { maxRetries: 1 })
      : createAiSdkTransport({ maxRetries: 1, supportsStructuredOutputs: true }),
    normalizeText: normalizeModelResponseText,
    temperatureLockedTaskTypes: TEMPERATURE_LOCKED_PROMPT_TYPES,
    circuitBreaker: {
      failureThreshold: MODEL_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      windowMs: MODEL_API_CIRCUIT_BREAKER_WINDOW_MS,
      openMs: MODEL_API_CIRCUIT_BREAKER_OPEN_MS,
    },
    onAttempt: (event) => options?.onAttempt?.(event),
    onUsage: (usage, usageKey) => {
      options?.onUsage?.(
        {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          cachedTokens: usage.cachedTokens,
          tokenUsageSource: usage.tokenUsageSource,
          model: usage.model,
          attemptType: usage.attemptType === "stage_context" ? "initial" : usage.attemptType,
          step: usage.step,
        },
        usageKey,
      );
    },
  });

  const embedTexts = createEmbedTexts(options?.embedding);
  const aggregationSplitMaxEvents = normalizeAggregationSplitMaxEvents(options?.aggregationSplitMaxEvents);
  const resolvedItemUnderstandingConfig = resolvePromptConfig(
    "item_understanding",
    promptOverrides?.itemUnderstanding,
  );
  // 评分规则始终存在：未配置或配置无效时回退到内置默认，保证评分标准
  // 全局一致，而不是回落到无锚点的单字段打分。
  const itemUnderstandingQualityRubric = parseQualityRubricJson(resolvedItemUnderstandingConfig.templateJson)
    ?? DEFAULT_QUALITY_RUBRIC;
  const itemUnderstandingSystemPrompt = [
    resolvedItemUnderstandingConfig.systemPrompt
      .replaceAll("{{maxEvents}}", String(aggregationSplitMaxEvents))
      .trim(),
    renderQualityRubricPrompt(itemUnderstandingQualityRubric),
    ITEM_UNDERSTANDING_FIXED_OUTPUT_RULE,
  ].filter(Boolean).join("\n\n");
  const itemUnderstandingConfig = applySamplingContract("item_understanding", promptOverrides?.itemUnderstanding
    ? { ...resolvedItemUnderstandingConfig, systemPrompt: itemUnderstandingSystemPrompt }
    // 无配置行时补齐代码默认采样预算；temperature 由 sampling 契约固定。
    : { ...resolvedItemUnderstandingConfig, systemPrompt: itemUnderstandingSystemPrompt, maxTokens: 8000 });
  const clusterSummaryConfig = resolvePromptConfig(
    "cluster_summary",
    promptOverrides?.clusterSummary,
  );
  const clusterMatchConfig = applySamplingContract(
    "cluster_match",
    resolvePromptConfig("cluster_match", promptOverrides?.clusterMatch),
  );
  const clusterMergeConfig = applySamplingContract(
    "cluster_merge",
    resolvePromptConfig("cluster_merge", promptOverrides?.clusterMerge),
  );
  // 实体别名判定刻意不接 selectedPromptConfigs 覆盖：判定语义由默认提示词固化，
  // admin 改提示词配置不影响该通道（需要时再接覆盖管线）。
  const entityAliasCheckConfig = applySamplingContract("entity_alias_check", {
    ...resolvePromptConfig("entity_alias_check", undefined),
    // 无配置行时不发送 maxTokens 会落到模型上限；对齐废弃 sampling 常量的预算。
    maxTokens: 2000,
  });
  const dailyReportConfig = resolvePromptConfig(
    "daily_report",
    promptOverrides?.dailyReport,
  );
  const dailyReportReviewConfig = applySamplingContract(
    "daily_report_review",
    resolvePromptConfig(
      "daily_report_review",
      promptOverrides?.dailyReportReview ?? undefined,
    ),
  );

  function buildJsonRequest(
    promptConfig: PromptRuntimeConfig,
    taskType: string,
    userContent: string,
    usageKey = taskType,
    schema?: JsonCompleteRequest["schema"],
  ): JsonCompleteRequest {
    return {
      taskType,
      systemPrompt: promptConfig.systemPrompt,
      userContent,
      temperature: promptConfig.temperature,
      maxTokens: promptConfig.maxTokens,
      topP: promptConfig.topP,
      modelApi: (promptConfig.modelApi ?? undefined) as JsonCompleteRequest["modelApi"],
      usageKey,
      schema,
      step: options?.step,
    };
  }

  const buildDailyReportStageConfig = (stage: string, contract: string): PromptRuntimeConfig => ({
    ...dailyReportConfig,
    systemPrompt: [
      "你是中文 AI 新闻日报流水线的阶段执行器。只基于输入内容工作，不补造事实。",
      `当前阶段：${stage}。只执行当前阶段职责，不执行其他阶段职责。${contract}`,
      DAILY_REPORT_JSON_SYNTAX_RULE,
      "最终只输出本阶段合同要求的合法 JSON 对象，不要输出 Markdown、代码块或解释。",
    ].filter(Boolean).join("\n\n"),
  });

  return {
    async understandItem(inputText, metadata) {
      const fallback = getFallbackUnderstanding(metadata);
      const userContent = buildAiUserContent(itemUnderstandingConfig.userInstruction, {
        title: metadata.title,
        sourceName: metadata.sourceName ?? "未知来源",
        translateTitle: metadata.translateTitle,
        inputText,
      });
      const result = await gateway.completeJson(
        buildJsonRequest(itemUnderstandingConfig, "item_understanding", userContent),
        (output) => parseItemUnderstandingOutput(
          output,
          inputText,
          fallback,
          metadata.translateTitle,
          aggregationSplitMaxEvents,
          itemUnderstandingQualityRubric,
        ),
      );

      if (result == null) {
        return fallback;
      }

      return result;
    },
    async summarizeCluster(inputText, metadata) {
      const userContent = buildAiUserContent(clusterSummaryConfig.userInstruction, {
        title: metadata.title,
        inputText,
      });
      const output = await gateway.completeJson(
        buildJsonRequest(clusterSummaryConfig, "cluster_summary", userContent),
        parseClusterSummaryOutput,
      );

      return output ?? "";
    },
    async matchClusterCandidate(inputText, metadata) {
      if (metadata.candidates.length === 0) {
        return null;
      }

      const userContent = buildAiUserContent(clusterMatchConfig.userInstruction, {
        title: metadata.title,
        inputText,
        candidates: metadata.candidates,
      });

      return gateway.completeJson(
        buildJsonRequest(clusterMatchConfig, "cluster_match", userContent, "cluster_match", CLUSTER_MATCH_SCHEMA),
        (output) => parseClusterMatchCandidateId(
          output,
          metadata.candidates.map((candidate) => candidate.id),
        ),
      ).catch((error) => {
        if (isInvalidJsonModelResponseError(error)) {
          return null;
        }
        throw error;
      });
    },
    async assessEntityAliasPairs(input) {
      if (input.pairs.length === 0) {
        return [];
      }

      const userContent = buildAiUserContent(entityAliasCheckConfig.userInstruction, {
        pairs: input.pairs.map((pair) => ({ a: pair.aName, b: pair.bName, evidence: pair.evidence })),
      });

      return (
        (await gateway.completeJson(
          buildJsonRequest(entityAliasCheckConfig, "entity_alias_check", userContent, "entity_alias_check", ENTITY_ALIAS_DECISIONS_SCHEMA),
          (output) => parseEntityAliasDecisions(output, input.pairs),
        )) ?? []
      );
    },
    async assessClusterMergePairs(clustersJson) {
      const metadata = parseClusterMergeInputMetadata(clustersJson);
      const userContent = buildAiUserContent(
        clusterMergeConfig.userInstruction,
        compactClusterMergeInputForModel(clustersJson),
      );

      const decisions = await gateway.completeJson(
        buildJsonRequest(clusterMergeConfig, "cluster_merge", userContent),
        (output) => parseClusterMergeDecisions(output, metadata),
      );

      return decisions ?? [];
    },
    async assessDailyReportCandidates(input) {
      const promptConfig = buildDailyReportStageConfig(
          "ASSESS",
          "不得写正文、不得合并主题、不得重新编号或遗漏候选；必须逐一返回输入中的每个 candidateId。只返回 candidateId、isWorthReading、relevanceScore、suggestedBlockKey、historyDecision、matchedRecentTopicTitle 六个字段。suggestedBlockKey 必须来自模板 sections 或为 null；historyDecision 必须是 new、duplicate、follow_up、uncertain 之一。historyDecision=duplicate 时 matchedRecentTopicTitle 填写命中的历史主题标题，否则为 null。若 historyDecision=duplicate，isWorthReading 必须为 false。",
        );
      const userContent = buildDailyReportStagePrompt(
          "ASSESS",
          "逐一评估输入中的每个 candidateId。每个候选必须返回一次，不得新增或遗漏 ID。返回 {assessments:[{candidateId,isWorthReading,relevanceScore,suggestedBlockKey,historyDecision,matchedRecentTopicTitle}]}。只做选题评估和历史重复判断，不写正文，不合并主题。",
          {
            template: buildDailyReportAssessmentTemplate(input.template, input.recentTopicLookbackDays),
            input: {
              candidates: input.candidates.map(compactDailyReportModelCandidate),
              recentTopics: input.recentTopics.map(compactDailyReportRecentTopic),
            },
          },
          `${DAILY_REPORT_CANDIDATE_FIELD_GUIDE}\n${DAILY_REPORT_ASSESSMENT_FIELD_GUIDE}`,
        );
      const output = input.stageContext
        ? await gateway.completeJson(
            { ...buildJsonRequest(promptConfig, "daily_report_assess", userContent, "daily_report_assess"), stageContext: input.stageContext as never, validationFeedback: input.validationFeedback as never },
            parseAssessmentOutput,
          )
        : await gateway.completeJson(buildJsonRequest(promptConfig, "daily_report_assess", userContent, "daily_report_assess"), parseAssessmentOutput);
      return output ?? [];
    },
    async planDailyReport(input) {
      const promptConfig = buildDailyReportStageConfig(
          "PLAN",
          `必须返回 schemaVersion=2；template.sections 是唯一可规划栏目清单；sections 中的 blockKey 只能使用 template.sections[].blockKey，禁止使用 text、type、栏目标题或自造 key；text block 不属于 sections。每个 topics[].candidateIds 必须非空；一个 candidateId 只能属于一个 topic。topicId 由代码生成，不要输出。若输入包含 reviewFeedback，必须优先根据其中的 guidance 修复对应问题，并继续遵守 candidateBriefs、template 和 recentTopics 的输入边界。\n${DAILY_REPORT_PLAN_TOPIC_CONTRACT}`,
        );
      const userContent = buildDailyReportStagePrompt(
          "PLAN",
          `基于所有 candidateBriefs 做全局选题、主题归纳和栏目分配。先按“一个独立事实对应一个 topic”的规则判断候选是否属于同一主题，再决定主题是否入选和放入哪个栏目。${DAILY_REPORT_PLAN_TOPIC_CONTRACT} 综合摘要、事件线索、来源数量、日期相关性、后续进展、近期重复和评分信号，不要只按单一分数排序。输出的每个 section.blockKey 必须逐字复制 template.sections[].blockKey；每个 section 的 topics 数量必须在对应模板的 minItems 与 maxItems 之间，可选栏目在可规划候选充足且有足够高价值候选时，应尽量接近 maxItems，但不能为了凑数选择低价值候选。一个 topics[].candidateIds 数组表示同一个最终日报主题的候选事实或互证来源；每个候选只能出现在一个主题中。只返回 {schemaVersion:2,sections:[{blockKey,topics:[{candidateIds:[number]}]}]}。不要输出主题编号、栏目展示名、标题、理由或其他字段；不得写正文、不得创建输入之外的候选或栏目，不得输出 text block。`,
          {
            template: buildDailyReportPlanningTemplate(input.template, input.recentTopicLookbackDays),
            input: {
              candidateBriefs: input.candidateBriefs,
              recentTopics: (input.recentTopics ?? []).map(compactDailyReportRecentTopic),
              ...(input.reviewFeedback ? { reviewFeedback: input.reviewFeedback } : {}),
            },
          },
          `${DAILY_REPORT_PLAN_TOPIC_CONTRACT}\n${DAILY_REPORT_PLAN_FIELD_GUIDE}\n${DAILY_REPORT_REVIEW_FEEDBACK_GUIDE}`,
        );
      const output = input.stageContext
        ? await gateway.completeJson(
            { ...buildJsonRequest(promptConfig, "daily_report_plan", userContent, "daily_report_plan"), stageContext: input.stageContext as never, validationFeedback: input.validationFeedback as never },
            parsePlanOutput,
          )
        : await gateway.completeJson(buildJsonRequest(promptConfig, "daily_report_plan", userContent, "daily_report_plan"), parsePlanOutput);
      if (!output) throw new Error("PLAN 阶段没有返回结果。");
      return output;
    },
    async writeDailyReport(input) {
      const selectedBlockKeys = Array.from(new Set(input.selectedTopics.map((topic) => topic.blockKey)));
      const promptConfig = buildDailyReportStageConfig(
          "WRITE",
          "只能使用 selectedTopics 中的主题和候选；不得重新归纳主题、换栏目、增加栏目或补造事实。若输入包含 reviewFeedback，必须优先根据其中的 guidance 修复对应问题，并继续遵守 selectedTopics、template 和候选事实边界。输出对象本身就是日报内容，顶层必须直接包含 headline 和 blocks，合法结构为 {\"headline\":\"...\",\"blocks\":[...]}；禁止输出 draft、result、data、output 等外层包装键。text block 返回 {type:\"text\",title,body}，section block 返回 {type:\"section\",blockKey,title,items}，item 返回 {topicId,title,body,notes}；每个 selectedTopics 必须生成一个 item，topicId 必须原样复制；不要输出 sourceIds、candidateIds 或其他来源映射字段；notes 必须是 {label:string,text:string} 数组，模板中的 required 和 instruction 只是规则元数据，绝不能原样输出到 notes；模板中 required=true 的 note 必须按模板 label 原样输出且 text 非空，required=false 的 note 可按内容需要输出；只使用模板中定义的 text block 和已规划的 section block。正文只写内容本身，不要带栏目名、字段名或标签前缀；除模板允许的加粗和斜体外，不要输出链接、图片、标题、表格、列表或其他 Markdown 结构。",
        );
      const userContent = buildDailyReportStagePrompt(
          "WRITE",
          "严格按照 selectedTopics 和对应 Block 写作，只返回完整日报内容 JSON。输出对象本身就是日报内容，顶层直接包含 headline 和 blocks，不得包在 draft、result、data 或 output 字段中。不得重新选题、合并主题、换栏目、增加栏目或补造事实。每个 section block 必须包含与输入一致的 blockKey 和模板 title；每个 section item 必须包含 topicId、title、body 和 notes，不要输出 sourceIds 或 candidateIds；每个计划主题必须且只能对应一个 item；当模板中该栏目 item.bodyRequired=false 时 body 必须为空字符串或省略，不能输出正文，否则 body 必须非空；每个 notes 元素只能是 {label,text}，不要输出 required 或 instruction；notes 中必须包含模板配置的全部 required=true note，label 必须逐字匹配、text 必须非空；每个 text block 必须包含 type、title、body。",
          { template: buildDailyReportWritingTemplate(input.template, selectedBlockKeys), input: {
            selectedTopics: input.selectedTopics.map((topic) => ({
              topicId: topic.topicId,
              blockKey: topic.blockKey,
              requiredNotes: getRequiredNotesForBlock(input.template, topic.blockKey),
              candidates: topic.candidates.map(compactDailyReportWritingCandidate),
            })),
            ...(input.reviewFeedback ? { reviewFeedback: input.reviewFeedback } : {}),
          } },
          `${DAILY_REPORT_WRITE_FIELD_GUIDE}\n${DAILY_REPORT_REVIEW_FEEDBACK_GUIDE}`,
        );
      const output = input.stageContext
        ? await gateway.completeJson(
            { ...buildJsonRequest(promptConfig, "daily_report_write", userContent, "daily_report_write"), stageContext: input.stageContext as never, validationFeedback: input.validationFeedback as never },
            parseDraftOutput,
          )
        : await gateway.completeJson(buildJsonRequest(promptConfig, "daily_report_write", userContent, "daily_report_write"), parseDraftOutput);
      if (!output) throw new Error("WRITE 阶段没有返回结果。");
      return output;
    },
    async repairDailyReportDraft(input) {
      const unsupportedViolations = input.violations.filter(
        (violation) => !isDailyReportNotesRepairableViolation(violation),
      );
      if (unsupportedViolations.length > 0) {
        throw new Error("REPAIR notes patch 只支持修复 draft_required_note_missing，不支持修改日报结构。");
      }

      const affectedTopicIds = new Set(
        input.violations
          .map((violation) => violation.topicId)
          .filter((topicId): topicId is string => Boolean(topicId)),
      );
      const repairTargets = input.selectedTopics
        .filter((topic) => affectedTopicIds.size === 0 || affectedTopicIds.has(topic.topicId))
        .map((topic) => ({
          topicId: topic.topicId,
          blockKey: topic.blockKey,
          candidateIds: topic.candidateIds,
          requiredNotes: getRequiredNotesForBlock(input.template, topic.blockKey),
          candidates: topic.candidates.map(compactDailyReportWritingCandidate),
        }));
      const repairPromptConfig: PromptRuntimeConfig = {
        ...buildDailyReportStageConfig(
          "REPAIR",
          "只修复输入 violations 中列出的问题，不改变已有正文、主题、候选、栏目和顺序。REPAIR 只返回 notes 补丁，不返回完整日报草稿；合法结构为 {\"patches\":[{\"topicId\":\"...\",\"notes\":[{\"label\":\"...\",\"text\":\"...\"}]}]}。topicId 必须来自 repairTargets，notes 的 label 必须来自对应 requiredNotes，不能新增主题、候选、栏目或字段。补丁文本只能使用 repairTargets 中的候选事实，不得编造。每条 violation 都必须有对应补丁或已经由现有内容满足。",
        ),
        temperature: 0,
        maxTokens: Math.min(dailyReportConfig.maxTokens ?? 4096, MAX_DAILY_REPORT_REPAIR_TOKENS),
      };
      const output = await gateway.completeJson(
        buildJsonRequest(
          repairPromptConfig,
          "daily_report_repair",
          buildDailyReportStagePrompt(
            "REPAIR",
            "只修复 violations 中列出的问题。返回 notes 补丁，不要返回 headline、blocks、draft、result、data 或 output；每个补丁必须定位到 violations 中的 topicId，并使用 repairTargets 对应候选事实补齐缺失的 required note。相同主题有多个缺失要点时必须在同一个补丁中逐条补齐；只输出 {patches:[{topicId,notes:[{label,text}]}]}。",
            {
              template: buildDailyReportWritingTemplate(input.template, input.selectedTopics.map((topic) => topic.blockKey)),
              input: {
                draft: compactDailyReportRepairDraft(input.draft),
                violations: input.violations,
                missingNotes: input.violations
                  .filter((violation) => violation.topicId && violation.noteLabel)
                  .map((violation) => ({
                    topicId: violation.topicId,
                    noteLabel: violation.noteLabel,
                    blockKey: violation.blockKey,
                    noteInstruction: violation.noteInstruction,
                  })),
                repairTargets,
              },
            },
            DAILY_REPORT_REPAIR_FIELD_GUIDE,
          ),
        ),
        parseRepairPatchOutput,
      );
      if (!output) throw new Error("REPAIR 阶段没有返回补丁。");
      return output;
    },
    async reviewDailyReport(input) {
      const customInstruction = normalizeAiUserInstruction(dailyReportReviewConfig.userInstruction);
      const userContent = [
        customInstruction,
        "以下是由系统生成的审核输入 JSON，请只基于其中的内容进行审核：",
        JSON.stringify(input),
      ].filter(Boolean).join("\n\n");
      const output = await gateway.completeJson(
        {
          ...buildJsonRequest(
            {
              ...dailyReportReviewConfig,
              // The Review system contract is owned by the application.
              // A persisted systemPrompt is legacy data and is not user-overridable.
              systemPrompt: DEFAULT_DAILY_REPORT_REVIEW_PROMPT,
            },
            "daily_report_review",
            userContent,
          ),
        },
        parseReviewOutput,
      );
      if (!output) throw new Error("REVIEW 阶段没有返回结果。");
      const knownTopicIds = new Set(input.selectedTopics.map((topic) => topic.topicId));
      const knownCandidateIds = new Set([
        ...input.selectedTopics.flatMap((topic) => topic.candidateIds),
        ...input.candidatePool.topUnselectedCandidates.map((candidate) => candidate.candidateId),
      ]);
      for (const violation of output.violations) {
        if (violation.topicIds?.some((topicId) => !knownTopicIds.has(topicId))) {
          throw new InvalidJsonModelResponseError("REVIEW violation 引用了不存在的 topicId。");
        }
        if (violation.candidateIds?.some((candidateId) => !knownCandidateIds.has(candidateId))) {
          throw new InvalidJsonModelResponseError("REVIEW violation 引用了不在审核输入中的 candidateId。");
        }
      }
      if (output.verdict === "pass" && output.violations.some((violation) => violation.severity === "error")) {
        return {
          ...output,
          verdict: "reject",
          summary: output.summary || "Review 返回了错误级问题。",
        };
      }
      if (output.verdict === "reject" && !output.violations.some((violation) => violation.severity === "error")) {
        throw new InvalidJsonModelResponseError("REVIEW reject 必须包含至少一个 error 级 violation。");
      }
      return output;
    },
    embedTexts,
  };
}
