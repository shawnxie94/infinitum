import { prisma } from "@/lib/db";
import { invalidateFeedCache } from "@/lib/feed/cache";
import { AdapterClient, AdapterError, readAdapterConfig, type AdapterAccount } from "@/lib/adapter/client";

/** Ensure upstream first; an unknown result is reconciled before any retry. */
export async function followAdapterAccount(providerId: string, account: AdapterAccount) {
  const legacySources = await prisma.source.findMany({ where: { transport: "rss", rssUrl: { not: null } }, select: { rssUrl: true } });
  const expectedPath = providerId === "xueqiu" && /^[1-9]\d{0,19}$/.test(account.accountId) ? `/xueqiu/user/${account.accountId}`
    : providerId === "eastmoney" && /^[1-9]\d{0,19}$/.test(account.accountId) ? `/eastmoney/gerenzhongxin/guba/${account.accountId}`
    : providerId === "wechat" && /^[A-Za-z0-9+/]{4,180}={0,2}$/.test(account.accountId) ? `/feed/MP_WXS_${Buffer.from(account.accountId, "base64").toString("utf8")}.xml` : null;
  const conflicts = (sources: { rssUrl: string | null }[]) => Boolean(expectedPath && sources.some((source) => {
    try { return Boolean(source.rssUrl && new URL(source.rssUrl).pathname.endsWith(expectedPath)); } catch { return false; }
  }));
  if (conflicts(legacySources)) throw new AdapterError("MIGRATION_REQUIRED", "此账号已有原信息源，请先对账迁移。", false);
  const config = await readAdapterConfig();
  const client = new AdapterClient(config);
  let subscription;
  try {
    ({ subscription } = await client.ensure(providerId, account));
  } catch (error) {
    if (!(error instanceof AdapterError) || !["UNAVAILABLE", "INVALID_RESPONSE"].includes(error.code)) throw error;
    const lookup = await client.lookup(providerId, account.accountId);
    if (!lookup.subscription) throw new AdapterError("UNKNOWN_RESULT", "订阅结果未知，请稍后查询。", true);
    subscription = lookup.subscription;
  }
  if (subscription.providerId !== providerId || subscription.accountId !== account.accountId) {
    throw new AdapterError("INVALID_RESPONSE", "订阅身份不一致。", false);
  }
  const provider = (await client.providers()).providers.find((entry) => entry.id === providerId);
  if (!provider) throw new AdapterError("INVALID_RESPONSE", "账号渠道不存在。", false);
  const bind = async () => prisma.$transaction(async (tx) => {
    if (conflicts(await tx.source.findMany({ where: { transport: "rss", rssUrl: { not: null } }, select: { rssUrl: true } }))) throw new AdapterError("MIGRATION_REQUIRED", "此账号已有原信息源，请先对账迁移。", false);
    const existing = await tx.adapterSourceBinding.findUnique({
      where: { adapterInstanceId_providerId_accountId: { adapterInstanceId: config.instanceId, providerId, accountId: account.accountId } },
      include: { source: true },
    });
    if (existing) {
      if (existing.subscriptionId !== subscription.id) throw new AdapterError("IDENTITY_CONFLICT", "订阅身份冲突。", false);
      if (existing.source.transport !== "adapter") throw new AdapterError("MIGRATION_REQUIRED", "此账号仍使用原信息源，请先迁移。", false);
      await tx.sourceFollow.upsert({ where: { sourceId: existing.sourceId }, create: { sourceId: existing.sourceId }, update: {} });
      return existing.source;
    }
    const created = await tx.source.create({ data: {
      name: subscription.account.name, siteUrl: subscription.account.siteUrl ?? "", rssUrl: null,
      transport: "adapter", originKind: "account", channel: provider.name,
      adapterBinding: { create: { adapterInstanceId: config.instanceId, providerId, accountId: account.accountId, subscriptionId: subscription.id } },
      follow: { create: {} },
    } });
    return created;
  });
  let source;
  try { source = await bind(); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") throw error;
    const existing = await prisma.adapterSourceBinding.findUnique({
      where: { adapterInstanceId_providerId_accountId: { adapterInstanceId: config.instanceId, providerId, accountId: account.accountId } },
      include: { source: true },
    });
    if (!existing || existing.subscriptionId !== subscription.id || existing.source.transport !== "adapter") throw new AdapterError("IDENTITY_CONFLICT", "订阅身份冲突。", false);
    await prisma.sourceFollow.upsert({ where: { sourceId: existing.sourceId }, create: { sourceId: existing.sourceId }, update: {} });
    source = existing.source;
  }
  invalidateFeedCache();
  return source;
}
