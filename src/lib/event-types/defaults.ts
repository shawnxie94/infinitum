import { PROTECTED_EVENT_TYPE_KEY, type EventTypeDefinitionInput } from "@/lib/event-types/types";

// 旧版十条硬编码默认；缺省（无 event_types 行、引导配置未提供 eventTypes）时
// 幂等播种，保持既有 AI 行为不变。other 固定启用且受系统保护。
export const DEFAULT_EVENT_TYPE_DEFINITIONS: EventTypeDefinitionInput[] = [
  { key: "release", label: "版本发布" },
  { key: "launch", label: "产品上线" },
  { key: "update", label: "进展更新" },
  { key: "funding", label: "融资" },
  { key: "acquisition", label: "收购" },
  { key: "partnership", label: "合作" },
  { key: "policy", label: "政策" },
  { key: "research", label: "研究" },
  { key: "security", label: "安全" },
  { key: PROTECTED_EVENT_TYPE_KEY, label: "其他" },
].map((definition, index) => ({ ...definition, sortOrder: index }));
