import { describe, expect, it, vi } from "vitest";
import { createAiSdkTransport, createCompatClientTransport } from "@infinitum/ai/provider/transports";

describe("custom params transports", () => {
  it("merges SDK extensions into actual HTTP bodies and isolates provider captures", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const payload = { choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ ok: true }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
    const transport = createAiSdkTransport({ fetch: fetchMock, maxRetries: 0 });
    const request = { messages: [{ role: "user" as const, content: "x" }] };
    await transport(request, { model: "m", baseURL: "https://example.test/v1", apiKey: "k", customRequestParams: { reasoning_effort: "high" } });
    await transport(request, { model: "m", baseURL: "https://example.test/v1", apiKey: "k", customRequestParams: { reasoning_effort: "low" } });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ model: "m", reasoning_effort: "high" });
    expect(bodies[1]).toMatchObject({ model: "m", reasoning_effort: "low" });
  });
  it("merges compat extensions at wire while preserving core fields", async () => {
    const create = vi.fn(async (_wire: Record<string, unknown>) => { void _wire; return { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }; });
    const transport = createCompatClientTransport({ chat: { completions: { create } } }, { maxRetries: 0 });
    await transport({ messages: [{ role: "user", content: "x" }], maxTokens: 7 }, { model: "m", customRequestParams: { reasoning_effort: "high", temperature: 0.9 } });
    expect(create.mock.calls[0][0]).toMatchObject({ model: "m", max_tokens: 7, reasoning_effort: "high", temperature: 0.9 });
  });
});
