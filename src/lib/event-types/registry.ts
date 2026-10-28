import { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/db";
import { invalidateFeedCache } from "@/lib/feed/cache";
import { readBootstrapEventTypes } from "@/lib/event-types/bootstrap";
import { DEFAULT_EVENT_TYPE_DEFINITIONS } from "@/lib/event-types/defaults";
import { foldEventTypeToken } from "@/lib/event-types/key";
import { resolveEventTypeLabel } from "@/lib/event-types/resolve";
import {
  EventTypeValidationError,
  PROTECTED_EVENT_TYPE_KEY,
  type EventTypeDTO,
  type EventTypeRegistrySnapshot,
} from "@/lib/event-types/types";
import {
  buildRegistryFingerprint,
  parseAliasesJson,
  serializeAliasesJson,
  toRegistrySnapshot,
  validateEventTypeDefinitions,
} from "@/lib/event-types/validation";

type EventTypeRow = {
  id: string;
  key: string;
  label: string;
  description: string | null;
  aliasesJson: string;
  enabled: boolean;
  sortOrder: number;
};

type TxClient = Prisma.TransactionClient | PrismaClient;

let cache: { snapshot: EventTypeRegistrySnapshot; loadedAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function toDTO(row: EventTypeRow): EventTypeDTO {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    description: row.description,
    aliases: parseAliasesJson(row.aliasesJson),
    enabled: row.enabled,
    sortOrder: row.sortOrder,
  };
}

async function loadRows(): Promise<EventTypeRow[]> {
  return prisma.eventType.findMany({
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
  });
}

/**
 * other 兜底：任何初始化路径后 other 必须存在且启用。
 * 只补齐缺失/停用，不改写管理员编辑过的 label/description/aliases 语义字段。
 */
async function ensureProtectedOtherWithin(tx: TxClient) {
  const other = await tx.eventType.findUnique({ where: { key: PROTECTED_EVENT_TYPE_KEY } });
  if (!other) {
    const maxSort = await tx.eventType.aggregate({ _max: { sortOrder: true } });
    await tx.eventType.create({
      data: {
        key: PROTECTED_EVENT_TYPE_KEY,
        label: "其他",
        description: null,
        aliasesJson: serializeAliasesJson([]),
        enabled: true,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
    });
    return;
  }
  if (!other.enabled) {
    await tx.eventType.update({ where: { key: PROTECTED_EVENT_TYPE_KEY }, data: { enabled: true } });
  }
}

/**
 * 初始化路径：空表播种（引导配置或内置默认）+ other 兜底。
 * - 单事务内完成检查与写入；并发进程同时播种时后到者撞 unique 约束，
 *   视为对方已完成，直接放行（不抛未处理异常）。
 * - 显式引导配置非法时直接失败，不静默回退默认。
 * - 已有运行期数据时只兜底 other，不重播全套默认，不覆盖管理员编辑。
 */
export async function ensureEventTypesRegistrySeeded(): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const count = await tx.eventType.count();
      if (count === 0) {
        const bootstrap = readBootstrapEventTypes();
        // readBootstrapEventTypes：字段缺失/空数组 → null（内置默认）；
        // 显式提供但非法 → 抛错（不静默回退默认）。
        const definitions = bootstrap
          ?? validateEventTypeDefinitions(DEFAULT_EVENT_TYPE_DEFINITIONS);
        await tx.eventType.createMany({
          data: definitions.map((definition) => ({
            key: definition.key as string,
            label: definition.label,
            description: definition.description,
            aliasesJson: serializeAliasesJson(definition.aliases ?? []),
            enabled: definition.enabled ?? true,
            sortOrder: definition.sortOrder ?? 0,
          })),
        });
      }
      await ensureProtectedOtherWithin(tx);
    });
    invalidateEventTypeRegistryCache();
  } catch (error) {
    // 并发初始化：对方进程已完成播种，唯一约束冲突视为成功。
    if (isUniqueViolation(error)) {
      invalidateEventTypeRegistryCache();
      return;
    }
    throw error;
  }
}

export function invalidateEventTypeRegistryCache() {
  cache = null;
}

/** 运行时快照（确定性 + fingerprint）。缓存失效由本模块写操作显式触发。 */
export async function getEventTypeRegistrySnapshot(): Promise<EventTypeRegistrySnapshot> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.snapshot;
  }

  await ensureEventTypesRegistrySeeded();
  const snapshot = toRegistrySnapshot(await loadRows());
  cache = { snapshot, loadedAt: Date.now() };
  return snapshot;
}

export async function listEventTypesForAdmin(): Promise<EventTypeDTO[]> {
  await ensureEventTypesRegistrySeeded();
  return (await loadRows()).map(toDTO);
}

/**
 * 原子冲突校验：在调用方的写事务内读取全表，候选 key/label/别名与所有
 * key+别名（含 other）不冲突；任何冲突整体回滚。更新时排除自身行。
 */
async function assertNoTokenConflictsWithin(
  tx: TxClient,
  key: string,
  label: string,
  aliases: string[],
  selfId?: string,
) {
  const rows = await tx.eventType.findMany();
  const owners = new Map<string, Set<string>>();
  for (const row of rows) {
    if (selfId && row.id === selfId) {
      continue;
    }
    for (const token of [row.key, ...parseAliasesJson(row.aliasesJson)]) {
      const folded = foldEventTypeToken(token);
      if (!folded) continue;
      const set = owners.get(folded) ?? new Set<string>();
      set.add(row.key);
      owners.set(folded, set);
    }
  }

  const keyToken = foldEventTypeToken(key);
  const candidates = [key, label, ...aliases].map(foldEventTypeToken).filter(Boolean);
  for (const candidate of candidates) {
    const conflict = [...(owners.get(candidate) ?? [])][0];
    if (conflict) {
      throw new EventTypeValidationError(
        `「${candidate}」已被事件类型 ${conflict} 占用。`,
        candidate === keyToken ? "duplicate_key" : "alias_conflict",
      );
    }
  }
}

