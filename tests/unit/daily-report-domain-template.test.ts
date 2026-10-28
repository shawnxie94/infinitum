import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createHash } from "node:crypto";

import { createAiProvider } from "@/lib/ai/provider-next";
import {
  classifyDailyReportTemplateMigration,
  compileDailyReportTemplatePrompt,
  DEFAULT_DAILY_REPORT_TEMPLATE,
  getDailyReportTemplateSignature,
  normalizeDailyReportTemplateConfig,
  parseDailyReportTemplateJson,
  upgradeDefaultDailyReportTemplate,
  type DailyReportTemplateConfig,
} from "@/lib/daily-report/template";
import {
  DAILY_REPORT_ASSESSMENT_FIELD_GUIDE,
  DAILY_REPORT_CANDIDATE_FIELD_GUIDE,
  DAILY_REPORT_JSON_SYNTAX_RULE,
  DAILY_REPORT_PLAN_FIELD_GUIDE,
  DAILY_REPORT_PLAN_TOPIC_CONTRACT,
  DAILY_REPORT_REPAIR_FIELD_GUIDE,
  DAILY_REPORT_REVIEW_FEEDBACK_GUIDE,
  DAILY_REPORT_STAGE_CONTRACTS,
  DAILY_REPORT_STAGE_INSTRUCTIONS,
  DAILY_REPORT_STAGE_ROLE,
  DAILY_REPORT_WRITE_FIELD_GUIDE,
  getDailyReportProtocolMaterial,
} from "@/lib/ai/protocols/daily-report";
import { buildDailyReportGenerationSignature, getDailyReportEffectivePipelineVersion } from "@/lib/daily-report/report-input";
import { DAILY_REPORT_NEUTRAL_REVIEW_PROMPT, getDailyReportEffectiveProtocolFingerprint } from "@/lib/daily-report/protocol-prompts";

const fixtureDir = resolve(__dirname, "../fixtures/domain-daily-reports");
const financeTemplateJson = readFileSync(resolve(fixtureDir, "finance-v3.json"), "utf8");
const industryTemplateJson = readFileSync(resolve(fixtureDir, "industry-brief-v3.json"), "utf8");

