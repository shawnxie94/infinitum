import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { source: { findFirst: vi.fn(), findMany: vi.fn() }, $transaction: vi.fn() } }));
import { prisma } from "@/lib/db";
import { buildItemUnderstandingInput } from "@/lib/ingestion/content-input";
import { followXueqiuUser, lookupXueqiuUser, parseXueqiuUid, searchXueqiuUsers, markXueqiuFollowed } from "@/lib/sources/xueqiu";

describe("雪球用户入口", () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.RSSHUB_BASE_URL; });
  it("补抓无结果时仍使用短 RSS 正文", () => {
    expect(buildItemUnderstandingInput({ fullText: null, rssContent: "短动态正文", originalTitle: "标题" })).toContain("短动态正文");
  });
  it("只接受数字 UID 和规范主页，拒绝其他网址", () => {
    expect(parseXueqiuUid("1247347556")).toBe("1247347556");
    expect(parseXueqiuUid("https://www.xueqiu.com/u/1247347556/")).toBe("1247347556");
    for (const value of ["https://xueqiu.com.evil/u/123", "http://xueqiu.com/u/123", "https://xueqiu.com/u/123?x=1", "../123", "0001"]) expect(parseXueqiuUid(value)).toBeNull();
  });
  it("从固定 RSSHub 地址核实候选", async () => {
    process.env.RSSHUB_BASE_URL = "http://rsshub:1200";
    vi.mocked(prisma.source.findFirst).mockResolvedValue(null);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('<rss version="2.0"><channel><title>大道无形我有型 的雪球全部动态</title><link>https://xueqiu.com/u/1247347556</link><description>动态</description></channel></rss>'));
    expect(await lookupXueqiuUser("1247347556")).toMatchObject({ uid: "1247347556", name: "大道无形我有型" });
    expect(fetchMock).toHaveBeenCalledWith("http://rsshub:1200/xueqiu/user/1247347556", expect.objectContaining({ redirect: "error" }));
  });
  it("不将风控或空身份视为候选", async () => {
    process.env.RSSHUB_BASE_URL = "http://rsshub:1200";
    vi.mocked(prisma.source.findFirst).mockResolvedValue(null);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>blocked</html>"));
    await expect(lookupXueqiuUser("123")).rejects.toThrow();
    await expect(lookupXueqiuUser("昵称")).rejects.toThrow("昵称搜索暂不可用");
  });
  it("复用已存在的源并在事务中幂等关注", async () => {
    process.env.RSSHUB_BASE_URL = "http://rsshub:1200";
    const source = { id: "existing", name: "已有源" };
    vi.mocked(prisma.source.findFirst).mockResolvedValue(source as never);
    const tx = { source: { findFirst: vi.fn().mockResolvedValue(source), upsert: vi.fn() }, sourceFollow: { upsert: vi.fn().mockResolvedValue({}) } };
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: unknown) => (callback as (client: typeof tx) => Promise<unknown>)(tx) as never);
    await followXueqiuUser("123");
    expect(tx.source.upsert).not.toHaveBeenCalled();
    expect(tx.sourceFollow.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { sourceId: "existing" }, update: {} }));
  });
  it("依据本地关注记录标识候选", async () => {
    vi.mocked(prisma.source.findMany).mockResolvedValue([{ siteUrl: "https://www.xueqiu.com/u/123/", rssUrl: "https://old-rss.example/xueqiu/user/123", follow: { sourceId: "one" } }] as never);
    expect(await markXueqiuFollowed([{ uid: "123" }, { uid: "456" }])).toEqual([{ uid: "123", followed: true }, { uid: "456", followed: false }]);
  });
  it("搜索候选限制字段并去重，失败不伪装为空结果", async () => {
    process.env.XUEQIU_SEARCH_URL = "http://search:3100";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ candidates: [
      { uid: "123", name: "用户甲", siteUrl: "https://evil.example", avatarUrl: "https://evil.example/a.png", description: "用户简介" },
      { uid: "123", name: "重复" }, { uid: "bad", name: "无效" },
      { uid: "456", name: "用户乙", avatarUrl: "https://xavatar.imedao.com/community/abc.jpg!180x180.png" },
    ] })).mockResolvedValueOnce(new Response("blocked", { status: 502 }));
    expect(await searchXueqiuUsers("用户")).toEqual([{ uid: "123", name: "用户甲", siteUrl: "https://xueqiu.com/u/123", avatarUrl: null, description: "用户简介" }, { uid: "456", name: "用户乙", siteUrl: "https://xueqiu.com/u/456", avatarUrl: "https://xavatar.imedao.com/community/abc.jpg!180x180.png", description: "" }]);
    expect(fetchMock).toHaveBeenCalledWith("http://search:3100/search", expect.objectContaining({ method: "POST", redirect: "error" }));
    await expect(searchXueqiuUsers("用户")).rejects.toThrow("搜索暂不可用");
    delete process.env.XUEQIU_SEARCH_URL;
  });

});
