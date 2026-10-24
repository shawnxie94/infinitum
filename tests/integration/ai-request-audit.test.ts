import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/db";
import type { TransportAttemptContext, TransportAttemptOutcome } from "@infinitum/ai/provider/types";
import { triggerTaskWorkflow } from "@/lib/ai-orchestration/runtime";
import {
  createRequestAudit,
  getDailyBudgetSnapshot,
  RequestBudgetExceededError,
  UnresolvedAttemptBlockError,
  RequestAuditStorageError,
} from "@/lib/ai/request-audit";
import { createAiProvider } from "@/lib/ai/provider-next";

// F2 真实任务边界验证：provider-next 透明包装（默认行为不变），可在边界测试中
// 注入指向本机关闭端口的失败 client（无外部网络），走真实 createAiProvider/审计。
const boundaryState = vi.hoisted(() => ({
  failClient: undefined as unknown | undefined,
  rssItems: [] as Array<Record<string, unknown>>,
  runtimeConfig: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/ai/provider-next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider-next")>();
  return {
    ...actual,
    createAiProvider: (
      config: Parameters<typeof actual.createAiProvider>[0],
      prompts: Parameters<typeof actual.createAiProvider>[1],
      client: Parameters<typeof actual.createAiProvider>[2],
      options: Parameters<typeof actual.createAiProvider>[3],
    ) => {
      const provider = boundaryState.failClient !== undefined
        ? actual.createAiProvider(config, prompts, boundaryState.failClient, options)
        : actual.createAiProvider(config, prompts, client, options);
      const originalUnderstand = provider.understandItem.bind(provider);
      provider.understandItem = async (...args) => {
        return originalUnderstand(...args);
      };
      return provider;
    },
  };
});

vi.mock("@/lib/ingestion/parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingestion/parser")>();
  return {
    ...actual,
    createRssParser: () => ({ parseURL: vi.fn(async () => ({ items: boundaryState.rssItems })) }),
  };
});

vi.mock("@/lib/settings/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings/service")>();
  return {
    ...actual,
    getIngestionRuntimeConfig: vi.fn(async () =>
      boundaryState.runtimeConfig ?? actual.getIngestionRuntimeConfig()),
  };
});

function createContext(overrides: Partial<TransportAttemptContext> = {}): TransportAttemptContext {
  return {
    requestId: randomUUID(),
    attemptIndex: 0,
    attemptType: "initial",
    model: "test-model",
    baseURL: "https://example.com/v1",
    usageKey: "cluster_summary",
    promptFingerprint: "f".repeat(64),
    promptBytes: 128,
    ...overrides,
  };
}

