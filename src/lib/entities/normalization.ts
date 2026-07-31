export type NormalizedEntity = {
  name: string;
  normalized: string;
};

const MAX_ENTITIES_PER_ITEM = 5;
const MAX_ENTITY_LENGTH = 40;
const GENERIC_ENTITY_NAMES = new Set([
  "公司",
  "机构",
  "产品",
  "平台",
  "服务",
  "功能",
  "能力",
  "产品能力",
  "方案",
  "项目",
  "工具",
  "模型",
  "版本",
  "政策",
  "漏洞",
  "论文",
  "行业",
  "市场",
  "多项更新",
  "roundup",
  "新闻",
  "资讯",
  "文章",
  "更新",
  "动态",
  "科技",
  "技术",
  "互联网",
  "news",
  "article",
  "update",
  "updates",
  "technology",
  "tech",
]);

function stripEdgePunctuation(value: string) {
  return value
    .replace(/^[\s#＃"“”‘’`.,，。:：;；!?！？、()[\]{}【】<>《》]+/u, "")
    .replace(/[\s#＃"“”‘’`.,，。:：;；!?！？、()[\]{}【】<>《》]+$/u, "");
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeEntityKey(value: string) {
  return normalizeWhitespace(value).toLocaleLowerCase();
}

export function normalizeEntityName(input: string): NormalizedEntity | null {
  const name = normalizeWhitespace(stripEdgePunctuation(input));
  if (!name || name.length > MAX_ENTITY_LENGTH) {
    return null;
  }

  const normalized = normalizeEntityKey(name);
  if (!normalized || GENERIC_ENTITY_NAMES.has(normalized)) {
    return null;
  }

  return { name, normalized };
}

function normalizeEntityValues(input: unknown, maxCount?: number): NormalizedEntity[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const values: NormalizedEntity[] = [];

  for (const rawValue of input) {
    if (typeof rawValue !== "string") {
      continue;
    }

    const value = normalizeEntityName(rawValue);
    if (!value || seen.has(value.normalized)) {
      continue;
    }

    seen.add(value.normalized);
    values.push(value);
    if (maxCount !== undefined && values.length >= maxCount) {
      break;
    }
  }

  return values;
}

export function normalizeItemEntities(input: unknown): NormalizedEntity[] {
  return normalizeEntityValues(input, MAX_ENTITIES_PER_ITEM);
}

export type EventEntitySource = {
  eventSubject?: string | null;
  eventObject?: string | null;
};

export function extractEventEntityNames(input: EventEntitySource | null | undefined) {
  return normalizeItemEntities([input?.eventSubject, input?.eventObject]);
}
