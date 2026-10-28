import {
  CLUSTER_MERGE_PAIR_ID_OUTPUT_RULE,
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
import { AI_OPERATION_REGISTRY, assertAiOperation } from "@/lib/ai/operations";
import { DAILY_REPORT_NEUTRAL_REVIEW_PROMPT } from "@/lib/daily-report/protocol-prompts";
import { isDailyReportNotesRepairableViolation } from "@/lib/daily-report/types";
import { normalizeModelResponseText } from "@/lib/ai/response-format";
import { buildEnabledEventTypeResolver } from "@/lib/event-types/resolve";
import { InvalidJsonModelResponseError, isInvalidJsonModelResponseError, getJsonParseErrorMessage } from "@/lib/ai/provider-types";
import { createRequestAudit, getRequestAuditContext, type RequestAudit } from "@/lib/ai/request-audit";
import { createAiModelRuntime } from "@infinitum/ai/provider/runtime";
import { createAiOperationRunner } from "@infinitum/ai/provider/operations";
import { createAiSdkTransport, createCompatClientTransport } from "@infinitum/ai/provider/transports";
import { CLUSTER_MATCH_SCHEMA, CLUSTER_MERGE_DECISIONS_SCHEMA } from "@/lib/ai/protocols/cluster";
import { ENTITY_ALIAS_DECISIONS_SCHEMA } from "@/lib/ai/protocols/entity-alias";
import type { JsonCompleteRequest, StageContext, StageValidationFeedback } from "@infinitum/ai/provider/types";
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
  DAILY_REPORT_STAGE_CONTRACTS,
  DAILY_REPORT_STAGE_INSTRUCTIONS,
  DAILY_REPORT_STAGE_ROLE,
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
  DailyReportStageContext,
  DailyReportStageValidationFeedback,
  PromptOverrides,
  PromptRuntimeConfig,
} from "@/lib/ai/provider-types";

const MAX_DAILY_REPORT_REPAIR_TOKENS = 8192;

function toGatewayStageContext(context: DailyReportStageContext): StageContext {
  // The gateway mutates the transcript in place between repair rounds. Keep
  // the business context identity instead of copying it into a detached DTO.
  return context;
}