beforeEach(async () => {
  await prisma.aiRequestReceipt.deleteMany();
  await prisma.aiRequestBudgetDay.deleteMany();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** 预算唯一来源是环境变量：每次调用时读取，测试用 stubEnv 隔离、unstubAllEnvs 恢复。 */
function setDailyLimit(value: string) {
  vi.stubEnv("AI_DAILY_CHAT_REQUEST_LIMIT", value);
}

describe("AI 请求审计（集成）", () => {
  it("多连接并发准入满足原子硬上限：恰好放行 cap 个", async () => {
    await setDailyLimit("5");
    const audit = createRequestAudit();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => audit.beforeDispatch(createContext())),
    );
    const admitted = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry) => entry.status === "rejected");
    expect(admitted).toHaveLength(5);
    expect(rejected).toHaveLength(15);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RequestBudgetExceededError);
    const budget = await getDailyBudgetSnapshot();
    expect(budget.admitted).toBe(5);
    expect(budget.limit).toBe(5);
    // 拒绝同样留痕（denied_budget 回执），但不占预算。
    const denied = await prisma.aiRequestReceipt.count({ where: { status: "denied_budget" } });
    expect(denied).toBe(15);
    const inFlight = await prisma.aiRequestReceipt.count({ where: { status: "in_flight" } });
    expect(inFlight).toBe(5);
  });

  it("默认（未配置）= 不限；计数器照常累计", async () => {
    const audit = createRequestAudit();
    for (let index = 0; index < 7; index += 1) {
      await audit.beforeDispatch(createContext());
    }
    const budget = await getDailyBudgetSnapshot();
    expect(budget.limit).toBeNull();
    expect(budget.admitted).toBe(7);
  });

  it("上限 0 = 全部拒绝；非法环境值 fail-closed（拒绝派发而非放宽为不限）", async () => {
    await setDailyLimit("0");
    const audit = createRequestAudit();
    await expect(audit.beforeDispatch(createContext())).rejects.toBeInstanceOf(RequestBudgetExceededError);
    expect(await getDailyBudgetSnapshot()).toMatchObject({ admitted: 0, limit: 0 });

    // F4：非空非法环境值（负数）→ 拒绝派发；展示侧快照仍显示不限（宽松口径）。
    await setDailyLimit("-3");
    await expect(audit.beforeDispatch(createContext())).rejects.toBeInstanceOf(RequestBudgetExceededError);
    expect(await prisma.aiRequestReceipt.count({ where: { status: "in_flight" } })).toBe(0);
    // invalid 显式区分，绝不伪装为 unlimited；快照不回显原始非法值。
    const invalidSnapshot = await getDailyBudgetSnapshot();
    expect(invalidSnapshot).toMatchObject({ limit: null, state: "invalid" });
    expect(JSON.stringify(invalidSnapshot)).not.toContain("-3");
  });

  it("存量 DB 预算配置被忽略：env 未设置即不限，即使 DB 存了 0", async () => {
    const existing = await prisma.aiRequestsConfig.findFirst({ orderBy: { createdAt: "asc" } });
    if (existing) {
      await prisma.aiRequestsConfig.update({ where: { id: existing.id }, data: { dailyChatRequestLimit: 0 } });
    } else {
      await prisma.aiRequestsConfig.create({ data: { dailyChatRequestLimit: 0 } });
    }
    const audit = createRequestAudit();
    // DB 上限为 0，但 env 未设置 = 不限：连续派发全部放行。
    await audit.beforeDispatch(createContext());
    await audit.beforeDispatch(createContext());
    expect((await getDailyBudgetSnapshot()).limit).toBeNull();
    expect((await getDailyBudgetSnapshot()).state).toBe("unlimited");
    expect((await getDailyBudgetSnapshot()).admitted).toBe(2);
  });

  it("UTC 日翻滚：昨日计数不影响今天；昨天行原样保留", async () => {
    await setDailyLimit("2");
    const yesterday = new Date(Date.now() - 86_400_000);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);
    await prisma.aiRequestBudgetDay.create({
      data: { day: yesterdayKey, admitted: 2, updatedAt: yesterday },
    });
    const audit = createRequestAudit();
    await audit.beforeDispatch(createContext());
    await audit.beforeDispatch(createContext());
    await expect(audit.beforeDispatch(createContext())).rejects.toBeInstanceOf(RequestBudgetExceededError);
    expect((await getDailyBudgetSnapshot()).admitted).toBe(2);
    const yesterdayRow = await prisma.aiRequestBudgetDay.findUnique({ where: { day: yesterdayKey } });
    expect(yesterdayRow?.admitted).toBe(2);
  });

  it("预算计数跨进程/重启持久（新实例读取同一 SQLite 计数）", async () => {
    await setDailyLimit("1");
    const first = createRequestAudit();
    await first.beforeDispatch(createContext());
    const second = createRequestAudit();
    await expect(second.beforeDispatch(createContext())).rejects.toBeInstanceOf(RequestBudgetExceededError);
  });

  it("unknown 回执保留 charged 计数；同任务恢复被阻断，其他任务不受影响", async () => {
    const audit = createRequestAudit({ taskRunId: "task-1", stepId: "step-1" });
    const context = createContext({ step: { stepId: "step-1", taskRunId: "task-1" } });
    await audit.beforeDispatch(context);
    await audit.settle(context, { status: "unknown", errorMessage: "request timed out" });

    const receipt = await prisma.aiRequestReceipt.findUnique({ where: { requestId: context.requestId } });
    expect(receipt?.status).toBe("unknown");
    expect(receipt?.errorMessage).toContain("timed out");
    expect((await getDailyBudgetSnapshot()).admitted).toBe(1);

    const blocked = createRequestAudit({ taskRunId: "task-1", stepId: "step-1" });
    await expect(blocked.beforeDispatch(createContext())).rejects.toBeInstanceOf(UnresolvedAttemptBlockError);

    const otherTask = createRequestAudit({ taskRunId: "task-2", stepId: "step-2" });
    await expect(otherTask.beforeDispatch(createContext())).resolves.toBeUndefined();
  });

  it("F1：SIGKILL 孤儿 in_flight 在同任务恢复时立即封存为 unknown 并阻断；被阻断尝试不消耗预算；同执行并发的不同请求不受影响", async () => {
    // 模拟崩溃遗留：他人执行身份（不同 runId/boot）的 in_flight 回执。
    await prisma.aiRequestReceipt.create({
      data: {
        requestId: "orphan-1",
        operation: "item_understanding",
        attemptType: "initial",
        model: "test-model",
        configFingerprint: "f".repeat(64),
        promptFingerprint: "e".repeat(64),
        status: "in_flight",
        ownerId: "dead-boot:run-dead",
        taskRunId: "task-orphan",
      },
    });
    const audit = createRequestAudit(() => ({ taskRunId: "task-orphan", workflowRunId: "run-recovered", stepId: "s" }));
    await expect(audit.beforeDispatch(createContext())).rejects.toBeInstanceOf(UnresolvedAttemptBlockError);

    const orphan = await prisma.aiRequestReceipt.findUnique({ where: { requestId: "orphan-1" } });
    expect(orphan?.status).toBe("unknown");
    expect(orphan?.errorKind).toBe("OrphanedInFlight");
    // 阻断发生在准入之前：预算零消耗。
    expect((await getDailyBudgetSnapshot()).admitted).toBe(0);

    // 同一次执行（同 workflowRunId）内并发的不同请求共享 ownerId，不被阻断。
    const liveAudit = createRequestAudit(() => ({ taskRunId: "task-live", workflowRunId: "run-live" }));
    await liveAudit.beforeDispatch(createContext());
    await expect(liveAudit.beforeDispatch(createContext())).resolves.toBeUndefined();
    expect((await getDailyBudgetSnapshot()).admitted).toBe(2);

    // 另一次恢复运行（不同 runId）会被遗留 in_flight 阻断（竞争恢复不能同时派发）。
    const racing = createRequestAudit(() => ({ taskRunId: "task-live", workflowRunId: "run-live-2" }));
    await expect(racing.beforeDispatch(createContext())).rejects.toBeInstanceOf(UnresolvedAttemptBlockError);
  });

  it("F3：已知任意格式 apiKey 字面量在原始响应/错误中完整脱敏", async () => {
    const secret = "mykey1234567890";
    const audit = createRequestAudit({}, { knownSecrets: [secret] });
    const context = createContext();
    await audit.beforeDispatch(context);
    await audit.settle(context, {
      status: "failed",
      errorName: "StatusError",
      errorMessage: `401 Unauthorized: key ${secret} rejected`,
    });
    const receipt = await prisma.aiRequestReceipt.findUniqueOrThrow({ where: { requestId: context.requestId } });
    expect(receipt.errorMessage).not.toContain(secret);
    expect(receipt.errorMessage).toContain("[已脱敏]");
  });

  it("F2/F4：ALS 上下文在调用时解析（复用 provider 归因新任务）", async () => {
    const { runWithRequestAuditContext, getRequestAuditContext } = await import("@/lib/ai/request-audit");
    const created: string[] = [];
    const requestAudit = createRequestAudit(() => getRequestAuditContext());
    const hooks = {
      beforeDispatch: async (context: TransportAttemptContext) => {
        await requestAudit.beforeDispatch(context);
        created.push(context.requestId);
      },
      settle: (context: TransportAttemptContext, outcome: TransportAttemptOutcome) => requestAudit.settle(context, outcome),
    };
    // 同一 hooks 实例（等价复用 provider）先在无任务上下文调用，再被任务边界包裹调用。
    const outsideContext = createContext();
    const insideContext = createContext();
    await hooks.beforeDispatch(outsideContext);
    await runWithRequestAuditContext(
      { taskRunId: "task-als", workflowRunId: "run-als" },
      async () => {
        await hooks.beforeDispatch(insideContext);
      },
    );
    // 两条回执常落入同一毫秒，createdAt 平局排序不稳定；归因断言必须按 requestId 定位，
    // 并在此强制同毫秒平局，让旧的 rows[0]/rows[1] 索引断言持续暴露该非确定性。
    const tiedAt = new Date("2026-10-16T08:00:00.000Z");
    await prisma.aiRequestReceipt.updateMany({
      where: { requestId: { in: created } },
      data: { createdAt: tiedAt },
    });
    const rows = await prisma.aiRequestReceipt.findMany({
      where: { requestId: { in: created } },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    const receiptById = new Map(rows.map((row) => [row.requestId, row]));
    expect(receiptById.get(outsideContext.requestId)?.taskRunId).toBeNull();
    expect(receiptById.get(insideContext.requestId)?.taskRunId).toBe("task-als");
  });

  it("审计存储失败 = fail-closed，零派发且不消耗预算（事务回滚）", async () => {
    const audit = createRequestAudit();
    const context = createContext();
    // 预置同 requestId 冲突行：回执创建在准入事务内失败 → 整体回滚。
    await prisma.aiRequestReceipt.create({
      data: {
        requestId: context.requestId,
        operation: "cluster_summary",
        attemptType: "initial",
        model: "test-model",
        configFingerprint: "f".repeat(64),
        promptFingerprint: "e".repeat(64),
        status: "succeeded",
      },
    });
    await expect(audit.beforeDispatch(context)).rejects.toBeInstanceOf(RequestAuditStorageError);
    // 准入与回执同一事务：回执创建失败整体回滚，预算不因失败尝试被占用。
    expect((await getDailyBudgetSnapshot()).admitted).toBe(0);
    expect(await prisma.aiRequestReceipt.count()).toBe(1);
  });

  it("F8：解析诊断持久化失败按终态审计失败上抛（不再静默吞掉）", async () => {
    const audit = createRequestAudit();
    await expect(
      audit.recordParseDiagnostic({ requestId: "missing-receipt", kind: "parse_failed", detail: "x" }),
    ).rejects.toBeInstanceOf(RequestAuditStorageError);
  });

  it("回执持久化脱敏限界原始响应（业务解析前），失败尝试在成功重试后仍保留", async () => {
    const audit = createRequestAudit();
    const leakyRaw = `{"summary":"正常"} api key sk-abcdefghijklmnop123 usage ok`;
    const failedContext = createContext({ attemptIndex: 0 });
    await audit.beforeDispatch(failedContext);
    await audit.settle(failedContext, {
      status: "failed",
      errorName: "StatusError",
      errorMessage: "429 Too Many Requests, key sk-abcdefghijklmnop123",
    });

    const successContext = createContext({ attemptIndex: 1 });
    await audit.beforeDispatch(successContext);
    await audit.settle(successContext, {
      status: "succeeded",
      rawText: leakyRaw,
      finishReason: "stop",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedTokens: 0,
        cachedTokensReported: false,
        tokenUsageSource: "provider",
        model: "test-model",
      },
    });

    const failed = await prisma.aiRequestReceipt.findUnique({ where: { requestId: failedContext.requestId } });
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage).not.toContain("sk-abcdefghijklmnop123");
    expect(failed?.promptTokens).toBeNull();
    expect(failed?.tokenUsageSource).toBeNull();

    const succeeded = await prisma.aiRequestReceipt.findUnique({ where: { requestId: successContext.requestId } });
    expect(succeeded?.status).toBe("succeeded");
    expect(succeeded?.responseRaw).not.toContain("sk-abcdefghijklmnop123");
    expect(succeeded?.finishReason).toBe("stop");
    expect(succeeded?.tokenUsageSource).toBe("provider");
    expect(succeeded?.responseExpiresAt).not.toBeNull();
  });

  it("失败回执保留真实零和部分 provider 用量，缺失字段仍为 NULL，且脱敏错误正文", async () => {
    const audit = createRequestAudit({}, { knownSecrets: ["sk-secret-abcdefghijklmnop"] });
    const context = createContext({ attemptIndex: 0 });
    await audit.beforeDispatch(context);
    await audit.settle(context, {
      status: "failed",
      errorName: "AI_NoObjectGeneratedError",
      errorMessage: "invalid output sk-secret-abcdefghijklmnop",
      rawText: "response sk-secret-abcdefghijklmnop",
      finishReason: "length",
      usage: { promptTokens: 0, tokenUsageSource: "provider" },
    });

    const row = await prisma.aiRequestReceipt.findUnique({ where: { requestId: context.requestId } });
    expect(row).toMatchObject({
      status: "failed",
      errorKind: "AI_NoObjectGeneratedError",
      errorMessage: expect.not.stringContaining("sk-secret-abcdefghijklmnop"),
      responseRaw: expect.not.stringContaining("sk-secret-abcdefghijklmnop"),
      finishReason: "length",
      promptTokens: 0,
      tokenUsageSource: "provider",
    });
    expect(row?.completionTokens).toBeNull();
    expect(row?.totalTokens).toBeNull();
  });

  it("非抛出 summary 无效诊断记录到对应回执，且不引入额外模型调用", async () => {
    const inputText = "正文内容足够长，描述了一个明确的事件事实。".repeat(10);
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: inputText,
            translatedTitle: "标题",
            moderationStatus: "allowed",
            qualityScore: 80,
            qualityRationale: "合理",
            eventSignature: { eventType: null, eventSubject: null, eventAction: null, eventObject: null, eventDate: null },
            aggregation: { isAggregation: false, mainEvent: null, events: [] },
          }),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      undefined,
      { chat: { completions: { create } } },
      { step: { stepId: "s", taskRunId: "task-diag" } },
    );
    const understanding = await provider.understandItem(inputText, {
      title: "标题",
      sourceName: "来源",
      translateTitle: true,
    });
    expect(understanding.diagnostics.summaryValid).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);

    const receipt = await prisma.aiRequestReceipt.findFirst({
      where: { taskRunId: "task-diag" },
      orderBy: { createdAt: "desc" },
    });
    expect(receipt?.status).toBe("succeeded");
    expect(receipt?.parseDiagnosticJson).not.toBeNull();
    expect(JSON.parse(receipt!.parseDiagnosticJson!)).toMatchObject({ kind: "invalid_summary" });
  });

  it("预算 0 时 provider 不发生任何真实调用", async () => {
    await setDailyLimit("0");
    const create = vi.fn();
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      undefined,
      { chat: { completions: { create } } },
    );
    await expect(provider.summarizeCluster("正文", { title: "标题" })).rejects.toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("7 天保留：过期原始载荷被清空，身份元数据保留", async () => {
    const audit = createRequestAudit();
    const context = createContext();
    await audit.beforeDispatch(context);
    await audit.settle(context, { status: "succeeded", rawText: "原始输出", finishReason: "stop" });
    await prisma.aiRequestReceipt.update({
      where: { requestId: context.requestId },
      data: { responseExpiresAt: new Date(Date.now() - 1000) },
    });
    // 节流窗口按模块时间戳判定：把时钟推进 15 分钟后，新实例准入会触发清理。
    const freshAudit = createRequestAudit();
    vi.useFakeTimers({ now: Date.now() + 15 * 60 * 1000 });
    try {
      await freshAudit.beforeDispatch(createContext());
    } finally {
      vi.useRealTimers();
    }
    const receipt = await prisma.aiRequestReceipt.findUnique({ where: { requestId: context.requestId } });
    expect(receipt?.responseRaw).toBeNull();
    expect(receipt?.status).toBe("succeeded");
    expect(receipt?.operation).toBe("cluster_summary");
  });
});

