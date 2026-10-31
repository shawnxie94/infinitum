import Parser from "rss-parser";
import { prisma } from "@/lib/db";

export function parseEastmoneyUid(input: string) {
  const value = input.trim();
  if (/^[1-9]\d{0,19}$/.test(value)) return value;
  return value.match(/^https:\/\/i\.eastmoney\.com\/([1-9]\d{0,19})\/?(?:#guba)?$/i)?.[1] ?? null;
}
function rssUrl(uid: string) {
  if (!process.env.RSSHUB_BASE_URL) throw new Error("未配置 RSSHUB_BASE_URL。");
  const base = new URL(process.env.RSSHUB_BASE_URL);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("RSSHub 地址配置无效。");
  return `${base.toString().replace(/\/$/, "")}/eastmoney/gerenzhongxin/guba/${uid}`;
}
export async function lookupEastmoney(input: string) {
  const uid = parseEastmoneyUid(input);
  if (!uid) {
    if (/[:/]/.test(input) || /^\d/.test(input.trim())) throw new Error("请输入有效的东方财富 UID 或主页链接。");
    throw new Error("东方财富昵称搜索暂不可用，请使用 UID 或主页链接。");
  }
  const url = rssUrl(uid);
  const siteUrl = `https://i.eastmoney.com/${uid}`;
  const existing = await prisma.source.findFirst({ where: { OR: [{ rssUrl: url }, { siteUrl: { in: [siteUrl, `${siteUrl}/`, `${siteUrl}#guba`] } }] }, include: { follow: true } });
  if (existing) return { uid, name: existing.name, siteUrl, followed: Boolean(existing.follow) };
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: "error" }); } catch { throw new Error("东方财富 RSS 获取失败。"); }
  if (!response.ok) throw new Error("东方财富 RSS 获取失败，请检查 UID 和 RSSHub 状态。");
  const xml = await response.text();
  if (xml.length > 2_000_000) throw new Error("东方财富 RSS 响应过大。");
  let feed;
  try { feed = await new Parser().parseString(xml); } catch { throw new Error("东方财富 RSS 响应无效。"); }
  const name = feed.title?.match(/^(.+?) 的东财帖子$/)?.[1]?.trim();
  if (!name || name === uid || feed.link !== `${siteUrl}#guba`) throw new Error("无法确认东方财富用户。");
  return { uid, name, siteUrl, followed: false };
}
export async function followEastmoney(input: string) {
  const user = await lookupEastmoney(input);
  const url = rssUrl(user.uid);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.source.findFirst({ where: { OR: [{ rssUrl: url }, { siteUrl: { in: [user.siteUrl, `${user.siteUrl}/`, `${user.siteUrl}#guba`] } }] } });
    const source = existing ?? await tx.source.upsert({ where: { rssUrl: url }, update: {}, create: { rssUrl: url, siteUrl: user.siteUrl, name: user.name, channel: "东方财富", originKind: "account" } });
    await tx.sourceFollow.upsert({ where: { sourceId: source.id }, update: {}, create: { sourceId: source.id } });
    return source;
  });
}
