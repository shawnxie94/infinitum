import { prisma } from "@/lib/db";
import { normalizeEntityName } from "@/lib/entities/normalization";

export type MentionResolver = (mention: string | null | undefined) => string | null;

// Worker 常驻进程内的 mention → canonical 名称缓存。实体/别名只在 admin 合并时
// 缓慢增长，按 mention 缓存足够；超限整体清空（重建成本是一次批量查询）。
// 已解析为 null 的 mention 同样入缓存——admin 新增别名后需进程重启或缓存
// 淘汰才生效，属于可接受的陈旧窗口。
const RESOLVER_CACHE_MAX = 20_000;
const canonicalCache = new Map<string, string | null>();

function mentionKey(mention: string | null | undefined): string | null {
  return normalizeEntityName(mention ?? "")?.normalized ?? null;
}

/**
 * 批量解析 mention 的 canonical 实体名：先查实体别名表，再查实体表本身。
 * 返回的 resolver 对不可解析的 mention 返回 null，调用方应回退原始字符串。
 */
export async function loadMentionResolver(
  mentions: Array<string | null | undefined>,
): Promise<MentionResolver> {  const pending = new Set<string>();
  for (const mention of mentions) {
    const key = mentionKey(mention);
    if (!key || canonicalCache.has(key)) continue;
    pending.add(key);
  }

  if (pending.size > 0) {
    const keys = [...pending];
    const [aliasRows, entityRows] = await Promise.all([
      prisma.entityAlias.findMany({
        where: { aliasNormalized: { in: keys } },
        select: { aliasNormalized: true, entity: { select: { name: true } } },
      }),
      prisma.entity.findMany({
        where: { normalized: { in: keys } },
        select: { normalized: true, name: true },
      }),
    ]);
    for (const row of entityRows) {
      canonicalCache.set(row.normalized, row.name);
    }
    // 别名指向的 canonical 名称覆盖同名实体行（identity 情形结果不变）
    for (const row of aliasRows) {
      canonicalCache.set(row.aliasNormalized, row.entity.name);
    }
    if (canonicalCache.size > RESOLVER_CACHE_MAX) {
      canonicalCache.clear();
    }
  }

  return (mention) => {
    const key = mentionKey(mention);
    if (!key) return null;
    return canonicalCache.has(key) ? canonicalCache.get(key) ?? null : null;
  };
}

/** 清空进程内解析缓存；admin 新增/合并别名后调用可立即生效，测试用于隔离。 */
export function resetMentionResolverCache() {
  canonicalCache.clear();
}
