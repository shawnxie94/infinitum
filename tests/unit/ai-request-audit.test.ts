import { describe, expect, it, vi } from "vitest";

import {
  classifyTransportOutcome,
  createCompatClientTransport,
  isTerminalTransportError,
  UnknownTransportOutcomeError,
  TransportAdmissionError,
} from "@infinitum/ai/provider/transports";
import { createModelGateway } from "@infinitum/ai/provider/gateway";
import type { TransportAuditHooks } from "@infinitum/ai/provider/types";

import {
  normalizeDailyChatRequestLimit,
  sanitizeAuditText,
  validateDailyChatRequestLimit,
  AI_RAW_MAX_BYTES,
} from "@/lib/ai/request-audit";

function createCompatClient(behavior: () => Promise<unknown>) {
  return { chat: { completions: { create: vi.fn(behavior) } } };
}

function createHooks() {
  const admitted: Array<{ requestId: string; attemptIndex: number; attemptType: string }> = [];
  const settled: Array<{ requestId: string; status: string; finishReason?: string | null }> = [];
  let denial: Error | null = null;
  const hooks: TransportAuditHooks = {
    async beforeDispatch(context) {
      if (denial) throw denial;
      admitted.push({ requestId: context.requestId, attemptIndex: context.attemptIndex, attemptType: context.attemptType });
    },
    async settle(context, outcome) {
      settled.push({ requestId: context.requestId, status: outcome.status, finishReason: outcome.finishReason });
    },
  };
  return { hooks, admitted, settled, setDenial: (error: Error | null) => { denial = error; } };
}

