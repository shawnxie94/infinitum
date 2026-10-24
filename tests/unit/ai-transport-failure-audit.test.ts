import { describe, expect, it, vi } from "vitest";
import { APICallError, NoOutputGeneratedError } from "ai";
import { z } from "zod";

import { createAiSdkTransport, createCompatClientTransport } from "@infinitum/ai/provider/transports";
import type { TransportAttemptContext, TransportAttemptOutcome } from "@infinitum/ai/provider/types";

const config = { apiKey: "sk-secret-abcdefghijklmnop", baseURL: "https://example.test/v1", model: "test-model" };

function hooks() {
  const settled: TransportAttemptOutcome[] = [];
  const auditHooks = {
    beforeDispatch: vi.fn(async () => undefined),
    settle: vi.fn(async (context: TransportAttemptContext, outcome: TransportAttemptOutcome) => { void context; settled.push(outcome); }),
  };
  return { auditHooks, settled };
}

describe("AI SDK failed request audit", () => {
  it("captures APICallError response body on the production SDK path without retrying known non-retryable failures", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad key sk-secret-abcdefghijklmnop" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    const { auditHooks, settled } = hooks();
    const transport = createAiSdkTransport({ fetch: fetch as unknown as typeof globalThis.fetch, maxRetries: 1, auditHooks });

    await expect(transport({ messages: [{ role: "user", content: "request" }] }, config)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(settled[0]).toMatchObject({ status: "failed", errorName: "AI_APICallError", rawText: expect.stringContaining("bad key") });
    expect(settled[0].finishReason).toBeUndefined();
    expect(settled[0].usage).toBeUndefined();
  });

  it("leaves unknown network outcomes unknown and never retries them", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const { auditHooks, settled } = hooks();
    const transport = createAiSdkTransport({ fetch: fetch as unknown as typeof globalThis.fetch, maxRetries: 2, auditHooks });

    await expect(transport({ messages: [{ role: "user", content: "request" }] }, config)).rejects.toMatchObject({ name: "UnknownTransportOutcomeError" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ status: "unknown", errorName: "TypeError" });
  });

  it("captures NoObjectGeneratedError finish reason and complete reported usage on the production structured path", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl-filtered",
      choices: [{ index: 0, finish_reason: "content_filter", message: { role: "assistant", content: null } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const { auditHooks, settled } = hooks();
    const transport = createAiSdkTransport({
      fetch: fetch as unknown as typeof globalThis.fetch,
      maxRetries: 0,
      supportsStructuredOutputs: true,
      auditHooks,
    });

    await expect(transport({
      messages: [{ role: "user", content: "request" }],
      schema: z.object({ answer: z.string() }),
    }, config)).rejects.toThrow();
    expect(settled[0]).toMatchObject({
      status: "failed",
      errorName: "AI_NoObjectGeneratedError",
      finishReason: "content-filter",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, tokenUsageSource: "provider" },
    });
    expect(settled[0].rawText).toBeUndefined();
  });

  it("uses raw provider usage for a partial NoObjectGeneratedError without SDK-derived total", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl-partial",
      choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "not-json" } }],
      usage: { prompt_tokens: 8, completion_tokens: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const { auditHooks, settled } = hooks();
    const transport = createAiSdkTransport({
      fetch: fetch as unknown as typeof globalThis.fetch,
      maxRetries: 0,
      supportsStructuredOutputs: true,
      auditHooks,
    });

    await expect(transport({
      messages: [{ role: "user", content: "request" }],
      schema: z.object({ answer: z.string() }),
    }, config)).rejects.toMatchObject({ name: "AI_NoObjectGeneratedError" });
    expect(settled[0]).toMatchObject({
      status: "failed",
      errorName: "AI_NoObjectGeneratedError",
      finishReason: "length",
      usage: { promptTokens: 8, completionTokens: 0, tokenUsageSource: "provider" },
    });
    expect(settled[0].usage).not.toHaveProperty("totalTokens");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("extracts nested partial provider usage without estimating missing values, preserving zero and rejecting invalid counts", async () => {
    const partial = Object.assign(new Error("nested provider diagnostics"), {
      // Without raw provider usage, totalTokens may already be SDK-derived.
      usage: { inputTokens: 0, outputTokens: 7, totalTokens: 7 },
    });
    const { auditHooks, settled } = hooks();
    const client = { chat: { completions: { create: vi.fn(async () => { throw new NoOutputGeneratedError({ cause: partial }); }) } } };
    const transport = createCompatClientTransport(client, { maxRetries: 0, auditHooks });

    await expect(transport({ messages: [{ role: "user", content: "request" }] }, config)).rejects.toThrow();
    expect(settled[0]).toMatchObject({
      status: "failed",
      errorName: "AI_NoOutputGeneratedError",
      usage: { promptTokens: 0, completionTokens: 7, tokenUsageSource: "provider" },
    });
    expect(settled[0].usage).not.toHaveProperty("totalTokens");
  });

  it("bounds and cycle-protects cause traversal, ignores estimated/mixed usage and missing usage", async () => {
    const tooDeep = Object.assign(new Error("beyond depth limit"), {
      finishReason: "must-not-be-seen",
      usage: { inputTokens: 99, tokenUsageSource: "provider" },
    });
    const nodes = Array.from({ length: 4 }, () => new Error("nested"));
    nodes.forEach((node, index) => Object.defineProperty(node, "cause", {
      value: nodes[index + 1] ?? tooDeep,
      configurable: true,
    }));
    Object.assign(nodes[0], { usage: { inputTokens: 3.5, outputTokens: -1, totalTokens: Number.MAX_SAFE_INTEGER + 1 } });
    Object.assign(nodes[1], { usage: { inputTokens: 88, tokenUsageSource: "mixed" } });
    const cyclicRoot = Object.assign(new Error("cycle root"), {
      finishReason: "length",
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9, tokenUsageSource: "estimated" },
      cause: nodes[0],
    });
    Object.defineProperty(nodes[3], "cause", { value: cyclicRoot, configurable: true });
    const { auditHooks, settled } = hooks();
    const client = { chat: { completions: { create: vi.fn(async () => { throw new APICallError({
      message: "outer API failure",
      url: "https://example.test/v1/chat/completions",
      requestBodyValues: {},
      cause: cyclicRoot,
    }); }) } } };
    const transport = createCompatClientTransport(client, { maxRetries: 0, auditHooks });

    await expect(transport({ messages: [{ role: "user", content: "request" }] }, config)).rejects.toThrow();
    expect(settled[0]).toMatchObject({ status: "failed", errorName: "AI_APICallError", finishReason: "length" });
    expect(settled[0].usage).toBeUndefined();

    const deepTerminal = Object.assign(new Error("outside depth bound"), { finishReason: "unreachable" });
    const deepNodes = Array.from({ length: 6 }, () => new Error("deep"));
    deepNodes.forEach((node, index) => Object.defineProperty(node, "cause", {
      value: deepNodes[index + 1] ?? deepTerminal,
      configurable: true,
    }));
    const deepClient = { chat: { completions: { create: vi.fn(async () => { throw new Error("root", { cause: deepNodes[0] }); }) } } };
    await expect(createCompatClientTransport(deepClient, { maxRetries: 0, auditHooks })(
      { messages: [{ role: "user", content: "request" }] }, config,
    )).rejects.toThrow();
    expect(settled[1].finishReason).toBeUndefined();
    expect(settled[1].usage).toBeUndefined();
  });
});
