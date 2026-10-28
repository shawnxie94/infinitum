import { createHash } from "node:crypto";

import { assertValidEventTypeKey, foldEventTypeToken, normalizeEventTypeKeyInput } from "@/lib/event-types/key";
import { EventTypeValidationError } from "@/lib/event-types/types";
import {
  PROTECTED_EVENT_TYPE_KEY,
  type EventTypeDefinitionInput,
  type EventTypeRegistrySnapshot,
} from "@/lib/event-types/types";

export function parseAliasesJson(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

export function serializeAliasesJson(aliases: string[]) {
  return JSON.stringify(aliases);
}

/**
 * 原子校验一组定义：key 合法、label 非空、别名规范；key 与别名（含互相之间）
 * 全局唯一。任何冲突整体拒绝，不做部分写入。
 */
export function validateEventTypeDefinitions(definitions: EventTypeDefinitionInput[]) {
  const seenDefinitionKeys = new Set<string>();
  const owner = new Map<string, string>(); // folded token → key

  const claim = (token: string, key: string) => {
    const folded = foldEventTypeToken(token);
    if (!folded) {
      return;
    }
    const existing = owner.get(folded);
    if (existing && existing !== key) {
      throw new EventTypeValidationError(
        `事件类型定义冲突：「${token}」同时属于 ${existing} 和 ${key}。`,
        folded === key ? "duplicate_key" : "alias_conflict",
      );
    }
    owner.set(folded, key);
  };

  const validated = definitions.map((definition) => {
    const key = definition.key
      ? normalizeEventTypeKeyInput(definition.key)
      : normalizeEventTypeKeyInput(definition.label);
    if (!key) {
      throw new EventTypeValidationError(
        `事件类型「${definition.label}」无法派生合法 key，请显式提供 key。`,
        "invalid_key",
      );
    }
    assertValidEventTypeKey(key);
    if (seenDefinitionKeys.has(key)) {
      throw new EventTypeValidationError(
        `事件类型定义重复：key「${key}」出现多次。`,
        "duplicate_key",
      );
    }
    seenDefinitionKeys.add(key);

    const label = definition.label.trim();
    if (!label) {
      throw new EventTypeValidationError("事件类型 label 不能为空。", "invalid_label");
    }

    const aliases = [...new Set((definition.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))];
    const enabled = definition.enabled ?? true;
    if (key === PROTECTED_EVENT_TYPE_KEY && !enabled) {
      throw new EventTypeValidationError(
        "受保护的 other 事件类型不可停用。",
        "protected_key",
      );
    }
    return {
      key,
      label,
      description: definition.description?.trim() || null,
      aliases,
      enabled,
      sortOrder: definition.sortOrder ?? 0,
    };
  });

  for (const definition of validated) {
    claim(definition.key, definition.key);
    for (const alias of definition.aliases) {
      if (foldEventTypeToken(alias) === PROTECTED_EVENT_TYPE_KEY && definition.key !== PROTECTED_EVENT_TYPE_KEY) {
        throw new EventTypeValidationError(
          `事件类型「${definition.key}」的别名不能占用受保护的 other。`,
          "protected_key",
        );
      }
      claim(alias, definition.key);
    }
  }

  return validated;
}

/** 快照确定性序列化：fingerprint 只依赖语义字段，与 id/时间戳无关。 */
export function buildRegistryFingerprint(
  types: Array<{
    key: string;
    label: string;
    description: string | null;
    aliases: string[];
    enabled: boolean;
    sortOrder: number;
  }>,
) {
  return createHash("sha256")
    .update(JSON.stringify(
      types
        .map((type) => ({
          key: type.key,
          label: type.label,
          description: type.description ?? "",
          aliases: [...type.aliases].map(foldEventTypeToken).sort(),
          enabled: type.enabled,
          sortOrder: type.sortOrder,
        }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    ))
    .digest("hex");
}

export function toRegistrySnapshot(
  types: Array<{
    id: string;
    key: string;
    label: string;
    description: string | null;
    aliasesJson: string;
    enabled: boolean;
    sortOrder: number;
  }>,
): EventTypeRegistrySnapshot {
  const dtoTypes = types.map((type) => ({
    id: type.id,
    key: type.key,
    label: type.label,
    description: type.description,
    aliases: parseAliasesJson(type.aliasesJson),
    enabled: type.enabled,
    sortOrder: type.sortOrder,
  }));

  return {
    types: dtoTypes,
    fingerprint: buildRegistryFingerprint(dtoTypes),
  };
}
