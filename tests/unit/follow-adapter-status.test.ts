import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), config: vi.fn(), subscription: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { source: { findMany: mocks.findMany } } }));
vi.mock("@/lib/adapter/client", () => ({ readAdapterConfig: mocks.config, AdapterClient: class { subscription = mocks.subscription; } }));
import { listSourceCatalog } from "@/lib/sources/follows";

function source(id: string, transport = "adapter") {
  return { id, name: id, siteUrl: "", enabled: true, channel: null, originKind: "account", transport, healthStatus: "healthy", healthMessage: "old", group: null, follow: { followedAt: new Date() }, adapterBinding: transport === "adapter" ? { adapterInstanceId: "local", subscriptionId: id, providerId: "p", accountId: id } : null };
}

describe("live followed adapter status", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.config.mockResolvedValue({ instanceId: "local" }); });
  it("uses live pending, ok and error while leaving RSS health unchanged", async () => {
    mocks.findMany.mockResolvedValue([source("pending"), source("ok"), source("error"), source("rss", "rss")]);
    mocks.subscription.mockImplementation(async (id: string) => ({ subscription: { id, providerId: "p", accountId: id, status: { state: id } } }));
    const rows = await listSourceCatalog({ liveAdapterStatus: true });
    expect(rows.map((row) => [row.healthStatus, row.healthMessage])).toEqual([["pending", null], ["healthy", null], ["failed", "上游采集失败。"], ["healthy", "old"]]);
    expect(mocks.subscription).toHaveBeenCalledTimes(3);
  });
  it("returns unknown for failure, invalid identity and unavailable configuration", async () => {
    mocks.findMany.mockResolvedValue([source("one"), source("two")]);
    mocks.subscription.mockImplementation(async (id: string) => { if (id === "one") throw new Error(); return { subscription: { id, providerId: "wrong", accountId: id, status: { state: "ok" } } }; });
    expect((await listSourceCatalog({ liveAdapterStatus: true })).map((row) => row.healthStatus)).toEqual(["unknown", "unknown"]);
    mocks.config.mockRejectedValue(new Error());
    expect((await listSourceCatalog({ liveAdapterStatus: true })).map((row) => row.healthStatus)).toEqual(["unknown", "unknown"]);
  });
  it("limits concurrent requests and skips lookups when live status is not requested", async () => {
    mocks.findMany.mockResolvedValue(Array.from({ length: 12 }, (_, i) => source(String(i))));
    let active = 0, peak = 0;
    mocks.subscription.mockImplementation(async (id: string) => { active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 1)); active--; return { subscription: { id, providerId: "p", accountId: id, status: { state: "ok" } } }; });
    await listSourceCatalog();
    expect(mocks.subscription).not.toHaveBeenCalled();
    await listSourceCatalog({ liveAdapterStatus: true });
    expect(peak).toBeLessThanOrEqual(5);
  });
});
