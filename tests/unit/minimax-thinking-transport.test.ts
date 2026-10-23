import { describe, expect, it, vi } from "vitest";

import { createAiSdkTransport, type WireCompletionResponse } from "@/../packages/ai/src/provider/transports";
import type { ModelApiConfig } from "@/../packages/ai/src/provider/types";

function minimaxConfig(model: string): ModelApiConfig {
  return { apiKey: "test-key", baseURL: "https://api.minimaxi.com/v1", model };
}

function wireResponse(): Response {
  const body: WireCompletionResponse = {
    choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
  } as unknown as WireCompletionResponse;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("MiniMax thinking switch per model generation", () => {
  it("keeps injecting thinking=disabled for legacy MiniMax models (M3)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return wireResponse();
    }) as unknown as typeof fetch;
    const transport = createAiSdkTransport({ fetch: fetchMock, maxRetries: 0 });

    await transport({ messages: [{ role: "user", content: "hi" }] }, minimaxConfig("MiniMax-M3"));

    const thinking = (bodies[0]?.thinking ?? null) as { type?: string } | null;
    expect(thinking?.type).toBe("disabled");
  });

  it("omits the thinking switch for adaptive models (M3.1) that reject explicit disabled", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return wireResponse();
    }) as unknown as typeof fetch;
    const transport = createAiSdkTransport({ fetch: fetchMock, maxRetries: 0 });

    await transport({ messages: [{ role: "user", content: "hi" }] }, minimaxConfig("MiniMax-M3.1-Flash"));

    expect(bodies[0]).not.toHaveProperty("thinking");
  });
});
