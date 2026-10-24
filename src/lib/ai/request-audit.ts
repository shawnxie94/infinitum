import { randomUUID, createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  type TransportAttemptContext,
  type TransportAttemptOutcome,
  type TransportAuditHooks,
} from "@infinitum/ai/provider/types";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import {
  AI_DAILY_CHAT_REQUEST_LIMIT_ENV,
  resolveEnvDailyChatRequestLimit,
  type AiRequestBudgetState,
  type EnvDailyChatRequestLimit,
} from "@/lib/ai/request-budget-env";

/**
 * AI 业务聊天请求审计（失败回执 + UTC 日硬上限）：
 * - 每次真实传输调用先原子准入再落回执，fail-closed：预算拒绝、同任务未决
 *   结果阻断、审计存储失败都会阻止付费派发。
 * - 守卫/准入/回执在事务内完成：同任务恢复时孤儿 in_flight（SIGKILL 遗留）
 *   立即封存为 unknown 并阻断本任务后续派发；被阻断尝试不消耗预算。
 * - 原始响应在业务解析前持久化：先按已知密钥字面量与模式脱敏（完整替换、
 *   不留前缀）再限界（≤32KiB UTF-8 + 截断标记）；7 天后清空原始载荷、保留
 *   身份元数据。
 * - token 字段全部可空并带来源标签；缺失用量绝不记为 0 实际用量。
 */

export const AI_RAW_RETENTION_DAYS = 7;
export const AI_RAW_MAX_BYTES = 32 * 1024;
const AI_RAW_TRUNCATION_MARKER = "\n…[已截断]";
const RETENTION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export class RequestBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestBudgetExceededError";
  }
}

export class UnresolvedAttemptBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnresolvedAttemptBlockError";
  }
}

export class RequestAuditStorageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "RequestAuditStorageError";
  }
}

export type RequestAuditIdentity = {
  taskRunId?: string | null;
  stepId?: string | null;
  workflowId?: string | null;
  workflowRunId?: string | null;
};

export type RequestParseDiagnosticKind =
  | "parse_failed"
  | "invalid_summary"
  | "invalid_analysis"
  | "invalid_aggregation";

export type RequestAudit = TransportAuditHooks & {
  /** 关联最近一次真实调用的回执记录解析诊断；持久化失败按终态审计失败上抛。 */
  recordParseDiagnostic(input: {
    requestId?: string;
    kind: RequestParseDiagnosticKind;
    detail: string;
  }): Promise<void>;
  /** 执行归属标识（进程 boot + taskRunId），测试与诊断用。 */
  readonly ownerId: string | null;
};

/**
 * 审计执行上下文（F2）：任务触发边界（triggerTaskWorkflow）用 ALS 包裹真实
 * 任务执行，使复用的 provider 实例在调用时解析 taskRunId/step 归属。
 */
const auditContextStorage = new AsyncLocalStorage<RequestAuditIdentity>();

export function runWithRequestAuditContext<T>(context: RequestAuditIdentity, fn: () => Promise<T>): Promise<T> {
  return auditContextStorage.run(context, fn);
}

export function getRequestAuditContext(): RequestAuditIdentity | null {
  return auditContextStorage.getStore() ?? null;
}

/**
 * 模式级脱敏：完整替换命中片段（不保留任何密钥前缀）。
 * 先做已知密钥字面量替换（覆盖任意格式凭据回显），再按 key:value / 令牌模式兜底。
 */
