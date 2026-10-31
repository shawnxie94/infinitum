import { prisma } from "@/lib/db";
import { invalidateFeedCache } from "@/lib/feed/cache";
import { AdapterClient, AdapterError, readAdapterConfig, type AdapterAccount } from "@/lib/adapter/client";

export function legacyAccountId(rssUrl: string, providerId: string, trustedBase: string): string | null {
  let url: URL, base: URL;
  try { url = new URL(rssUrl); base = new URL(trustedBase); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password || url.search || url.hash || base.username || base.password || base.search || base.hash) return null;
  const prefix = base.pathname.replace(/\/$/, "");
  if (!url.pathname.startsWith(prefix + "/")) return null;
  const relative = url.pathname.slice(prefix.length);
  if (providerId === "xueqiu") return relative.match(/^\/xueqiu\/user\/([1-9]\d{0,19})$/)?.[1] ?? null;
  if (providerId === "eastmoney") return relative.match(/^\/eastmoney\/gerenzhongxin\/guba\/([1-9]\d{0,19})$/)?.[1] ?? null;
  if (providerId === "wechat") {
    const decoded = relative.match(/^\/feed\/MP_WXS_([A-Za-z0-9_-]{1,120})\.xml$/)?.[1];
    return decoded ? Buffer.from(decoded).toString("base64") : null;
  }
  return null;
}

/** The caller must explicitly select a matching, verified candidate. */
export async function migrateAdapterSource(sourceId: string, providerId: string, account: AdapterAccount) {
  const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
  const trustedBase = providerId === "wechat" ? process.env.WERSS_BASE_URL : process.env.RSSHUB_BASE_URL;
  if (!trustedBase) throw new AdapterError("CONFIG_ERROR", "缺少旧服务地址，无法对账。", false);
  if (source.transport !== "rss" || !source.rssUrl || legacyAccountId(source.rssUrl, providerId, trustedBase) !== account.accountId) throw new AdapterError("IDENTITY_CONFLICT", "旧源身份无法确认。", false);
  const config = await readAdapterConfig();
  const client = new AdapterClient(config);
  let subscription;
  try { ({ subscription } = await client.ensure(providerId, account)); }
  catch (error) {
    if (!(error instanceof AdapterError) || !["UNAVAILABLE", "INVALID_RESPONSE"].includes(error.code)) throw error;
    const lookup = await client.lookup(providerId, account.accountId);
    if (!lookup.subscription) throw new AdapterError("UNKNOWN_RESULT", "订阅结果未知，请先查询。", true);
    subscription = lookup.subscription;
  }
  if (subscription.providerId !== providerId || subscription.accountId !== account.accountId) throw new AdapterError("IDENTITY_CONFLICT", "订阅身份不一致。", false);
  const result = await prisma.$transaction(async (tx) => {
    if (await tx.backgroundTaskRun.count({ where: { kind: "ingestion", status: { in: ["queued", "running"] } } })) throw new AdapterError("INGESTION_ACTIVE", "采集正在运行，请稍后迁移。", true);
    const current = await tx.source.findUniqueOrThrow({ where: { id: sourceId } });
    if (current.transport !== "rss" || current.rssUrl !== source.rssUrl) throw new AdapterError("IDENTITY_CONFLICT", "旧源已变化，请重新对账。", false);
    const existing = await tx.adapterSourceBinding.findUnique({ where: { adapterInstanceId_providerId_accountId: { adapterInstanceId: config.instanceId, providerId, accountId: account.accountId } } });
    if (existing && (existing.sourceId !== sourceId || existing.subscriptionId !== subscription.id)) throw new AdapterError("IDENTITY_CONFLICT", "账号已绑定其他信息源。", false);
    const sourceBinding = await tx.adapterSourceBinding.findUnique({ where: { sourceId } });
    if (sourceBinding && (sourceBinding.adapterInstanceId !== config.instanceId || sourceBinding.providerId !== providerId || sourceBinding.accountId !== account.accountId || sourceBinding.subscriptionId !== subscription.id)) throw new AdapterError("IDENTITY_CONFLICT", "旧源已有不同账号绑定。", false);
    await tx.adapterSourceBinding.upsert({ where: { sourceId }, create: { sourceId, adapterInstanceId: config.instanceId, providerId, accountId: account.accountId, subscriptionId: subscription.id, previousRssUrl: source.rssUrl }, update: { previousRssUrl: source.rssUrl, subscriptionId: subscription.id } });
    return tx.source.update({ where: { id: sourceId }, data: { transport: "adapter", rssUrl: null, healthStatus: "unknown", healthMessage: null } });
  });
  invalidateFeedCache();
  return result;
}

export async function rollbackAdapterSource(sourceId: string) {
  const source = await prisma.$transaction(async (tx) => {
    if (await tx.backgroundTaskRun.count({ where: { kind: "ingestion", status: { in: ["queued", "running"] } } })) throw new AdapterError("INGESTION_ACTIVE", "采集正在运行，请稍后回滚。", true);
    const current = await tx.source.findUniqueOrThrow({ where: { id: sourceId }, include: { adapterBinding: true } });
    if (current.transport !== "adapter" || current.rssUrl || !current.adapterBinding?.previousRssUrl) throw new AdapterError("IDENTITY_CONFLICT", "没有可恢复的旧源地址。", false);
    const existing = await tx.source.findUnique({ where: { rssUrl: current.adapterBinding.previousRssUrl } });
    if (existing && existing.id !== sourceId) throw new AdapterError("IDENTITY_CONFLICT", "旧源地址已被其他源占用。", false);
    return tx.source.update({ where: { id: sourceId }, data: { transport: "rss", rssUrl: current.adapterBinding.previousRssUrl, healthStatus: "unknown", healthMessage: null } });
  });
  invalidateFeedCache();
  return source;
}