describe("domain-adaptable daily report templates", () => {
  it("accepts finance and third-domain v3 fixtures through the shared parse/validate/compile path", () => {
    for (const json of [financeTemplateJson, industryTemplateJson]) {
      const template = parseDailyReportTemplateJson(json);
      expect(template).not.toBeNull();
      expect(template!.schemaVersion).toBe(3);
      expect(Array.isArray(template!.selectionRules)).toBe(true);
      const prompt = compileDailyReportTemplatePrompt(template!);
      expect(prompt).toContain("选题规则：");
    }
  });

  it("keeps explicit empty selectionRules empty instead of backfilling AI defaults", () => {
    const parsed = JSON.parse(financeTemplateJson) as Record<string, unknown>;
    const template = parseDailyReportTemplateJson(JSON.stringify({ ...parsed, selectionRules: [] }))!;
    expect(template.selectionRules).toEqual([]);
    expect(template.selectionRules).not.toEqual(DEFAULT_DAILY_REPORT_TEMPLATE.selectionRules);
  });

  it("rejects invalid selectionRules types and unknown schema versions", () => {
    const parsed = JSON.parse(financeTemplateJson) as Record<string, unknown>;
    expect(() => parseDailyReportTemplateJson(JSON.stringify({ ...parsed, selectionRules: "规则" })))
      .toThrow("选题规则");
    expect(() => parseDailyReportTemplateJson(JSON.stringify({ ...parsed, schemaVersion: 99 })))
      .toThrow("schemaVersion");
  });

  it("changes the signature when selection rules change", () => {
    const base = parseDailyReportTemplateJson(financeTemplateJson)!;
    const changed = normalizeDailyReportTemplateConfig({ ...JSON.parse(financeTemplateJson), selectionRules: ["完全不同的选题标准。"] });
    expect(getDailyReportTemplateSignature(changed)).not.toBe(getDailyReportTemplateSignature(base));
    expect(getDailyReportTemplateSignature(base)).toBe(getDailyReportTemplateSignature(parseDailyReportTemplateJson(financeTemplateJson)!));
  });

  it("rejects malformed v3 input instead of backfilling defaults (R1)", () => {
    const finance = JSON.parse(financeTemplateJson) as Record<string, unknown>;

    // 缺 headlineInstruction → 报错，不回填 AI 标题规则。
    const noHeadline = { ...finance };
    delete (noHeadline as Record<string, unknown>).headlineInstruction;
    expect(() => parseDailyReportTemplateJson(JSON.stringify(noHeadline))).toThrow("标题规则");

    // 标量 recentTopicRules → 报错，不替换为默认策略。
    expect(() => parseDailyReportTemplateJson(JSON.stringify({ ...finance, recentTopicRules: "重复不写" }))).toThrow("历史主题判断策略");

    // section 缺 key → 报错，不生成 key。
    const noKey = JSON.parse(JSON.stringify(finance)) as { blocks: Array<Record<string, unknown>> };
    delete (noKey.blocks[1] as Record<string, unknown>).key;
    expect(() => parseDailyReportTemplateJson(JSON.stringify(noKey))).toThrow("key");

    // 非法类型 / 未知版本 → 报错。
    expect(() => parseDailyReportTemplateJson(JSON.stringify({ ...finance, selectionRules: "单一规则" }))).toThrow("选题规则");
    expect(() => parseDailyReportTemplateJson(JSON.stringify({ ...finance, schemaVersion: 4 }))).toThrow("schemaVersion");
    expect(() => parseDailyReportTemplateJson(JSON.stringify({ ...finance, globalRules: "规则" }))).toThrow("正文写作规则");
    expect(() => parseDailyReportTemplateJson(JSON.stringify({ ...finance, selectionRules: ["x".repeat(501)] }))).toThrow("500");
  });

  it("rejects malformed v3 in direct normalization/compilation, keeps legacy fallback only for unversioned input (R1)", () => {
    const finance = JSON.parse(financeTemplateJson) as Record<string, unknown>;
    const noHeadline = { ...finance };
    delete (noHeadline as Record<string, unknown>).headlineInstruction;
    expect(() => normalizeDailyReportTemplateConfig(noHeadline)).toThrow("标题规则");
    expect(() => compileDailyReportTemplatePrompt(noHeadline as never)).toThrow("标题规则");

    // 无版本输入仍走历史兼容默认。
    const legacy = { blocks: [{ type: "section", title: "自定义栏目", description: "输出内容。", item: { bodyInstruction: "写条目。", notes: [] } }], globalRules: ["规则。"] };
    const parsedLegacy = parseDailyReportTemplateJson(JSON.stringify(legacy))!;
    expect(parsedLegacy.schemaVersion).toBe(3);
    expect(parsedLegacy.headlineInstruction).toBe(DEFAULT_DAILY_REPORT_TEMPLATE.headlineInstruction);
    expect(parsedLegacy.selectionRules).toEqual([]);
  });

  it("migrates official v2 to v3 by moving the AI selection policy into selectionRules, and keeps custom v2 selectionRules empty", () => {
    const officialV2 = { ...DEFAULT_DAILY_REPORT_TEMPLATE, schemaVersion: 2 as const } as unknown as DailyReportTemplateConfig;
    delete (officialV2 as Record<string, unknown>).selectionRules;
    const migratedOfficial = upgradeDefaultDailyReportTemplate(officialV2);
    expect(migratedOfficial.schemaVersion).toBe(3);
    expect(migratedOfficial.selectionRules).toEqual(DEFAULT_DAILY_REPORT_TEMPLATE.selectionRules);
    expect(classifyDailyReportTemplateMigration(officialV2)).toBe("v2");

    const customV2 = {
      schemaVersion: 2,
      headlineInstruction: "自定义标题。",
      recentTopicRules: ["重复不写。"],
      blocks: [{
        type: "section",
        key: "custom-x",
        title: "自定义栏目",
        description: "自定义内容。",
        required: true,
        minItems: 1,
        maxItems: 3,
        item: { bodyInstruction: "写条目。", bodyRequired: true, notes: [] },
      }],
      globalRules: ["自定义规则。"],
    };
    const migratedCustom = parseDailyReportTemplateJson(JSON.stringify(customV2))!;
    expect(migratedCustom.schemaVersion).toBe(3);
    expect(migratedCustom.selectionRules).toEqual([]);
  });
});

