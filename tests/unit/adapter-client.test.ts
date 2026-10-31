import { describe, expect, it, vi } from "vitest";
import { AdapterClient, AdapterError } from "@/lib/adapter/client";

describe("adapter client", () => {
  const config = { baseUrl: "http://adapter:8080", token: "test-token", instanceId: "local" };

  it("uses authentication and escapes lookup parameters", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ subscription: null }), { status: 200 }));
    const client = new AdapterClient(config, fetcher);
    await expect(client.lookup("wechat", "a+/=")).resolves.toEqual({ subscription: null });
    expect(fetcher.mock.calls[0][0]).toBe("http://adapter:8080/v1/subscriptions?providerId=wechat&accountId=a%2B%2F%3D");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error", headers: { authorization: "Bearer test-token" } });
  });

  it("preserves retryable upstream errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "稍后重试", retryable: true, retryAfterSeconds: 60 } }), { status: 429 }));
    const client = new AdapterClient(config, fetcher);
    await expect(client.providers()).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 60 });
  });

  it("reports unknown result on transport failure", async () => {
    const client = new AdapterClient(config, vi.fn().mockRejectedValue(new Error("secret upstream detail")));
    await expect(client.ensure("wechat", { accountId: "YWJj", name: "A" })).rejects.toBeInstanceOf(AdapterError);
    await expect(client.ensure("wechat", { accountId: "YWJj", name: "A" })).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
  });
});