export async function createEventType(input: {
  key?: string | null;
  label: string;
  description?: string | null;
  aliases?: string[];
  enabled?: boolean;
  sortOrder?: number;
}): Promise<EventTypeDTO> {
  await ensureEventTypesRegistrySeeded();
  const [validated] = validateEventTypeDefinitions([input]);
  try {
    const row = await prisma.$transaction(async (tx) => {
      await assertNoTokenConflictsWithin(tx, validated.key, validated.label, validated.aliases);
      return tx.eventType.create({
        data: {
          key: validated.key as string,
          label: validated.label,
          description: validated.description,
          aliasesJson: serializeAliasesJson(validated.aliases),
          enabled: validated.enabled ?? true,
          sortOrder: validated.sortOrder ?? 0,
        },
      });
    });
    afterWrite();
    return toDTO(row);
  } catch (error) {
    // 校验在事务内完成；并发窗口下唯一约束兜底并映射为明确错误。
    if (isUniqueViolation(error)) {
      throw new EventTypeValidationError(
        `事件类型 key「${validated.key}」已存在。`,
        "duplicate_key",
      );
    }
    throw error;
  }
}

export async function updateEventType(
  id: string,
  input: {
    key?: string | null;
    label?: string;
    description?: string | null;
    aliases?: string[];
    enabled?: boolean;
    sortOrder?: number;
  },
): Promise<EventTypeDTO> {
  await ensureEventTypesRegistrySeeded();
  try {
    const row = await prisma.$transaction(async (tx) => {
      const existing = await tx.eventType.findUnique({ where: { id } });
      if (!existing) {
        throw new EventTypeValidationError("事件类型不存在。", "not_found");
      }
      if (input.key !== undefined && input.key !== null && input.key !== existing.key) {
        throw new EventTypeValidationError("事件类型 key 创建后不可修改。", "immutable_key");
      }

      if (existing.key === PROTECTED_EVENT_TYPE_KEY) {
        // other 为内置兜底：拒绝对其一切直接更新（label/description/aliases/sortOrder/enabled）。
        throw new EventTypeValidationError("other 事件类型为内置兜底，不可直接修改。", "protected_key");
      }

      const label = input.label !== undefined ? input.label : existing.label;
      const aliases = input.aliases !== undefined ? input.aliases : parseAliasesJson(existing.aliasesJson);
      const [validated] = validateEventTypeDefinitions([{
        key: existing.key,
        label,
        description: input.description !== undefined ? input.description : existing.description,
        aliases,
        enabled: input.enabled ?? existing.enabled,
        sortOrder: input.sortOrder ?? existing.sortOrder,
      }]);

      await assertNoTokenConflictsWithin(tx, existing.key, validated.label, validated.aliases, existing.id);

      return tx.eventType.update({
        where: { id },
        data: {
          label: validated.label,
          description: validated.description,
          aliasesJson: serializeAliasesJson(validated.aliases),
          enabled: input.enabled ?? existing.enabled,
          sortOrder: input.sortOrder ?? existing.sortOrder,
        },
      });
    });
    afterWrite();
    return toDTO(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new EventTypeValidationError("事件类型定义冲突。", "duplicate_key");
    }
    throw error;
  }
}

/**
 * 批量排序：orderedKeys 必须恰好等于现有 key 全集（无未知、无重复、无缺失），
 * 与 source-group 顺序契约一致；不满足整体拒绝。
 */
export async function reorderEventTypes(orderedKeys: string[]): Promise<EventTypeDTO[]> {
  const rows = await prisma.eventType.findMany();
  const existingKeys = rows.map((row) => row.key).sort();
  const submitted = [...orderedKeys].sort();

  const duplicates = orderedKeys.length !== new Set(orderedKeys).size;
  const sameSet = existingKeys.length === submitted.length
    && existingKeys.every((key, index) => key === submitted[index]);
  if (duplicates || !sameSet) {
    throw new EventTypeValidationError(
      "排序列表必须恰好包含全部现有事件类型 key，且不得重复或缺项。",
      "not_found",
    );
  }

  await prisma.$transaction(orderedKeys.map((key, index) =>
    prisma.eventType.update({ where: { key }, data: { sortOrder: index } }),
  ));
  afterWrite();
  return listEventTypesForAdmin();
}

/** 引用中的类型只能停用不能删除；other 永远不可删除。 */
export async function deleteEventType(id: string): Promise<void> {
  const existing = await prisma.eventType.findUnique({ where: { id } });
  if (!existing) {
    throw new EventTypeValidationError("事件类型不存在。", "not_found");
  }
  if (existing.key === PROTECTED_EVENT_TYPE_KEY) {
    throw new EventTypeValidationError("other 事件类型不可删除。", "protected_key");
  }

  const [itemCount, clusterCount] = await prisma.$transaction([
    prisma.item.count({ where: { eventType: existing.key } }),
    prisma.contentCluster.count({ where: { eventType: existing.key } }),
  ]);
  if (itemCount > 0 || clusterCount > 0) {
    throw new EventTypeValidationError(
      `事件类型 ${existing.key} 已被 ${itemCount + clusterCount} 条历史内容引用，请停用而非删除。`,
      "type_in_use",
    );
  }

  await prisma.eventType.delete({ where: { id } });
  afterWrite();
}

function afterWrite() {
  invalidateEventTypeRegistryCache();
  // 注册表 label 影响公共展示，写操作后失效 feed/速览缓存。
  invalidateFeedCache();
}

export { buildRegistryFingerprint, resolveEventTypeLabel };