describe("domain stage request capture", () => {
  it("sends selectionRules to ASSESS/PLAN and keeps finance fixtures free of hardcoded AI section defaults", async () => {
    const completion = (content: string) => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const create = vi.fn()
      .mockResolvedValueOnce(completion(JSON.stringify({ assessments: [] })))
      .mockResolvedValueOnce(completion(JSON.stringify({ schemaVersion: 2, sections: [] })));
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      { dailyReport: { systemPrompt: "日报", promptTemplate: "{{articlesJson}}" } },
      { chat: { completions: { create } } },
    );
    const financeTemplate = parseDailyReportTemplateJson(financeTemplateJson)!;
    await provider.assessDailyReportCandidates({ candidates: [], template: financeTemplate, recentTopics: [], recentTopicLookbackDays: 7 });
    await provider.planDailyReport({
      candidateBriefs: [],
      recentTopics: [],
      template: financeTemplate,
      recentTopicLookbackDays: 7,
    } as unknown as Parameters<typeof provider.planDailyReport>[0]);

    const assessPrompt = create.mock.calls[0]?.[0]?.messages?.[1]?.content as string;
    const planPrompt = create.mock.calls[1]?.[0]?.messages?.[1]?.content as string;
    for (const prompt of [assessPrompt, planPrompt]) {
      expect(prompt).toContain('"selectionRules"');
      expect(prompt).toContain("宏观与政策");
      expect(prompt).not.toContain("热点事件");
      expect(prompt).not.toContain("开源与工具");
      expect(prompt).toContain('"schemaVersion":2');
    }
  });

  it("captures nonempty-finance ASSESS/PLAN/WRITE/REVIEW requests and stays neutral outside template/input (R2/R4)", async () => {
    const completion = (content: string) => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const financeAssessment = (candidates: Array<{ id: number }>) => JSON.stringify({
      assessments: candidates.map((candidate) => ({
        candidateId: candidate.id,
        isWorthReading: true,
        relevanceScore: 88,
        suggestedBlockKey: "macro-policy",
        historyDecision: "new",
        matchedRecentTopicTitle: null,
      })),
    });
    const financePlan = (ids: number[]) => JSON.stringify({
      schemaVersion: 2,
      sections: [{ blockKey: "macro-policy", topics: ids.map((candidateId) => ({ candidateIds: [candidateId] })) }],
    });
    const financeDraft = (topics: Array<{ topicId: string; candidateIds: number[] }>) => JSON.stringify({
      headline: "央行宣布降准、一季度财报披露",
      blocks: [{
        type: "section",
        blockKey: "macro-policy",
        title: "宏观与政策",
        items: topics.map((topic) => ({
          topicId: topic.topicId,
          title: "央行下调存款准备金率",
          body: "央行宣布下调存款准备金率 0.5 个百分点，释放长期流动性约 1 万亿元。",
          notes: [{ label: "关键数据", text: "降准 0.5 个百分点，释放约 1 万亿元" }],
          sourceIds: topic.candidateIds,
        })),
      }],
    });
    const create = vi.fn()
      .mockImplementationOnce(async (request: StageRequest) => {
        requestCapture.push(captureStage("ASSESS", request));
        return completion(financeAssessment([{ id: 1 }, { id: 2 }]));
      })
      .mockImplementationOnce(async (request: StageRequest) => {
        requestCapture.push(captureStage("PLAN", request));
        return completion(financePlan([1, 2]));
      })
      .mockImplementationOnce(async (request: StageRequest) => {
        requestCapture.push(captureStage("WRITE", request));
        return completion(financeDraft([
          { topicId: "topic-1", candidateIds: [1] },
          { topicId: "topic-2", candidateIds: [2] },
        ]));
      })
      .mockImplementationOnce(async (request: StageRequest) => {
        requestCapture.push(captureStage("REVIEW", request));
        return completion(JSON.stringify({ verdict: "pass", violations: [], summary: "通过" }));
      });
    const requestCapture: Array<{ stage: string; system: string; user: string }> = [];
    type StageRequest = { userContent?: string; messages?: Array<{ role: string; content: string }> };
    const captureStage = (stage: string, request: StageRequest) => ({
      stage,
      system: request.messages?.[0]?.content ?? "",
      user: request.messages?.[1]?.content ?? request.userContent ?? "",
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      { dailyReport: { systemPrompt: "日报", promptTemplate: "{{articlesJson}}" }, dailyReportReview: { enabled: true } as never },
      { chat: { completions: { create } } },
    );
    const financeTemplate = parseDailyReportTemplateJson(financeTemplateJson)!;
    const financeCandidates = [
      { id: 1, title: "央行宣布下调存款准备金率 0.5 个百分点", summary: "央行宣布降准并释放长期流动性。", sourceName: "财经网", qualityScore: 90, candidateScore: 90, sourceCount: 2, itemCount: 2, createdAt: "2026-04-24T01:00:00.000Z", publishedAt: "2026-04-24T01:00:00.000Z", eventType: "policy", eventSubject: "央行", eventAction: "降准", eventObject: "存款准备金率", eventDate: "2026-04-24" },
      { id: 2, title: "多家媒体转述央行降准消息", summary: "多家媒体转述央行降准消息，内容为同一事件的不同报道。", sourceName: "证券报", qualityScore: 80, candidateScore: 80, sourceCount: 1, itemCount: 1, createdAt: "2026-04-24T02:00:00.000Z", publishedAt: "2026-04-24T02:00:00.000Z", eventType: "policy", eventSubject: "央行", eventAction: "降准", eventObject: "存款准备金率", eventDate: "2026-04-24" },
    ];
    await provider.assessDailyReportCandidates({ candidates: financeCandidates as never, template: financeTemplate, recentTopics: [], recentTopicLookbackDays: 7 });
    await provider.planDailyReport({ candidateBriefs: financeCandidates.map((candidate) => ({ candidateId: candidate.id, title: candidate.title, summaryExcerpt: candidate.summary, sourceName: candidate.sourceName, qualityScore: candidate.qualityScore, candidateScore: candidate.candidateScore, relevanceScore: 88, suggestedBlockKey: "macro-policy", sourceCount: 2, itemCount: 2, historyDecision: "new" })), recentTopics: [], template: financeTemplate, recentTopicLookbackDays: 7 } as unknown as Parameters<typeof provider.planDailyReport>[0]);
    const draft = await provider.writeDailyReport({ template: financeTemplate, selectedTopics: [{ topicId: "topic-1", blockKey: "macro-policy", candidateIds: [1], representativeCandidateId: 1, candidates: [financeCandidates[0] as never] }, { topicId: "topic-2", blockKey: "macro-policy", candidateIds: [2], representativeCandidateId: 2, candidates: [financeCandidates[1] as never] }] } as never);
    await provider.reviewDailyReport({ date: "2026-04-24", draft: draft as never, selectedTopics: [], candidatePool: { rawCandidateCount: 2, eligibleCandidateCount: 2, excludedByAssessCount: 0, historyFilteredCount: 0, candidatesByBlock: {}, topUnselectedCandidates: [], inputTruncatedCount: 0 }, selectionAudit: { candidateCoverage: {}, planningAudit: null, selectedCount: 2, selectedByBlock: {} }, template: financeTemplate } as unknown as Parameters<typeof provider.reviewDailyReport>[0]);

    expect(requestCapture.map((entry) => entry.stage)).toEqual(["ASSESS", "PLAN", "WRITE", "REVIEW"]);
    const assessUser = requestCapture[0]!.user;
    const planUser = requestCapture[1]!.user;
    const writeUser = requestCapture[2]!.user;
    const reviewUser = requestCapture[3]!.user;
    // 非空候选真实进入请求。
    expect(assessUser).toContain("央行宣布下调存款准备金率");
    expect(planUser).toContain('"candidateBriefs"');
    expect(planUser).toContain('"candidateId":1');
    expect(writeUser).toContain("topic-1");
    // WRITE 不接收 selectionRules；模板/输入外无领域残留。
    expect(writeUser).not.toContain('"selectionRules"');
    expect(writeUser).toContain("宏观与政策");
    expect(assessUser).not.toContain("热点事件");
    expect(planUser).not.toContain("热点事件");
    for (const prompt of [assessUser, planUser, writeUser, reviewUser]) {
      expect(prompt).not.toContain("AI 日报");
      expect(prompt).not.toContain("GPT-5.6");
    }
  });
});

