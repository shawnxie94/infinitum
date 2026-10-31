import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), start: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/admin/session", () => ({ requireAdmin: mocks.requireAdmin, AdminAuthError: class extends Error { status = 401; } }));
vi.mock("@/lib/daily-report/manual-generation", () => ({ startManualDailyGeneration: mocks.start, getManualDailyGeneration: mocks.get }));
import { GET, POST } from "@/app/api/outside/daily/generate/route";

describe("outside daily generation route", () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it("requires admin authorization before starting", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("Unauthorized"));
    const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ date: "2026-04-24" }) }));
    expect(response.status).toBe(401);
    expect(mocks.start).not.toHaveBeenCalled();
    expect((await GET()).status).toBe(401);
  });
  it("reports a conflict without claiming a task was started", async () => {
    const conflict = Object.assign(new Error("已有抓取任务正在进行，请完成后重试生成日报。"), { status: 409 });
    mocks.start.mockRejectedValue(conflict);
    const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ date: "2026-04-24" }) }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("已有抓取任务");
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("returns persisted generation state", async () => {
    mocks.get.mockResolvedValue({ id: "1", date: "2026-04-24", status: "queued", phase: "fetch" });
    const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ date: "2026-04-24" }) }));
    expect(response.status).toBe(202);
    expect(mocks.start).toHaveBeenCalledWith("2026-04-24");
    expect((await response.json()).generation.phase).toBe("fetch");
  });
});
