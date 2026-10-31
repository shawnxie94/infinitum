import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: { source: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) }, adapterSourceBinding: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) }, sourceFollow: { upsert: vi.fn() }, $transaction: vi.fn() } }));
import { prisma } from "@/lib/db";
import { followEastmoney, lookupEastmoney, parseEastmoneyUid } from "@/lib/sources/eastmoney";
import { followWechat, searchWechat } from "@/lib/sources/wechat";

describe("账号源", () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.RSSHUB_BASE_URL; delete process.env.WERSS_BASE_URL; delete process.env.WERSS_BRIDGE_URL; });
  it("东方财富只接受 UID 或可信主页并校验 RSS 身份", async () => {
    expect(parseEastmoneyUid("https://i.eastmoney.com/2922094262312522#guba")).toBe("2922094262312522");
    for (const value of ["https://i.eastmoney.com.evil.test/123", "http://i.eastmoney.com/123", "https://i.eastmoney.com/123?x=1", "../123"]) expect(parseEastmoneyUid(value)).toBeNull();
    process.env.RSSHUB_BASE_URL = "http://rsshub:1200";
    vi.mocked(prisma.source.findFirst).mockResolvedValue(null);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('<rss version="2.0"><channel><title>东方财富证券 的东财帖子</title><link>https://i.eastmoney.com/2922094262312522#guba</link><description>帖子</description></channel></rss>'));
    expect(await lookupEastmoney("2922094262312522")).toMatchObject({ name: "东方财富证券", followed: false });
    await expect(lookupEastmoney("昵称")).rejects.toThrow("昵称搜索暂不可用");
  });
  it("东方财富复用既有源，不修改停用状态或类别", async () => {
    process.env.RSSHUB_BASE_URL = "http://rsshub:1200";
    const source = { id: "preset", name: "已有账号", enabled: false, originKind: "preset", follow: null };
    vi.mocked(prisma.source.findFirst).mockResolvedValue(source as never);
    const tx = { source: { findFirst: vi.fn().mockResolvedValue(source), upsert: vi.fn() }, sourceFollow: { upsert: vi.fn() } };
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: unknown) => (cb as (v: typeof tx) => Promise<unknown>)(tx) as never);
    await followEastmoney("2922094262312522");
    expect(tx.source.upsert).not.toHaveBeenCalled();
    expect(tx.sourceFollow.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { sourceId: "preset" }, update: {} }));
  });
  it("公众号仅允许已搜索候选被选择，先查重复并避免重写", async () => {
    process.env.WERSS_BASE_URL = "http://werss:8001"; process.env.WERSS_BRIDGE_URL = "http://bridge:18765";
    const tx = { source: { findFirst: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({ id: "s1" }) }, sourceFollow: { upsert: vi.fn() } };
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: unknown) => (cb as (v: typeof tx) => Promise<unknown>)(tx) as never);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/search/")) return Response.json({ code: 0, data: { list: [{ fakeid: "YWJjMTIz", nickname: "公众号甲", signature: "简介" }] } });
      return Response.json({ code: 0, data: { total: 1, list: [{ id: "MP_WXS_abc123" }] } });
    });
    await expect(followWechat("YWJjNDU2")).rejects.toThrow("重新搜索");
    expect((await searchWechat("公众号")).candidates[0].name).toBe("公众号甲");
    await followWechat("YWJjMTIz");
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    expect(tx.source.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { rssUrl: "http://werss:8001/feed/MP_WXS_abc123.xml" }, update: {} }));
    expect(tx.sourceFollow.upsert).toHaveBeenCalled();
  });
  it("公众号重复候选去重并标记本地关注", async () => {
    process.env.WERSS_BRIDGE_URL = "http://bridge:18765";
    vi.mocked(prisma.source.findMany).mockResolvedValueOnce([{ rssUrl: "http://old:8001/feed/MP_WXS_jkl321.xml", follow: { sourceId: "s" } }] as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ code: 0, data: { list: [{ fakeid: "amtsMzIx", nickname: "甲" }, { fakeid: "amtsMzIx", nickname: "甲" }] } }));
    expect((await searchWechat("甲")).candidates).toEqual([{ uid: "amtsMzIx", name: "甲", description: "", followed: true }]);
  });
  it("空搜索提示上游不可区分风控，错误不当空结果", async () => {
    process.env.WERSS_BRIDGE_URL = "http://bridge:18765";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ code: 0, data: { list: [] } })).mockResolvedValueOnce(new Response("denied", { status: 401 }));
    expect((await searchWechat("空" )).warning).toContain("未授权或受限");
    await expect(searchWechat("拒绝")).rejects.toThrow("未授权");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("选择新公众号仅添加一次，避免传入头像 URL", async () => {
    process.env.WERSS_BASE_URL = "http://werss:8001"; process.env.WERSS_BRIDGE_URL = "http://bridge:18765";
    const tx = { source: { findFirst: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({ id: "s2" }) }, sourceFollow: { upsert: vi.fn() } };
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: unknown) => (cb as (v: typeof tx) => Promise<unknown>)(tx) as never);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("/search/")) return Response.json({ code: 0, data: { list: [{ fakeid: "ZGVmNDU2", nickname: "公众号乙", avatar: "http://evil/" }] } });
      if (init?.method === "POST") return Response.json({ code: 0, data: { id: "MP_WXS_def456" } });
      return Response.json({ code: 0, data: { total: 0, list: [] } });
    });
    await searchWechat("公众号乙");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await followWechat("ZGVmNDU2");
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body))).toMatchObject({ avatar: "", mp_cover: "" });
  });  it("列表失败或提交结果不明时不重放订阅写入", async () => {
    process.env.WERSS_BASE_URL = "http://werss:8001"; process.env.WERSS_BRIDGE_URL = "http://bridge:18765";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("/search/")) return Response.json({ code: 0, data: { list: [{ fakeid: "Z2hpNzg5", nickname: "公众号丙" }] } });
      if (init?.method === "POST") throw new Error("connection lost");
      return Response.json({ code: 0, data: { total: 0, list: [] } });
    });
    await searchWechat("公众号丙");
    await expect(followWechat("Z2hpNzg5")).rejects.toThrow("操作结果请先查询");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

});
