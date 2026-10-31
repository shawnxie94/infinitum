import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/admin/session", () => ({ requireAdmin: vi.fn(), AdminAuthError: class extends Error { status = 401; } }));
vi.mock("@/lib/sources/eastmoney", () => ({ lookupEastmoney: vi.fn(), followEastmoney: vi.fn() }));
vi.mock("@/lib/sources/wechat", () => ({ searchWechat: vi.fn(), followWechat: vi.fn() }));
import { requireAdmin } from "@/lib/admin/session";
import { followWechat } from "@/lib/sources/wechat";
import { followEastmoney } from "@/lib/sources/eastmoney";
import { POST as eastPost } from "@/app/api/outside/eastmoney/route";
import { POST as wechatPost } from "@/app/api/outside/wechat/route";
const req = () => new Request("http://localhost/api", { method: "POST", body: JSON.stringify({ action: "follow", query: "123" }) });
describe("账号入口鉴权", () => {
  beforeEach(() => vi.resetAllMocks());
  it("未认证不能查找或关注", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Unauthorized"));
    expect((await eastPost(req())).status).toBe(401);
    expect((await wechatPost(req())).status).toBe(401);
    expect(followEastmoney).not.toHaveBeenCalled();
    expect(followWechat).not.toHaveBeenCalled();
  });
});
