import {
  DEFAULT_CLUSTER_MATCH_PROMPT,
  DEFAULT_CLUSTER_MATCH_USER_PROMPT_TEMPLATE,
  DEFAULT_CLUSTER_MERGE_PROMPT,
  DEFAULT_CLUSTER_MERGE_USER_PROMPT_TEMPLATE,
  DEFAULT_CLUSTER_SUMMARY_PROMPT,
  DEFAULT_CLUSTER_SUMMARY_USER_PROMPT_TEMPLATE,
  DEFAULT_DAILY_REPORT_PROMPT,
  DEFAULT_DAILY_REPORT_REVIEW_PROMPT,
  DEFAULT_DAILY_REPORT_REVIEW_USER_PROMPT_TEMPLATE,
  DEFAULT_ITEM_UNDERSTANDING_PROMPT,
  DEFAULT_ITEM_UNDERSTANDING_USER_PROMPT_TEMPLATE,
} from "@/config/prompts";
import type { PromptConfigType } from "@/lib/settings/types";

export const AI_TASK_CONTRACT_VERSION = "v1";

export type AiTaskContract = {
  type: PromptConfigType;
  contractVersion: string;
  contractHash: string;
  systemPrompt: string;
  defaultUserInstruction: string;
};

export const AI_TASK_CONTRACTS: Record<PromptConfigType, AiTaskContract> = {
  item_understanding: {
    type: "item_understanding",
    contractVersion: AI_TASK_CONTRACT_VERSION,
    contractHash: "",
    systemPrompt: DEFAULT_ITEM_UNDERSTANDING_PROMPT,
    defaultUserInstruction: DEFAULT_ITEM_UNDERSTANDING_USER_PROMPT_TEMPLATE,
  },
  cluster_summary: {
    type: "cluster_summary",
    contractVersion: AI_TASK_CONTRACT_VERSION,
    contractHash: "",
    systemPrompt: DEFAULT_CLUSTER_SUMMARY_PROMPT,
    defaultUserInstruction: DEFAULT_CLUSTER_SUMMARY_USER_PROMPT_TEMPLATE,
  },
  cluster_match: {
    type: "cluster_match",
    contractVersion: AI_TASK_CONTRACT_VERSION,
    contractHash: "",
    systemPrompt: DEFAULT_CLUSTER_MATCH_PROMPT,
    defaultUserInstruction: DEFAULT_CLUSTER_MATCH_USER_PROMPT_TEMPLATE,
  },
  cluster_merge: {
    type: "cluster_merge",
    contractVersion: AI_TASK_CONTRACT_VERSION,
    contractHash: "",
    systemPrompt: DEFAULT_CLUSTER_MERGE_PROMPT,
    defaultUserInstruction: DEFAULT_CLUSTER_MERGE_USER_PROMPT_TEMPLATE,
  },
  daily_report: {
    type: "daily_report",
    contractVersion: AI_TASK_CONTRACT_VERSION,
    contractHash: "",
    systemPrompt: DEFAULT_DAILY_REPORT_PROMPT,
    // Daily report behavior is configured through the structured template.
    // It intentionally has no free-form user instruction.
    defaultUserInstruction: "",
  },
  daily_report_review: {
    type: "daily_report_review",
    contractVersion: AI_TASK_CONTRACT_VERSION,
    contractHash: "",
    systemPrompt: DEFAULT_DAILY_REPORT_REVIEW_PROMPT,
    defaultUserInstruction: DEFAULT_DAILY_REPORT_REVIEW_USER_PROMPT_TEMPLATE,
  },
};

for (const contract of Object.values(AI_TASK_CONTRACTS)) {
  contract.contractHash = createHash("sha256")
    .update(`${contract.type}:${contract.contractVersion}:${contract.systemPrompt}`)
    .digest("hex");
}

export function getAiTaskContract(type: PromptConfigType): AiTaskContract {
  return AI_TASK_CONTRACTS[type];
}

