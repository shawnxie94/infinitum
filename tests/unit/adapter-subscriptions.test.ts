import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ensure: vi.fn(), lookup: vi.fn(), providers: vi.fn(), transaction: vi.fn(), invalidate: vi.fn(), legacy: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: mocks.transaction, source: { findMany: mocks.legacy } } }));
vi.mock("@/lib/feed/cache", () => ({ invalidateFeedCache: mocks.invalidate }));
vi.mock("@/lib/adapter/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/adapter/client")>();
  return { ...actual, readAdapterConfig: vi.fn().mockResolvedValue({ baseUrl: "http://adapter", token: "token", instanceId: "test" }), AdapterClient: class { ensure = mocks.ensure; lookup = mocks.lookup; providers = mocks.providers; } };
});

import { AdapterError } from "@/lib/adapter/client";
import { followAdapterAccount } from "@/lib/adapter/subscriptions";

describe("adapter subscription reconciliation", () => {
  beforeEach(() => vi.clearAllMocks());
  it("queries before returning an unknown ensure result", async () => {
    mocks.ensure.mockRejectedValue(new AdapterError("UNAVAILABLE", "timeout", true));
    mocks.lookup.mockResolvedValue({ subscription: null });
    await expect(followAdapterAccount("wechat", { accountId: "YWJj", name: "A" })).rejects.toMatchObject({ code: "UNKNOWN_RESULT" });
    expect(mocks.lookup).toHaveBeenCalledWith("wechat", "YWJj");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("rejects a mismatched subscription before local mutation", async () => {
    mocks.ensure.mockResolvedValue({ subscription: { providerId: "wechat", accountId: "other" } });
    await expect(followAdapterAccount("wechat", { accountId: "YWJj", name: "A" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("requires migration before creating a duplicate legacy source", async () => {
    mocks.legacy.mockResolvedValueOnce([{ rssUrl: "http://rsshub:1200/xueqiu/user/123" }]);
    await expect(followAdapterAccount("xueqiu", { accountId: "123", name: "A" })).rejects.toMatchObject({ code: "MIGRATION_REQUIRED" });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("creates a source and follow only after upstream identity is confirmed", async () => {
    const account = { accountId: "123", name: "A" };
    mocks.ensure.mockResolvedValue({ subscription: { id: "sub", providerId: "xueqiu", accountId: "123", account, status: { state: "pending" } } });
    mocks.providers.mockResolvedValue({ providers: [{ id: "xueqiu", name: "雪球" }] });
    const create = vi.fn().mockResolvedValue({ id: "source", transport: "adapter" });
    mocks.transaction.mockImplementation(async (fn) => fn({ source: { findMany: mocks.legacy, create }, adapterSourceBinding: { findUnique: vi.fn().mockResolvedValue(null) } }));
    await expect(followAdapterAccount("xueqiu", account)).resolves.toMatchObject({ id: "source" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ rssUrl: null, transport: "adapter", channel: "雪球", follow: { create: {} } }) }));
    expect(mocks.invalidate).toHaveBeenCalled();
  });
});
