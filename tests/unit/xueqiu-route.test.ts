import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin/session", () => ({ requireAdmin: vi.fn(), AdminAuthError: class extends Error { status = 401; } }));
vi.mock("@/lib/sources/xueqiu", () => ({ lookupXueqiuUser: vi.fn(), followXueqiuUser: vi.fn(), parseXueqiuUid: vi.fn(), searchXueqiuUsers: vi.fn(), markXueqiuFollowed: vi.fn() }));
import { requireAdmin } from "@/lib/admin/session";
import { lookupXueqiuUser, followXueqiuUser } from "@/lib/sources/xueqiu";
import { POST } from "@/app/api/outside/xueqiu/route";

const request = (body: unknown) => new Request("http://localhost/api/outside/xueqiu", { method: "POST", body: JSON.stringify(body) });
describe("雪球入口鉴权", () => {
  beforeEach(() => vi.resetAllMocks());
  it("拒绝未认证请求且不执行操作", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Unauthorized"));
    expect((await POST(request({ action: "follow", query: "123" }))).status).toBe(401);
    expect(followXueqiuUser).not.toHaveBeenCalled();
  });
  it("只允许明确搜索或关注", async () => {
    expect((await POST(request({ action: "invalid", query: "123" }))).status).toBe(400);
    expect(lookupXueqiuUser).not.toHaveBeenCalled();
    expect(followXueqiuUser).not.toHaveBeenCalled();
  });
});
