// 领域事件类型注册表共享类型：每实例一份，运行时 DB 为唯一真源。

export const PROTECTED_EVENT_TYPE_KEY = "other";

export type EventTypeDTO = {
  id: string;
  key: string;
  label: string;
  description: string | null;
  aliases: string[];
  enabled: boolean;
  sortOrder: number;
};

/** 注册表确定性快照：fingerprint 参与模型请求/回执/checkpoint 身份。 */
export type EventTypeRegistrySnapshot = {
  types: EventTypeDTO[];
  fingerprint: string;
};

/** 管理端/引导配置共用的定义输入（key 可选时由 label 派生）。 */
export type EventTypeDefinitionInput = {
  key?: string | null;
  label: string;
  description?: string | null;
  aliases?: string[];
  enabled?: boolean;
  sortOrder?: number;
};

export type EventTypeResolverEntry = {
  key: string;
  label: string;
  description: string | null;
  aliases: string[];
};

/**
 * 新输出解析用的注册表视图：只含启用类型。
 * disabled 类型可读但不再约束/承接新输出。
 */
export type EnabledEventTypeResolver = {
  fingerprint: string;
  /** key（小写规范形）→ 类型 */
  byKey: Map<string, EventTypeResolverEntry>;
  /** 别名/标签小写规范形 → key */
  byAlias: Map<string, string>;
};

export class EventTypeValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_key"
      | "invalid_label"
      | "invalid_aliases"
      | "duplicate_key"
      | "alias_conflict"
      | "protected_key"
      | "not_found"
      | "immutable_key"
      | "type_in_use",
  ) {
    super(message);
    this.name = "EventTypeValidationError";
  }
}