function createGateway(behavior: () => Promise<unknown>, hooks: TransportAuditHooks, options?: { maxRetries?: number }) {
  const client = createCompatClient(behavior);
  const transport = createCompatClientTransport(client, { maxRetries: options?.maxRetries ?? 1, auditHooks: hooks });
  return {
    gateway: createModelGateway({
      defaultModelApi: { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      transport,
      auditHooks: hooks,
    }),
    client,
  };
}

const JSON_OK = JSON.stringify({ summary: "示例摘要，包含明确事实。" });

function jsonResponse(content: string) {
  return { choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}

describe("AI 请求审计（单元）", () => {
  it("sanitizeAuditText 先脱敏后限界，完整替换不留凭据前缀，支持已知密钥字面量", () => {
    const { text } = sanitizeAuditText(
      '配置 {"apiKey":"sk-abcdef1234567890","nested":{"authorization":"Bearer zzzyyywwwxxx"}}',
    );
    expect(text).not.toContain("sk-abcdef1234567890");
    // 修复 F3：不再保留 match.slice(0,12) 前缀，密钥整体替换。
    expect(text).not.toContain("sk-abcdef12");
    expect(text).not.toContain("Bearer zzzyyywwwxxx");
    expect(text).toContain("[已脱敏]");

    // 任意格式已知密钥字面量（非 sk-/Bearer 形态）也被完整替换。
    const echoed = sanitizeAuditText(
      'upstream error echoed mykey1234567890 in body',
      ["mykey1234567890"],
    );
    expect(echoed.text).not.toContain("mykey1234567890");
    expect(echoed.text).toContain("[已脱敏]");

    const huge = "x".repeat(AI_RAW_MAX_BYTES * 3);
    const bounded = sanitizeAuditText(`sk-secret12345678 ${huge}`, ["sk-secret12345678"]);
    expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(AI_RAW_MAX_BYTES);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text.endsWith("[已截断]")).toBe(true);
    expect(bounded.text).not.toContain("sk-secret12345678");
  });

  it("每日上限口径：null=不限，0=暂停，正整数保留；非法写入值被拒绝", () => {
    expect(normalizeDailyChatRequestLimit(null)).toBeNull();
    expect(normalizeDailyChatRequestLimit(undefined)).toBeNull();
    expect(normalizeDailyChatRequestLimit(0)).toBe(0);
    expect(normalizeDailyChatRequestLimit(5)).toBe(5);
    expect(normalizeDailyChatRequestLimit(-1)).toBeNull();
    expect(normalizeDailyChatRequestLimit(1.5)).toBeNull();
    expect(normalizeDailyChatRequestLimit(Number.NaN)).toBeNull();

    expect(validateDailyChatRequestLimit(null)).toBeNull();
    expect(validateDailyChatRequestLimit(0)).toBe(0);
    expect(() => validateDailyChatRequestLimit(-1)).toThrow();
    expect(() => validateDailyChatRequestLimit(2.5)).toThrow();
  });

  it("每次真实传输调用都先过准入；unknown 结局不重试", async () => {
    const { hooks, admitted, settled } = createHooks();
    const { gateway, client } = createGateway(() => {
      const error = new Error("request timed out");
      error.name = "TimeoutError";
      return Promise.reject(error);
    }, hooks);

    await expect(
      gateway.completeJson(
        { taskType: "cluster_summary", systemPrompt: "s", userContent: "u", usageKey: "cluster_summary" },
        () => JSON.parse("{}"),
      ),
    ).rejects.toBeInstanceOf(UnknownTransportOutcomeError);

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(admitted).toHaveLength(1);
    expect(settled).toHaveLength(1);
    expect(settled[0].status).toBe("unknown");
  });

  it("已知瞬时失败在准入内受控重试，每次真实调用单独准入与回执", async () => {
    const { hooks, admitted, settled } = createHooks();
    let calls = 0;
    const { gateway, client } = createGateway(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(Object.assign(new Error("rate limited"), { status: 429 }));
      }
      return Promise.resolve(jsonResponse(JSON_OK));
    }, hooks);

    const result = await gateway.completeJson(
      { taskType: "cluster_summary", systemPrompt: "s", userContent: "u", usageKey: "cluster_summary" },
      (output) => JSON.parse(output) as unknown,
    );

    expect(result).toEqual(JSON.parse(JSON_OK));
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(admitted).toHaveLength(2);
    expect(admitted.map((entry) => entry.attemptIndex)).toEqual([0, 1]);
    expect(settled.map((entry) => entry.status)).toEqual(["failed", "succeeded"]);
  });

  it("预算拒绝阻断派发，不发生真实调用", async () => {
    const { hooks, admitted, setDenial } = createHooks();
    const { gateway, client } = createGateway(() => Promise.resolve(jsonResponse(JSON_OK)), hooks);
    setDenial(Object.assign(new Error("上限已满"), { name: "RequestBudgetExceededError" }));

    await expect(
      gateway.completeJson(
        { taskType: "cluster_summary", systemPrompt: "s", userContent: "u", usageKey: "cluster_summary" },
        (output) => JSON.parse(output) as unknown,
      ),
    ).rejects.toBeInstanceOf(TransportAdmissionError);

    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(admitted).toHaveLength(0);
  });

  it("域级模型回退的每一次真实调用都被单独准入", async () => {
    const { hooks, admitted } = createHooks();
    let calls = 0;
    const client = createCompatClient(() => {
      calls += 1;
      if (calls === 1) {
        // 非默认模型 500：触发熔断窗口内的域级回退（第二次真实调用走默认模型）。
        return Promise.reject(Object.assign(new Error("boom"), { status: 500 }));
      }
      return Promise.resolve(jsonResponse(JSON_OK));
    });
    const defaultConfig = { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "default-model" };
    const gateway = createModelGateway({
      defaultModelApi: defaultConfig,
      transport: createCompatClientTransport(client, { maxRetries: 0, auditHooks: hooks }),
      auditHooks: hooks,
      circuitBreaker: { failureThreshold: 1, windowMs: 60_000, openMs: 180_000 },
    });

    const result = await gateway.completeText(
      { messages: [{ role: "user", content: "u" }], usageKey: "cluster_summary" },
      { config: { apiKey: "sk-test", baseURL: "https://alt.example.com/v1", model: "alt-model" }, attemptType: "initial" },
    );

    expect(result?.text).toBe(JSON_OK);
    expect(admitted).toHaveLength(2);
    expect(admitted[0].attemptIndex).toBe(0);
  });

  it("分类器：拿到状态码 = 已知失败；超时/网络 = unknown", () => {
    expect(classifyTransportOutcome(Object.assign(new Error("x"), { status: 400 }))).toBe("failed");
    expect(classifyTransportOutcome(new Error("request aborted"))).toBe("unknown");
    expect(classifyTransportOutcome(new Error("ECONNRESET"))).toBe("unknown");
    expect(classifyTransportOutcome(new Error("bad code path"))).toBe("failed");
    expect(isTerminalTransportError(new TransportAdmissionError("budget_exhausted", "x"))).toBe(true);
    expect(isTerminalTransportError(new UnknownTransportOutcomeError("x"))).toBe(true);
    expect(isTerminalTransportError(new Error("x"))).toBe(false);
  });
});
