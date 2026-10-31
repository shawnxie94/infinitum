import Parser from "rss-parser";
import { prisma } from "@/lib/db";

export function parseXueqiuUid(input: string): string | null {
  const value = input.trim();
  if (/^[1-9]\d{0,19}$/.test(value)) return value;
  const match = value.match(/^https:\/\/(?:www\.)?xueqiu\.com\/u\/([1-9]\d{0,19})\/?$/i);
  return match?.[1] ?? null;
}

function rssUrl(uid: string) {
  const base = process.env.RSSHUB_BASE_URL;
  if (!base) throw new Error("未配置 RSSHUB_BASE_URL，无法添加雪球用户。");
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("RSSHUB_BASE_URL 配置无效。");
  }
  return `${url.toString().replace(/\/$/, "")}/xueqiu/user/${uid}`;
}

export async function lookupXueqiuUser(input: string) {
  const uid = parseXueqiuUid(input);
  if (!uid) {
    if (/[:/]/.test(input) || /^\d/.test(input)) throw new Error("请输入有效的雪球 UID 或用户主页链接。");
    throw new Error("雪球昵称搜索暂不可用，请使用 UID 或用户主页链接。");
  }
  const url = rssUrl(uid);
  const siteUrl = `https://xueqiu.com/u/${uid}`;
  const siteUrls = [siteUrl, `${siteUrl}/`, `https://www.xueqiu.com/u/${uid}`, `https://www.xueqiu.com/u/${uid}/`];
  const existing = await prisma.source.findFirst({ where: { OR: [{ rssUrl: url }, { siteUrl: { in: siteUrls } }] } });
  if (existing) return { uid, name: existing.name, siteUrl };
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: "error" });
  if (!response.ok) throw new Error("雪球动态获取失败，请检查 UID 和 RSSHub 状态。");
  const xml = await response.text();
  if (xml.length > 2_000_000) throw new Error("雪球动态响应过大。");
  let feed;
  try { feed = await new Parser().parseString(xml); } catch { throw new Error("雪球动态响应无效。"); }
  const name = feed.title?.match(/^(.+?) 的雪球(?:全部|原发布|长文|问答|热门|交易)动态$/)?.[1]?.trim();
  if (!name || name === uid || feed.link !== siteUrl) throw new Error("无法确认雪球用户，请检查 UID。");
  return { uid, name, siteUrl };
}

export async function searchXueqiuUsers(input: string) {
  const query = input.trim();
  if (!query || query.length > 50 || /[\x00-\x1f]/.test(query)) throw new Error("请输入有效的雪球昵称。");
  const base = process.env.XUEQIU_SEARCH_URL;
  if (!base) throw new Error("未配置雪球搜索服务，请使用 UID 或用户主页链接。");
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("雪球搜索服务配置无效。");
  let response: Response;
  try {
    response = await fetch(`${url.toString().replace(/\/$/, "")}/search`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30000), redirect: "error",
    });
  } catch { throw new Error("雪球搜索服务不可用，请稍后重试或使用 UID。 "); }
  if (response.status === 429) throw new Error("搜索过于频繁，请稍后重试。");
  if (!response.ok) throw new Error("雪球搜索暂不可用，请稍后重试或使用 UID。");
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("雪球搜索响应无效。"); }
  if (!payload || typeof payload !== "object" || !("candidates" in payload) || !Array.isArray(payload.candidates)) throw new Error("雪球搜索响应无效。");
  const seen = new Set<string>();
  const candidates = payload.candidates.slice(0, 10).flatMap((user: unknown) => {
    if (!user || typeof user !== "object" || !("uid" in user) || !("name" in user) || typeof user.uid !== "string" || !/^[1-9]\d{0,19}$/.test(user.uid) || typeof user.name !== "string" || !user.name.trim() || seen.has(user.uid)) return [];
    seen.add(user.uid);
    const description = "description" in user && typeof user.description === "string" ? user.description.trim().slice(0, 300) : "";
    const avatarUrl = "avatarUrl" in user && typeof user.avatarUrl === "string" && /^https:\/\/xavatar\.imedao\.com\/[a-zA-Z0-9_./!\-]+$/.test(user.avatarUrl) && !user.avatarUrl.includes("..") ? user.avatarUrl : null;
    return [{ uid: user.uid, name: user.name.trim().slice(0, 100), siteUrl: `https://xueqiu.com/u/${user.uid}`, description, avatarUrl }];
  });
  if (payload.candidates.length && !candidates.length) throw new Error("雪球搜索响应无效。");
  return candidates;
}

export async function followXueqiuUser(input: string) {
  const user = await lookupXueqiuUser(input);
  const url = rssUrl(user.uid);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.source.findFirst({ where: { OR: [{ rssUrl: url }, { siteUrl: { in: [user.siteUrl, `${user.siteUrl}/`, `https://www.xueqiu.com/u/${user.uid}`, `https://www.xueqiu.com/u/${user.uid}/`] } }] } });
    const source = existing ?? await tx.source.upsert({ where: { rssUrl: url }, update: {}, create: {
      name: user.name, channel: "雪球", originKind: "account", rssUrl: url, siteUrl: user.siteUrl,
    } });
    await tx.sourceFollow.upsert({ where: { sourceId: source.id }, update: {}, create: { sourceId: source.id } });
    return source;
  });
}

export async function markXueqiuFollowed<T extends { uid: string }>(users: T[]) {
  if (!users.length) return [];
  const sites = users.flatMap(({ uid }) => [`https://xueqiu.com/u/${uid}`, `https://xueqiu.com/u/${uid}/`, `https://www.xueqiu.com/u/${uid}`, `https://www.xueqiu.com/u/${uid}/`]);
  const rssUrls = process.env.RSSHUB_BASE_URL ? users.map(({ uid }) => rssUrl(uid)) : [];
  const sources = await prisma.source.findMany({ where: { OR: [{ siteUrl: { in: sites } }, { rssUrl: { in: rssUrls } }] }, select: { siteUrl: true, rssUrl: true, follow: { select: { sourceId: true } } } });
  return users.map((user) => ({ ...user, followed: sources.some((source) => Boolean(source.follow) && (parseXueqiuUid(source.siteUrl) === user.uid || (rssUrls.length > 0 && source.rssUrl === rssUrl(user.uid)))) }));
}
