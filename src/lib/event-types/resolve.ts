import { DEFAULT_EVENT_TYPE_DEFINITIONS } from "@/lib/event-types/defaults";
import { foldEventTypeToken } from "@/lib/event-types/key";
import { toRegistrySnapshot } from "@/lib/event-types/validation";
import type { EnabledEventTypeResolver, EventTypeRegistrySnapshot } from "@/lib/event-types/types";
import { PROTECTED_EVENT_TYPE_KEY } from "@/lib/event-types/types";

/**
 * 无注册表快照时的降级视图：与旧版十条硬编码默认对齐，保持既有行为。
 * 运行时主路径始终传入 DB 快照；此降级只覆盖测试/异常路径。
 */
const FALLBACK_SNAPSHOT = toRegistrySnapshot(
  DEFAULT_EVENT_TYPE_DEFINITIONS.map((definition, index) => ({
    id: `fallback-${index}`,
    key: definition.key as string,
    label: definition.label,
    description: definition.description ?? null,
    aliasesJson: JSON.stringify(definition.aliases ?? []),
    enabled: true,
    sortOrder: definition.sortOrder ?? index,
  })),
);

function getDefaultResolver(): EnabledEventTypeResolver {
  return buildEnabledEventTypeResolver(FALLBACK_SNAPSHOT);
}

/**
 * 从快照构建「新输出」解析器：只收启用类型。
 * disabled/unknown 都不进入映射面，由调用方落 other。
 */
export function buildEnabledEventTypeResolver(snapshot: EventTypeRegistrySnapshot): EnabledEventTypeResolver {
  const byKey = new Map<string, { key: string; label: string; description: string | null; aliases: string[] }>();
  const byAlias = new Map<string, string>();

  for (const type of snapshot.types) {
    if (!type.enabled) {
      continue;
    }
    const entry = { key: type.key, label: type.label, description: type.description, aliases: type.aliases };
    byKey.set(foldEventTypeToken(type.key), entry);
    byAlias.set(foldEventTypeToken(type.key), type.key);
    for (const alias of type.aliases) {
      const folded = foldEventTypeToken(alias);
      // 别名冲突在写入时已被原子校验拒绝；这里保守取先到者。
      if (!byAlias.has(folded)) {
        byAlias.set(folded, type.key);
      }
    }
  }

  return { fingerprint: snapshot.fingerprint, byKey, byAlias };
}

export type EventTypeResolution = {
  /** 命中启用类型的规范 key；未命中时为 other。 */
  key: string;
  /** 未命中启用注册表时的原始输出（已 trim）；命中时为 null。 */
  rawValue: string | null;
  matched: boolean;
};

/**
 * 新输出事件类型解析：
 * - 命中启用类型 key 或别名 → 规范 key；
 * - unknown / 非启用（disabled）→ other，保留原始值供诊断；
 * - 空/无证据 → null（不编造 other，保留「确实无事件类型」语义）。
 */
export function resolveEventTypeOutput(
  value: string | null | undefined,
  resolverInput: EnabledEventTypeResolver | null,
): EventTypeResolution | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }

  const resolver = resolverInput ?? getDefaultResolver();
  const folded = foldEventTypeToken(trimmed);
  const byAlias = resolver.byAlias.get(folded) ?? resolver.byKey.get(folded)?.key;
  if (byAlias) {
    return { key: byAlias, rawValue: null, matched: true };
  }

  return { key: PROTECTED_EVENT_TYPE_KEY, rawValue: trimmed, matched: false };
}

/** 展示标签：优先注册表 label（含禁用类型），回退存储 key。 */
export function resolveEventTypeLabel(
  key: string | null | undefined,
  types: Array<{ key: string; label: string }>,
): string | null {
  if (!key) {
    return null;
  }
  return types.find((type) => type.key === key)?.label ?? key;
}