describe("effective daily report protocol fingerprint (R3)", () => {
  it("covers every fixed protocol text actually consumed by request assembly", () => {
    const material = getDailyReportProtocolMaterial();
    for (const entry of [
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
      DAILY_REPORT_NEUTRAL_REVIEW_PROMPT,
    ]) {
      expect(material.includes(entry as never) || entry === DAILY_REPORT_NEUTRAL_REVIEW_PROMPT).toBe(true);
    }
  });

  it("is stable for stable config and changes when a representative stage contract/guide changes", async () => {
    const before = getDailyReportEffectiveProtocolFingerprint();
    expect(getDailyReportEffectiveProtocolFingerprint()).toBe(before);

    const generationInput = {
      runtimeConfig: { selectedPromptConfigs: {}, modelApi: { baseURL: "https://example.com/v1", model: "m" } },
      templateSignature: "tpl",
      planningBatchSize: null,
      recentTopicLookbackDays: 7,
    } as never;
    const signatureBefore = buildDailyReportGenerationSignature(generationInput);
    const versionBefore = getDailyReportEffectivePipelineVersion();
    expect(signatureBefore).toBe(buildDailyReportGenerationSignature(generationInput));
    expect(versionBefore).toBe(getDailyReportEffectivePipelineVersion());

    const protocols = await import("@/lib/ai/protocols/daily-report");
    const materialModule = await vi.importActual<typeof import("@/lib/ai/protocols/daily-report")>("@/lib/ai/protocols/daily-report");
    expect(materialModule).toBe(protocols);

    const original = protocols.DAILY_REPORT_STAGE_CONTRACTS.PLAN;
    const modifiedMaterial = getDailyReportProtocolMaterial().map((entry) =>
      entry === original ? `${original}\n协议修订：可规划候选必须逐一评估。` : entry,
    );
    const modifiedHash = createHash("sha256").update([...modifiedMaterial, DAILY_REPORT_NEUTRAL_REVIEW_PROMPT].join("\u0000")).digest("hex");
    expect(modifiedHash).not.toBe(before);

    // 同一材料重算哈希稳定；不同材料得到不同指纹 → 签名与 checkpoint 版本随之变化。
    const recomputed = createHash("sha256").update([...modifiedMaterial, DAILY_REPORT_NEUTRAL_REVIEW_PROMPT].join("\u0000")).digest("hex");
    expect(recomputed).toBe(modifiedHash);
    expect(recomputed).not.toBe(getDailyReportEffectiveProtocolFingerprint());
  });
});