export function sanitizeAuditText(input: string, knownSecrets?: readonly (string | null | undefined)[]): {
  text: string;
  truncated: boolean;
} {
  let redacted = input;
  for (const secret of knownSecrets ?? []) {
    if (typeof secret === "string" && secret.length >= 8) {
      redacted = redacted.split(secret).join("[已脱敏]");
    }
  }
  redacted = redacted
    .replace(/\b(sk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[已脱敏]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "[已脱敏]")
    .replace(/\b(Authorization|X-Api-Key|X-Auth-Token|Api-Key)\s*[:：]\s*[^\s"',}，。」】]+/gi, "$1: [已脱敏]")
    .replace(
      /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret|password|passwd|token)\b["']?\s*[:=]\s*["']?[^"'\s,;,}」】]{4,}/gi,
      "$1: [已脱敏]",
    );
  const budget = AI_RAW_MAX_BYTES - Buffer.byteLength(AI_RAW_TRUNCATION_MARKER, "utf8");
  if (Buffer.byteLength(redacted, "utf8") <= AI_RAW_MAX_BYTES) {
    return { text: redacted, truncated: false };
  }
  let cut = redacted.length;
  while (cut > 0 && Buffer.byteLength(redacted.slice(0, cut), "utf8") > budget) {
    cut = Math.floor(cut * 0.9);
  }
  return { text: redacted.slice(0, cut) + AI_RAW_TRUNCATION_MARKER, truncated: true };
}

/** 展示/摘要用宽松口径：null/缺省 = 不限。 */
export function normalizeDailyChatRequestLimit(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function configFingerprint(baseURL: string | null | undefined, model: string): string {
  return createHash("sha256").update(`${baseURL ?? ""}|${model}`).digest("hex");
}

type TransactionClient = Prisma.TransactionClient;

/**
 * 预算唯一生效来源是环境变量 AI_DAILY_CHAT_REQUEST_LIMIT（每次调用时读取，
 * 不读 DB 配置、不做模块级缓存）；非法非空值 = 拒绝派发，绝不放宽为不限。
 */
function readDailyChatRequestLimitStrict(): ReturnType<typeof resolveEnvDailyChatRequestLimit> {
  return resolveEnvDailyChatRequestLimit();
}

let lastRetentionSweepAt = 0;

async function sweepExpiredRawPayloads(client: TransactionClient, now: Date) {
  if (now.getTime() - lastRetentionSweepAt < RETENTION_SWEEP_INTERVAL_MS) return;
  lastRetentionSweepAt = now.getTime();
  await client.aiRequestReceipt.updateMany({
    where: { responseExpiresAt: { lt: now }, responseRaw: { not: null } },
    data: { responseRaw: null, responseTruncated: false },
  });
}

/** 原子准入：单条 upsert 在 SQLite 写串行下跨进程安全；0 变更 = 预算拒绝。 */
async function admitRequest(client: TransactionClient, limit: EnvDailyChatRequestLimit, now: Date): Promise<void> {
  if (limit.kind === "invalid") {
    throw new RequestBudgetExceededError(
      `环境变量 ${AI_DAILY_CHAT_REQUEST_LIMIT_ENV} 取值非法，已 fail-closed 暂停全部业务聊天派发；请修正为非负整数或清空。`,
    );
  }
  if (limit.kind === "limit" && limit.value === 0) {
    throw new RequestBudgetExceededError("每日业务聊天请求上限为 0，所有请求已暂停。");
  }
  const day = utcDay(now);
  const nowIso = now.toISOString();
  let changes: number;
  if (limit.kind === "unlimited") {
    changes = await client.$executeRawUnsafe(
      `INSERT INTO "ai_request_budget_days" ("day", "admitted", "updatedAt") VALUES (?, 1, ?)
       ON CONFLICT ("day") DO UPDATE SET "admitted" = "ai_request_budget_days"."admitted" + 1, "updatedAt" = ?`,
      day,
      nowIso,
      nowIso,
    );
  } else {
    changes = await client.$executeRawUnsafe(
      `INSERT INTO "ai_request_budget_days" ("day", "admitted", "updatedAt") VALUES (?, 1, ?)
       ON CONFLICT ("day") DO UPDATE SET "admitted" = "ai_request_budget_days"."admitted" + 1, "updatedAt" = ?
       WHERE "ai_request_budget_days"."admitted" < ?`,
      day,
      nowIso,
      nowIso,
      limit.value,
    );
  }
  if (changes === 0) {
    throw new RequestBudgetExceededError(
      limit.kind === "limit" ? `已达到每日（UTC）业务聊天请求上限 ${limit.value}，本次调用被拒绝。` : "本次调用被拒绝。",
    );
  }
}

let processBootId: string | null = null;

function getProcessBootId(): string {
  processBootId ??= randomUUID();
  return processBootId;
}

/**
 * 执行归属：进程 boot + 每次（恢复）运行的工作流 runId（缺省回退 taskRunId）。
 * 崩溃恢复 / 竞争重启产生新的 runId → 与遗留 in_flight 的 ownerId 必然不同，
 * 守卫立即封存并阻断；同一次运行内并发的不留同请求共享 ownerId，不受影响。
 */
function resolveExecutionOwnerId(identity: RequestAuditIdentity | null): string | null {
  if (!identity?.taskRunId) return null;
  const executionKey = identity.workflowRunId || identity.taskRunId;
  return `${getProcessBootId()}:${executionKey}`;
}

export function createRequestAudit(
  identityResolver: (() => RequestAuditIdentity | null) | RequestAuditIdentity = {},
  options: { knownSecrets?: readonly (string | null | undefined)[] } = {},
): RequestAudit {
  const knownSecrets = (options.knownSecrets ?? []).filter(
    (secret): secret is string => typeof secret === "string" && secret.length >= 8,
  );
  const resolveIdentity = typeof identityResolver === "function"
    ? identityResolver
    : () => identityResolver;

  function redact(value: string) {
    return sanitizeAuditText(value, knownSecrets);
  }

  return {
    get ownerId() {
      return resolveExecutionOwnerId(resolveIdentity());
    },

    async beforeDispatch(context: TransportAttemptContext) {
      const now = new Date();
      const identity = resolveIdentity();
      const taskRunId = identity?.taskRunId ?? null;
      const ownerId = resolveExecutionOwnerId(identity);

      // F1 守卫：同任务存在 unknown（显式或孤儿封存）或他人 in_flight（SIGKILL
      // 遗留 / 竞争恢复）时立即阻断；孤儿当场封存为 unknown（保留占用，不退款
      // 不自动重试）。同任务内并发的不同请求共享本执行 ownerId，不受影响。
      if (taskRunId) {
        let blockedRequestId: string | null = null;
        try {
          await prisma.$transaction(async (tx) => {
            const unresolved = await tx.aiRequestReceipt.findFirst({
              where: {
                taskRunId,
                OR: [
                  { status: "unknown" },
                  { status: "in_flight", ownerId: { not: ownerId } },
                ],
              },
              orderBy: { createdAt: "asc" },
              select: { id: true, requestId: true, status: true },
            });
            if (!unresolved) return;
            if (unresolved.status === "in_flight") {
              await tx.aiRequestReceipt.update({
                where: { id: unresolved.id },
                data: {
                  status: "unknown",
                  errorKind: "OrphanedInFlight",
                  errorMessage: redact("进程崩溃遗留的未决调用，同任务恢复时立即封存（结局未知，保留预算占用）。").text,
                },
              });
            }
            blockedRequestId = unresolved.requestId;
          });
        } catch (error) {
          if (error instanceof UnresolvedAttemptBlockError) throw error;
          throw new RequestAuditStorageError(
            `AI 请求恢复守卫检查失败，已阻止付费派发: ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }
        if (blockedRequestId) {
          const blockError = new UnresolvedAttemptBlockError(
            `任务 ${taskRunId} 存在结局未知的 AI 调用（${blockedRequestId}），同任务恢复期间禁止再次派发。`,
          );
          await prisma.aiRequestReceipt.create({
            data: {
              requestId: context.requestId,
              operation: context.usageKey ?? "unknown",
              attemptType: context.attemptType,
              model: context.model,
              configFingerprint: configFingerprint(context.baseURL, context.model),
              promptFingerprint: context.promptFingerprint,
              promptBytes: context.promptBytes,
              status: "blocked_unresolved",
              ownerId,
              errorMessage: redact(blockError.message).text,
              taskRunId,
              stepId: identity?.stepId ?? null,
              workflowId: identity?.workflowId ?? null,
              workflowRunId: identity?.workflowRunId ?? null,
            },
          }).catch(() => undefined);
          throw blockError;
        }
      }

      // 准入 + 回执创建同一事务：竞争恢复不能同时派发，被阻断尝试不消耗预算。
      try {
        await prisma.$transaction(async (tx) => {
          const limit = readDailyChatRequestLimitStrict();
          await admitRequest(tx, limit, now);
          await sweepExpiredRawPayloads(tx, now);
          await tx.aiRequestReceipt.create({
            data: {
              requestId: context.requestId,
              operation: context.usageKey ?? "unknown",
              attemptType: context.attemptType,
              model: context.model,
              configFingerprint: configFingerprint(context.baseURL, context.model),
              promptFingerprint: context.promptFingerprint,
              promptBytes: context.promptBytes,
              status: "in_flight",
              ownerId,
              taskRunId,
              stepId: identity?.stepId ?? null,
              workflowId: identity?.workflowId ?? null,
              workflowRunId: identity?.workflowRunId ?? null,
            },
          });
        });
      } catch (error) {
        if (error instanceof RequestBudgetExceededError) {
          await prisma.aiRequestReceipt.create({
            data: {
              requestId: context.requestId,
              operation: context.usageKey ?? "unknown",
              attemptType: context.attemptType,
              model: context.model,
              configFingerprint: configFingerprint(context.baseURL, context.model),
              promptFingerprint: context.promptFingerprint,
              promptBytes: context.promptBytes,
              status: "denied_budget",
              ownerId,
              errorMessage: redact(error.message).text,
              taskRunId,
              stepId: identity?.stepId ?? null,
              workflowId: identity?.workflowId ?? null,
              workflowRunId: identity?.workflowRunId ?? null,
            },
          }).catch(() => undefined);
          throw error;
        }
        throw new RequestAuditStorageError(
          `AI 请求预算准入/回执持久化失败，已阻止付费派发: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    },

    async settle(context: TransportAttemptContext, outcome: TransportAttemptOutcome) {
      const now = new Date();
      try {
        const { text, truncated } = outcome.rawText !== undefined
          ? redact(outcome.rawText)
          : { text: null, truncated: false };
        await prisma.aiRequestReceipt.update({
          where: { requestId: context.requestId },
          data: {
            status: outcome.status,
            finishReason: outcome.finishReason ?? null,
            errorKind: outcome.errorName ?? null,
            errorMessage: outcome.errorMessage ? redact(outcome.errorMessage).text : null,
            ...(text !== null ? { responseRaw: text, responseTruncated: truncated } : {}),
            responseExpiresAt: text !== null ? new Date(now.getTime() + AI_RAW_RETENTION_DAYS * 86_400_000) : null,
            ...(outcome.usage
              ? {
                  ...(outcome.usage.promptTokens !== undefined ? { promptTokens: outcome.usage.promptTokens } : {}),
                  ...(outcome.usage.completionTokens !== undefined ? { completionTokens: outcome.usage.completionTokens } : {}),
                  ...(outcome.usage.totalTokens !== undefined ? { totalTokens: outcome.usage.totalTokens } : {}),
                  ...(outcome.usage.tokenUsageSource ? { tokenUsageSource: outcome.usage.tokenUsageSource } : {}),
                }
              : {}),
            updatedAt: now,
          },
        });
      } catch (error) {
        throw new RequestAuditStorageError(
          `AI 请求回执结算失败: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    },

    async recordParseDiagnostic({ requestId, kind, detail }) {
      if (!requestId) return;
      // F8：确定性持久化；存储失败按终态审计失败上抛（不引入额外付费重试，
      // 网关对非 InvalidJson 解析错误立即终止，不做解析重试或熔断回退）。
      await prisma.aiRequestReceipt.update({
        where: { requestId },
        data: {
          parseDiagnosticJson: JSON.stringify({ kind, detail: redact(detail).text, at: new Date().toISOString() }),
        },
      }).catch((error) => {
        throw new RequestAuditStorageError(
          `AI 解析诊断持久化失败: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      });
    },
  };
}

export type DailyBudgetSnapshot = {
  day: string;
  admitted: number;
  /**
   * 生效上限数值：null 表示没有已配置的有效数字（unlimited 或 invalid），
   * 二者必须通过 state 区分，invalid 绝不伪装为 unlimited。
   */
  limit: number | null;
  /** 生效状态：unlimited | paused | limited | invalid；来源是环境变量而非 DB 配置。 */
  state: AiRequestBudgetState;
  /** 预算来源环境变量名；便于诊断确认当前生效口径。 */
  sourceEnv: string;
};

export async function getDailyBudgetSnapshot(now = new Date()): Promise<DailyBudgetSnapshot> {
  const day = utcDay(now);
  const [row, limit] = await Promise.all([
    prisma.aiRequestBudgetDay.findUnique({ where: { day } }),
    Promise.resolve(readDailyChatRequestLimitStrict()),
  ]);
  return {
    day,
    admitted: row?.admitted ?? 0,
    limit: limit.kind === "limit" ? limit.value : null,
    state: limit.state,
    sourceEnv: AI_DAILY_CHAT_REQUEST_LIMIT_ENV,
  };
}

export type AdminAiRequestItem = {
  requestId: string;
  operation: string;
  attemptType: string;
  model: string;
  status: string;
  finishReason: string | null;
  errorKind: string | null;
  errorMessage: string | null;
  responseTruncated: boolean;
  parseDiagnostic: { kind: string; detail: string; at: string } | null;
  taskRunId: string | null;
  stepId: string | null;
  workflowId: string | null;
  workflowRunId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  tokenUsageSource: string | null;
  createdAt: string;
  updatedAt: string;
};

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

/** 有界分页 + 任务过滤；绝不返回原始 prompt、密钥或未脱敏错误。 */
export async function listAdminAiRequests(input: {
  taskRunId?: string | null;
  limit?: number | null;
  offset?: number | null;
  now?: Date;
}): Promise<{ requests: AdminAiRequestItem[]; total: number; budget: DailyBudgetSnapshot }> {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, input.limit ?? DEFAULT_PAGE_SIZE));
  const offset = Math.max(0, input.offset ?? 0);
  const where = input.taskRunId ? { taskRunId: input.taskRunId } : {};
  const [rows, total, budget] = await Promise.all([
    prisma.aiRequestReceipt.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.aiRequestReceipt.count({ where }),
    getDailyBudgetSnapshot(input.now),
  ]);
  return {
    requests: rows.map((row) => ({
      requestId: row.requestId,
      operation: row.operation,
      attemptType: row.attemptType,
      model: row.model,
      status: row.status,
      finishReason: row.finishReason,
      errorKind: row.errorKind,
      errorMessage: row.errorMessage,
      responseTruncated: row.responseTruncated,
      parseDiagnostic: row.parseDiagnosticJson
        ? safeParseDiagnostic(row.parseDiagnosticJson)
        : null,
      taskRunId: row.taskRunId,
      stepId: row.stepId,
      workflowId: row.workflowId,
      workflowRunId: row.workflowRunId,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
      tokenUsageSource: row.tokenUsageSource,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    total,
    budget,
  };
}

function safeParseDiagnostic(value: string) {
  try {
    const parsed = JSON.parse(value) as { kind?: unknown; detail?: unknown; at?: unknown };
    if (typeof parsed.kind !== "string") return null;
    return {
      kind: parsed.kind,
      detail: typeof parsed.detail === "string" ? parsed.detail : "",
      at: typeof parsed.at === "string" ? parsed.at : "",
    };
  } catch {
    return null;
  }
}