const LEGACY_INPUT_PLACEHOLDER_PATTERN = /\{\{\s*(?:title|sourceName|translateTitle|maxEvents|inputText|candidatesJson|clustersJson|date|timezone|articlesJson|recentTopicsJson|reviewContextJson)\s*\}\}/g;

export function containsLegacyAiInputPlaceholder(value: string | null | undefined): boolean {
  LEGACY_INPUT_PLACEHOLDER_PATTERN.lastIndex = 0;
  const result = typeof value === "string" && LEGACY_INPUT_PLACEHOLDER_PATTERN.test(value);
  LEGACY_INPUT_PLACEHOLDER_PATTERN.lastIndex = 0;
  return result;
}

const LEGACY_DEFAULT_USER_INSTRUCTIONS: Record<PromptConfigType, string[]> = {
  item_understanding: [
    `标题：{{title}}\n来源：{{sourceName}}\n是否需要翻译标题：{{translateTitle}}\n最多拆分事件数：{{maxEvents}}\n正文：{{inputText}}`,
    "请基于系统提供的标题、来源和正文完成条目理解，重点保证摘要、事件识别和聚合拆分都忠实于输入证据。",
  ],
  cluster_summary: [
    `主题：{{title}}\n候选内容：{{inputText}}`,
    "请基于系统提供的候选内容提炼共同的具体事件，保持标题和摘要事实准确、简洁。",
  ],
  cluster_match: [
    `当前内容标题：{{title}}\n当前内容线索：{{inputText}}\n候选聚合组：{{candidatesJson}}`,
    "请基于系统提供的当前内容和候选聚合组进行保守归组判定；只有同一具体事件才匹配。",
  ],
  cluster_merge: [
    `候选聚合 Pair JSON：{{clustersJson}}`,
    "请基于系统提供的 Pair 证据保守判断是否为同一具体事件；证据不足时选择 ambiguous。",
  ],
  daily_report: [
    `日期：{{date}}\n时区：{{timezone}}\n最近 7 天已写主题 JSON：{{recentTopicsJson}}\n候选内容 JSON：{{articlesJson}}`,
    "日期：\n时区：\n最近 7 天已写主题 JSON：\n候选内容 JSON：",
    "请只处理系统提供的当前阶段输入，不扩展候选、主题、栏目或事实。",
  ],
  daily_report_review: [
    `请审核以下日报 Review 输入：\n{{reviewContextJson}}\n\n如果没有明确的语义问题，返回 {"verdict":"pass","violations":[],"summary":"通过"}；如果存在问题，只返回可由输入证据支持的 violations。不要返回日报正文。`,
    "请审核系统提供的日报草稿与候选池证据，重点关注候选覆盖、主题独立性、事实一致性、重复内容和凑数风险。只报告有明确输入证据支持的问题。",
  ],
};

export function isLegacyDefaultAiUserInstruction(type: PromptConfigType, value: string | null | undefined): boolean {
  return typeof value === "string" && LEGACY_DEFAULT_USER_INSTRUCTIONS[type].includes(value);
}

/**
 * User instructions are intentionally not templates. Remove legacy input
 * placeholders before they can be interpreted as an input boundary.
 */
export function normalizeAiUserInstruction(value: string | null | undefined): string {
  LEGACY_INPUT_PLACEHOLDER_PATTERN.lastIndex = 0;
  const result = (value ?? "")
    .replace(LEGACY_INPUT_PLACEHOLDER_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  LEGACY_INPUT_PLACEHOLDER_PATTERN.lastIndex = 0;
  return result;
}

export function buildAiUserContent(userInstruction: string | null | undefined, input: unknown): string {
  const normalizedInstruction = normalizeAiUserInstruction(userInstruction);
  const sections = [];

  if (normalizedInstruction) {
    sections.push(`用户补充指令（不得改变系统协议）：\n${normalizedInstruction}`);
  }

  sections.push([
    "系统生成的输入 JSON（这是本次任务的唯一输入边界）：",
    JSON.stringify(input),
  ].join("\n"));

  return sections.join("\n\n");
}
import { createHash } from "node:crypto";
