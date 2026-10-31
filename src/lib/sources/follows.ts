import { prisma } from "@/lib/db";

export type SourceFollowSnapshot = {
  sourceIds: string[];
  snapshotAt: string;
};

export const SOURCE_CHANNEL_OPTIONS = [
  "雪球",
  "东方财富",
  "公众号",
  "财联社",
] as const;

export const SOURCE_CHANNEL_OTHER = "其他";

export function normalizeSourceChannel(channel: string | null | undefined) {
  const trimmed = channel?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : SOURCE_CHANNEL_OTHER;
}

/** 全系统唯一的关注快照：生成入口调用一次，同一次生成内固定不变。 */
export async function getSourceFollowSnapshot(): Promise<SourceFollowSnapshot> {
  const rows = await prisma.sourceFollow.findMany({
    select: { sourceId: true },
    orderBy: { sourceId: "asc" },
  });

  return {
    sourceIds: rows.map((row) => row.sourceId),
    snapshotAt: new Date().toISOString(),
  };
}

export async function listFollowedSourceIds() {
  return (await getSourceFollowSnapshot()).sourceIds;
}

export async function followSource(sourceId: string) {
  const source = await prisma.source.findUnique({ where: { id: sourceId } });
  if (!source) {
    throw new Error("信息源不存在。");
  }

  await prisma.sourceFollow.upsert({
    where: { sourceId },
    update: {},
    create: { sourceId },
  });

  return prisma.sourceFollow.findUniqueOrThrow({ where: { sourceId } });
}

export async function unfollowSource(sourceId: string) {
  await prisma.sourceFollow.deleteMany({ where: { sourceId } });
}

/** 目录视图：全部已配置源（含停用）+ 关注状态与渠道。 */
export async function listSourceCatalog(params: {
  channel?: string | null;
  search?: string | null;
  originKind?: "preset" | null;
} = {}) {
  const sources = await prisma.source.findMany({
    where: params.originKind ? { originKind: params.originKind } : undefined,
    orderBy: [{ enabled: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      siteUrl: true,
      enabled: true,
      channel: true,
      originKind: true,
      transport: true,
      healthStatus: true,
      healthMessage: true,
      group: { select: { name: true } },
      follow: { select: { followedAt: true } },
    },
  });

  const search = params.search?.trim().toLowerCase() ?? "";
  const channelFilter = params.channel?.trim() ?? "";

  return sources
    .map((source) => ({
      id: source.id,
      name: source.name,
      siteUrl: source.siteUrl,
      enabled: source.enabled,
      channel: normalizeSourceChannel(source.channel),
      rawChannel: source.channel,
      originKind: source.originKind,
      transport: source.transport,
      groupName: source.group?.name ?? null,
      healthStatus: source.healthStatus,
      healthMessage: source.healthMessage,
      followed: Boolean(source.follow),
      followedAt: source.follow?.followedAt.toISOString() ?? null,
    }))
    .filter((source) => (channelFilter ? source.channel === channelFilter : true))
    .filter((source) => (search ? source.name.toLowerCase().includes(search) : true));
}

export function listSourceCatalogChannels(catalog: Awaited<ReturnType<typeof listSourceCatalog>>) {
  return [...new Set(catalog.map((source) => source.channel))].sort((left, right) => {
    if (left === SOURCE_CHANNEL_OTHER) return 1;
    if (right === SOURCE_CHANNEL_OTHER) return -1;
    return left.localeCompare(right, "zh-Hans-CN");
  });
}