describe("AI 请求审计（真实任务执行边界）", () => {
  function enableAuditBoundary() {
    boundaryState.failClient = { chat: { completions: { create: async () => {
      // 超时类无响应错误 → unknown 结局（不再自动重试）。
      throw Object.assign(new Error("connection timed out"), { name: "TimeoutError" });
    } } } };
    boundaryState.runtimeConfig = {
      modelApi: { apiKey: "audit-key-12345678", baseURL: "http://127.0.0.1:9/v1", model: "audit-model", customHeaders: {} },
      selectedPromptConfigs: {},
      embedding: null,
      rssSources: [{
        name: "审计边界源",
        rssUrl: "https://audit-boundary.example/rss",
        siteUrl: "https://audit-boundary.example",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: false,
        aggregationDetectionEnabled: false,
      }],
      ingestion: {
        sourceConcurrency: 1,
        itemConcurrency: 1,
        fullTextFetchThreshold: 80,
        perSourceItemLimit: 10,
        maxFeedItemsToScan: 10,
        aggregationSplitMaxEvents: 20,
      },
      contentExtraction: { jinaEnabled: false, jinaBaseUrl: "https://r.jina.ai/", jinaApiKey: null, timeoutMs: 1000, concurrency: 1, rpmLimit: 10, maxPerRun: 10, minChars: 500, maxChars: 2000 },
    };
    boundaryState.rssItems = [{
      title: "审计边界条目：真实任务执行链路验证",
      link: "https://audit-boundary.example/story/1",
      pubDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      contentSnippet: "This is a sufficiently long fixture body for the audit boundary test. ".repeat(3),
    }];
  }

  let boundarySourceSeq = 0;

  async function seedIngestionTask() {
    boundarySourceSeq += 1;
    const rssUrl = `https://audit-boundary.example/rss/${boundarySourceSeq}`;
    const taskRun = await prisma.backgroundTaskRun.create({
      data: { kind: "ingestion", triggerType: "manual", status: "queued", label: "审计边界抓取" },
    });
    await prisma.source.create({
      data: {
        id: `src-${taskRun.id}`,
        name: "审计边界源",
        rssUrl,
        siteUrl: "https://audit-boundary.example",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: false,
        aggregationDetectionEnabled: false,
      },
    });
    return taskRun;
  }

  it("F2/F1：真实 ingestion 工作流回执归因 taskRunId；同任务恢复（新运行）被阻断且不消耗预算；新任务放行", async () => {
    await prisma.item.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.backgroundTaskRun.deleteMany();
    await prisma.source.deleteMany();
    enableAuditBoundary();

    // 第一次运行（全新 manual 任务）：真实工作流边界经 ALS 归因，unknown 回执带 taskRunId。
    const taskRun = await seedIngestionTask();
    await triggerTaskWorkflow("ingestion", taskRun.id);
    const firstRun = await prisma.aiRequestReceipt.findMany({ where: { taskRunId: taskRun.id } });
    expect(firstRun.length).toBeGreaterThan(0);
    expect(firstRun.every((receipt) => receipt.status !== "in_flight")).toBe(true);
    expect(firstRun.some((receipt) => receipt.status === "unknown")).toBe(true);
    const admittedAfterFirst = (await getDailyBudgetSnapshot()).admitted;
    expect(admittedAfterFirst).toBeGreaterThan(0);

    // 同任务恢复（新运行身份，等价 workflow 重启）：真实 provider 边界立即阻断，
    // 无新增 in_flight/预算消耗，并留下 blocked_unresolved 回执。
    const { resolveAiProvider } = await import("@/lib/items/service");
    const { runWithRequestAuditContext } = await import("@/lib/ai/request-audit");
    const resumedProvider = await resolveAiProvider();
    const resumedError = await runWithRequestAuditContext(
      { taskRunId: taskRun.id, workflowRunId: "run-recovery-2" },
      () => resumedProvider
        .understandItem("恢复运行条目正文。".repeat(20), {
          title: "恢复运行条目",
          sourceName: "审计边界源",
          translateTitle: true,
        })
        .then(() => null, (error: unknown) => error),
    );
    expect((resumedError as Error).name).toBe("TransportAdmissionError");
    expect(await prisma.aiRequestReceipt.count({ where: { taskRunId: taskRun.id, status: "in_flight" } })).toBe(0);
    expect(
      await prisma.aiRequestReceipt.count({ where: { taskRunId: taskRun.id, status: "blocked_unresolved" } }),
    ).toBeGreaterThan(0);
    expect((await getDailyBudgetSnapshot()).admitted).toBe(admittedAfterFirst);

    // 全新 manual 任务：守卫按任务隔离，真实派发照常发生（unknown 结局照常记账）。
    const freshTask = await seedIngestionTask();
    const freshProvider = await resolveAiProvider();
    await runWithRequestAuditContext(
      { taskRunId: freshTask.id, workflowRunId: "run-fresh" },
      async () => {
        await expect(
          freshProvider.understandItem("全新任务条目正文。".repeat(20), {
            title: "全新任务条目",
            sourceName: "审计边界源",
            translateTitle: true,
          }),
        ).rejects.toThrow();
      },
    );
    const freshReceipts = await prisma.aiRequestReceipt.findMany({ where: { taskRunId: freshTask.id } });
    expect(freshReceipts.length).toBeGreaterThan(0);
    expect((await getDailyBudgetSnapshot()).admitted).toBeGreaterThan(admittedAfterFirst);
  }, 120_000);
});
