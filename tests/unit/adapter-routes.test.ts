import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), migrate: vi.fn(), rollback: vi.fn() }));
vi.mock("@/lib/admin/session", () => ({ requireAdmin: mocks.auth, AdminAuthError: class extends Error { status = 401; } }));
vi.mock("@/lib/adapter/migration", () => ({ migrateAdapterSource: mocks.migrate, rollbackAdapterSource: mocks.rollback }));
import { POST } from "@/app/api/admin/settings/sources/[id]/adapter-migration/route";

describe("adapter source migration route", () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it("rejects unauthenticated migration without changing a source", async () => {
    mocks.auth.mockRejectedValue(new Error("Unauthorized"));
    const response = await POST(new Request("http://local", { method: "POST", body: JSON.stringify({ action: "rollback" }) }), { params: Promise.resolve({ id: "source" }) });
    expect(response.status).toBe(401);
    expect(mocks.rollback).not.toHaveBeenCalled();
  });
  it("passes the explicitly selected account to migration", async () => {
    mocks.auth.mockResolvedValue(undefined);
    mocks.migrate.mockResolvedValue({ id: "source" });
    const account = { accountId: "123", name: "A" };
    const response = await POST(new Request("http://local", { method: "POST", body: JSON.stringify({ action: "migrate", providerId: "xueqiu", account }) }), { params: Promise.resolve({ id: "source" }) });
    expect(response.status).toBe(200);
    expect(mocks.migrate).toHaveBeenCalledWith("source", "xueqiu", account);
  });
});