function toGatewayValidationFeedback(
  feedback: DailyReportStageValidationFeedback | undefined,
): StageValidationFeedback | undefined {
  return feedback;
}

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
  // 请求审计（回执 + UTC 日硬上限）：身份在调用时解析——任务路径经 options.step
  // 归因；任务触发边界经审计 ALS 上下文（triggerTaskWorkflow）注入 taskRunId，
  // 复用的 provider 实例同样按调用时刻解析；admin 同步路径无任务身份时同样
  // 插桩（taskRunId 为空，不做同任务阻断）。
  const knownSecrets = [
    config.apiKey,
    ...Object.values(promptOverrides ?? {}).map((override) => override?.modelApi?.apiKey),
  ];
  const requestAudit: RequestAudit | null = options?.requestAudit !== undefined
    ? options.requestAudit
    : createRequestAudit(
      () => options?.step
        ? {
          taskRunId: options.step.taskRunId ?? null,
          stepId: options.step.stepId ?? null,
          workflowId: options.step.workflowId ?? null,
          workflowRunId: options.step.workflowRunId ?? null,
        }
        : getRequestAuditContext(),
      { knownSecrets },
    );
  const auditHooks = requestAudit ?? undefined;
  const gateway = createAiModelRuntime({
    defaultModelApi: config,
    transport: clientOverrideArg
      ? createCompatClientTransport(clientOverrideArg, { maxRetries: 1, auditHooks })
      : createAiSdkTransport({ maxRetries: 1, supportsStructuredOutputs: true, auditHooks }),
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
          cachedTokensReported: usage.cachedTokensReported,
          tokenUsageSource: usage.tokenUsageSource,
          model: usage.model,
          attemptType: usage.attemptType === "stage_context" ? "initial" : usage.attemptType,
          step: usage.step,
        },
        usageKey,
      );
    },
  }).gateway;
  const operations = createAiOperationRunner({ gateway, registry: AI_OPERATION_REGISTRY });

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
  // 可配置事件类型注册表：把启用类型（key/label/描述/别名）注入系统提示，
  // 并连同 fingerprint 一起进入请求身份；解析阶段共享同一快照。
  const eventTypeSnapshot = options?.eventTypeRegistry ?? null;
  const eventTypeResolver = eventTypeSnapshot
    ? buildEnabledEventTypeResolver(eventTypeSnapshot)
    : null;
  const eventTypePromptBlock = eventTypeSnapshot
    ? [
      `可用事件类型（eventType 注册表快照 fingerprint=${eventTypeSnapshot.fingerprint}）：`,
      ...eventTypeSnapshot.types.filter((type) => type.enabled).map((type) => {
        const aliases = type.aliases.length > 0 ? `；别名：${type.aliases.join("、")}` : "";
        const description = type.description ? `：${type.description}` : "";
        return `- ${type.key}（${type.label}${description}）${aliases}`;
      }),
      "eventType 只能取以上启用类型的 key 或其别名（系统会归一化为 key）；无法稳定判断整体事件时返回 null，不要自造其他值。",
    ].join("\n")
    : null;
  const itemUnderstandingSystemPrompt = [
    resolvedItemUnderstandingConfig.systemPrompt
      .replaceAll("{{maxEvents}}", String(aggregationSplitMaxEvents))
      .trim(),
    eventTypePromptBlock,
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

  /**
   * 解析层审计包装：InvalidJson 解析失败与 understandItem 的非抛出诊断
   * （summary/analysis/aggregation 校验不过）记录到对应回执；
   * 只记录，不引入额外修复调用、不改变既有解析/回退/summary 协议。
   */
  const auditedParse = <T>(operation: string, parse: (output: string) => T) =>
    async (output: string, meta: { requestId?: string }): Promise<T> => {
      try {
        const result = parse(output);
        if (operation === "item_understanding") {
          const diagnostics = (result as {
            diagnostics?: { summaryValid?: boolean; analysisValid?: boolean; aggregationValid?: boolean };
          } | null)?.diagnostics;
          if (diagnostics?.summaryValid === false) {
            await requestAudit?.recordParseDiagnostic({
              requestId: meta.requestId,
              kind: "invalid_summary",
              detail: "understanding 输出 summary 未通过校验（非抛出协议，按 fallback 语义处理）",
            });
          }
          if (diagnostics?.analysisValid === false) {
            await requestAudit?.recordParseDiagnostic({
              requestId: meta.requestId,
              kind: "invalid_analysis",
              detail: "understanding 输出 analysis 未通过校验（非抛出协议）",
            });
          }
          if (diagnostics?.aggregationValid === false) {
            await requestAudit?.recordParseDiagnostic({
              requestId: meta.requestId,
              kind: "invalid_aggregation",
              detail: "understanding 输出 aggregation 未通过校验（非抛出协议）",
            });
          }
        }
        return result;
      } catch (error) {
        if (isInvalidJsonModelResponseError(error)) {
          await requestAudit?.recordParseDiagnostic({
            requestId: meta.requestId,
            kind: "parse_failed",
            detail: getJsonParseErrorMessage(error),
          });
        }
        throw error;
      }
    };

  function buildJsonRequest(
    promptConfig: PromptRuntimeConfig,
    taskType: string,
    userContent: string,
    usageKey = taskType,
    schema?: JsonCompleteRequest["schema"],
  ): JsonCompleteRequest {
    const operation = assertAiOperation(usageKey);
    if (operation.key !== taskType) {
      throw new Error(`AI operation/task type mismatch: ${taskType} != ${operation.key}`);
    }
    return {
      taskType: operation.key,
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
      DAILY_REPORT_STAGE_ROLE,
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
        // 事件时间需要以发布时间为年份锚点：正文只给「X月X日」时模型无从推断年份。
        publishedAt: metadata.publishedAt ?? "未知",
        translateTitle: metadata.translateTitle,
        maxEvents: aggregationSplitMaxEvents,
        inputText,
      });
      const result = await operations.completeJson(
        buildJsonRequest(itemUnderstandingConfig, "item_understanding", userContent),
        auditedParse("item_understanding", (output) => parseItemUnderstandingOutput(
          output,
          inputText,
          fallback,
          metadata.translateTitle,
          aggregationSplitMaxEvents,
          itemUnderstandingQualityRubric,
          metadata.publishedAt,
          eventTypeResolver,
        )),
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
      const output = await operations.completeJson(
        buildJsonRequest(clusterSummaryConfig, "cluster_summary", userContent),
        auditedParse("cluster_summary", parseClusterSummaryOutput),
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

      return operations.completeJson(
        buildJsonRequest(clusterMatchConfig, "cluster_match", userContent, "cluster_match", CLUSTER_MATCH_SCHEMA),
        auditedParse("cluster_match", (output) => parseClusterMatchCandidateId(
          output,
          metadata.candidates.map((candidate) => candidate.id),
        )),
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
        (await operations.completeJson(
          buildJsonRequest(entityAliasCheckConfig, "entity_alias_check", userContent, "entity_alias_check", ENTITY_ALIAS_DECISIONS_SCHEMA),
          auditedParse("entity_alias_check", (output) => parseEntityAliasDecisions(output, input.pairs)),
        )) ?? []
      );
    },
    async assessClusterMergePairs(clustersJson) {
      const metadata = parseClusterMergeInputMetadata(clustersJson);
      const userContent = buildAiUserContent(
        clusterMergeConfig.userInstruction,
        compactClusterMergeInputForModel(clustersJson),
      );

      const systemPrompt = clusterMergeConfig.systemPrompt.includes(CLUSTER_MERGE_PAIR_ID_OUTPUT_RULE)
        ? clusterMergeConfig.systemPrompt
        : `${clusterMergeConfig.systemPrompt}\n\n${CLUSTER_MERGE_PAIR_ID_OUTPUT_RULE}`;
      const decisions = await operations.completeJson(
        buildJsonRequest(
          { ...clusterMergeConfig, systemPrompt },
          "cluster_merge",
          userContent,
          "cluster_merge",
          CLUSTER_MERGE_DECISIONS_SCHEMA,
        ),
        auditedParse("cluster_merge", (output) => parseClusterMergeDecisions(output, metadata)),
      );

      return decisions ?? [];
    },
    async assessDailyReportCandidates(input) {
      const promptConfig = buildDailyReportStageConfig(
          "ASSESS",
          DAILY_REPORT_STAGE_CONTRACTS.ASSESS
        );
      const userContent = buildDailyReportStagePrompt(
          "ASSESS",
          DAILY_REPORT_STAGE_INSTRUCTIONS.ASSESS,
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
        ? await operations.completeJson(
            { ...buildJsonRequest(promptConfig, "daily_report_assess", userContent, "daily_report_assess"), stageContext: toGatewayStageContext(input.stageContext), validationFeedback: toGatewayValidationFeedback(input.validationFeedback) },
            auditedParse("daily_report_assess", parseAssessmentOutput),
          )
        : await operations.completeJson(buildJsonRequest(promptConfig, "daily_report_assess", userContent, "daily_report_assess"), auditedParse("daily_report_assess", parseAssessmentOutput));
      return output ?? [];
    },
    async planDailyReport(input) {
      const promptConfig = buildDailyReportStageConfig(
          "PLAN",
          DAILY_REPORT_STAGE_CONTRACTS.PLAN,
        );
      const userContent = buildDailyReportStagePrompt(
          "PLAN",
          DAILY_REPORT_STAGE_INSTRUCTIONS.PLAN,
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
        ? await operations.completeJson(
            { ...buildJsonRequest(promptConfig, "daily_report_plan", userContent, "daily_report_plan"), stageContext: toGatewayStageContext(input.stageContext), validationFeedback: toGatewayValidationFeedback(input.validationFeedback) },
            auditedParse("daily_report_plan", parsePlanOutput),
          )
        : await operations.completeJson(buildJsonRequest(promptConfig, "daily_report_plan", userContent, "daily_report_plan"), parsePlanOutput);
      if (!output) throw new Error("PLAN 阶段没有返回结果。");
      return output;
    },
    async writeDailyReport(input) {
      const selectedBlockKeys = Array.from(new Set(input.selectedTopics.map((topic) => topic.blockKey)));
      const promptConfig = buildDailyReportStageConfig(
          "WRITE",
          DAILY_REPORT_STAGE_CONTRACTS.WRITE,
        );
      const userContent = buildDailyReportStagePrompt(
          "WRITE",
          DAILY_REPORT_STAGE_INSTRUCTIONS.WRITE,
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
        ? await operations.completeJson(
            { ...buildJsonRequest(promptConfig, "daily_report_write", userContent, "daily_report_write"), stageContext: toGatewayStageContext(input.stageContext), validationFeedback: toGatewayValidationFeedback(input.validationFeedback) },
            auditedParse("daily_report_write", parseDraftOutput),
          )
        : await operations.completeJson(buildJsonRequest(promptConfig, "daily_report_write", userContent, "daily_report_write"), parseDraftOutput);
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
          DAILY_REPORT_STAGE_CONTRACTS.REPAIR,
        ),
        temperature: 0,
        maxTokens: Math.min(dailyReportConfig.maxTokens ?? 4096, MAX_DAILY_REPORT_REPAIR_TOKENS),
      };
      const output = await operations.completeJson(
        buildJsonRequest(
          repairPromptConfig,
          "daily_report_repair",
          buildDailyReportStagePrompt(
            "REPAIR",
            DAILY_REPORT_STAGE_INSTRUCTIONS.REPAIR,
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
        auditedParse("daily_report_repair", parseRepairPatchOutput),
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
      const output = await operations.completeJson(
        {
          ...buildJsonRequest(
            {
              ...dailyReportReviewConfig,
              // The Review system contract is owned by the application.
              // A persisted systemPrompt is legacy data and is not user-overridable.
              systemPrompt: DAILY_REPORT_NEUTRAL_REVIEW_PROMPT,
            },
            "daily_report_review",
            userContent,
          ),
        },
        auditedParse("daily_report_review", parseReviewOutput),
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
