import type { BriefingPreferenceConfig, EventBriefingConfig } from "@prisma/client";

import { prisma } from "@/lib/db";
import { invalidateEventBriefingCache } from "@/lib/events/cache";
import { toIsoString } from "@/lib/settings/core";
import type {
  AdminEventBriefingChannel,
  AdminBriefingPreferenceConfig,
  AdminBriefingWeightRule,
  AdminBriefingWeightRuleType,
  AdminEventBriefingConfig,
} from "@/lib/settings/types";

export const EVENT_BRIEFING_MIN_RANK_SCORE_MIN = 0;
export const EVENT_BRIEFING_MIN_RANK_SCORE_MAX = 100;
export const EVENT_BRIEFING_MAX_CURATOR_BOOST_MIN = 0;
export const EVENT_BRIEFING_MAX_CURATOR_BOOST_MAX = 30;
export const EVENT_BRIEFING_MAX_CURATOR_PENALTY_MIN = 0;
export const EVENT_BRIEFING_MAX_CURATOR_PENALTY_MAX = 50;

export type SaveEventBriefingConfigInput = {
  minRankScore: number;
  channels?: AdminEventBriefingChannel[];
};

export type SaveBriefingPreferenceConfigInput = {
  weightedRules: AdminBriefingWeightRule[];
  maxCuratorBoost: number;
  maxCuratorPenalty: number;
};

const BRIEFING_WEIGHT_RULE_TYPES = new Set<AdminBriefingWeightRuleType>([
  "entity",
  "keyword",
  "source_group",
  "event_type",
]);

export const DEFAULT_EVENT_BRIEFING_CHANNEL_ID = "important";
export const DEFAULT_EVENT_BRIEFING_CHANNEL_NAME = "重点事件";
const MAX_EVENT_BRIEFING_CHANNELS = 12;
const MAX_EVENT_BRIEFING_CHANNEL_NAME_LENGTH = 24;

const DEFAULT_EVENT_BRIEFING_CHANNEL: AdminEventBriefingChannel = {
  id: DEFAULT_EVENT_BRIEFING_CHANNEL_ID,
  name: DEFAULT_EVENT_BRIEFING_CHANNEL_NAME,
  sourceGroupIds: [],
  enabled: true,
  sortOrder: 0,
};

function assertIntRange(value: number, field: string, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} 需为 ${min}-${max} 的整数。`);
  }
}

function normalizeWeightedRules(input: AdminBriefingWeightRule[], max = 100) {
  const seen = new Set<string>();
  const result: AdminBriefingWeightRule[] = [];

  for (const rule of input) {
    const type = rule.type;
    const value = rule.value.trim();
    const weight = Math.round(rule.weight);

    if (!BRIEFING_WEIGHT_RULE_TYPES.has(type) || !value || !Number.isFinite(weight) || weight === 0) {
      continue;
    }

    const normalizedValue = type === "event_type" ? value.toLowerCase() : value;
    const key = `${type}:${normalizedValue.toLowerCase()}:${weight}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({
      type,
      value: normalizedValue,
      weight: Math.max(-50, Math.min(30, weight)),
    });

    if (result.length >= max) {
      break;
    }
  }

  return result;
}

function normalizeChannelId(value: string | null | undefined, index: number) {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return normalized || `channel-${index + 1}`;
}

function normalizeChannelSourceGroupIds(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))].slice(0, 50);
}

function normalizeEventBriefingChannels(input: AdminEventBriefingChannel[], options?: { fallbackToDefault?: boolean }) {
  const seenIds = new Set<string>();
  const result: AdminEventBriefingChannel[] = [];

  for (const [index, channel] of input.entries()) {
    const name = String(channel.name ?? "").trim();
    const baseId = normalizeChannelId(channel.id, index);
    let id = baseId;
    let duplicateIndex = 2;

    while (seenIds.has(id)) {
      id = `${baseId}-${duplicateIndex}`;
      duplicateIndex += 1;
    }

    if (!name) {
      continue;
    }

    seenIds.add(id);
    result.push({
      id,
      name: name.slice(0, MAX_EVENT_BRIEFING_CHANNEL_NAME_LENGTH),
      sourceGroupIds: normalizeChannelSourceGroupIds(channel.sourceGroupIds),
      enabled: channel.enabled !== false,
      sortOrder: Number.isInteger(channel.sortOrder) ? channel.sortOrder : index,
    });

    if (result.length >= MAX_EVENT_BRIEFING_CHANNELS) {
      break;
    }
  }

  if (result.length === 0 && options?.fallbackToDefault !== false) {
    return [DEFAULT_EVENT_BRIEFING_CHANNEL];
  }

  return result.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
}

function parseWeightedRules(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return normalizeWeightedRules(
        parsed
          .map((entry): AdminBriefingWeightRule | null => {
            if (!entry || typeof entry !== "object") {
              return null;
            }

            const type = "type" in entry ? entry.type : null;
            const value = "value" in entry ? entry.value : null;
            const weight = "weight" in entry ? entry.weight : null;

            if (
              typeof type !== "string" ||
              !BRIEFING_WEIGHT_RULE_TYPES.has(type as AdminBriefingWeightRuleType) ||
              typeof value !== "string"
            ) {
              return null;
            }

            return {
              type: type as AdminBriefingWeightRuleType,
              value,
              weight: typeof weight === "number" ? weight : Number(weight),
            };
          })
          .filter((entry): entry is AdminBriefingWeightRule => Boolean(entry)),
      );
    }
  } catch {
    // fall through
  }

  return [];
}

function parseEventBriefingChannels(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return normalizeEventBriefingChannels(
        parsed
          .map((entry): AdminEventBriefingChannel | null => {
            if (!entry || typeof entry !== "object") {
              return null;
            }

            const id = "id" in entry ? entry.id : null;
            const name = "name" in entry ? entry.name : null;
            const sourceGroupIds = "sourceGroupIds" in entry ? entry.sourceGroupIds : [];
            const enabled = "enabled" in entry ? entry.enabled : true;
            const sortOrder = "sortOrder" in entry ? entry.sortOrder : 0;

            if (typeof name !== "string") {
              return null;
            }

            return {
              id: typeof id === "string" ? id : "",
              name,
              sourceGroupIds: normalizeChannelSourceGroupIds(sourceGroupIds),
              enabled: enabled !== false,
              sortOrder: typeof sortOrder === "number" ? sortOrder : Number(sortOrder),
            };
          })
          .filter((entry): entry is AdminEventBriefingChannel => Boolean(entry)),
      );
    }
  } catch {
    // fall through
  }

  return [DEFAULT_EVENT_BRIEFING_CHANNEL];
}

export function validateEventBriefingConfigInput(input: SaveEventBriefingConfigInput) {
  assertIntRange(input.minRankScore, "最低入选分", EVENT_BRIEFING_MIN_RANK_SCORE_MIN, EVENT_BRIEFING_MIN_RANK_SCORE_MAX);
  const channels = normalizeEventBriefingChannels(input.channels ?? [DEFAULT_EVENT_BRIEFING_CHANNEL], {
    fallbackToDefault: false,
  });

  if (channels.length === 0) {
    throw new Error("至少需要配置一个速览频道。");
  }
  if (!channels.some((channel) => channel.enabled)) {
    throw new Error("至少需要启用一个速览频道。");
  }
}

export function validateBriefingPreferenceConfigInput(input: SaveBriefingPreferenceConfigInput) {
  assertIntRange(
    input.maxCuratorBoost,
    "主理人加权上限",
    EVENT_BRIEFING_MAX_CURATOR_BOOST_MIN,
    EVENT_BRIEFING_MAX_CURATOR_BOOST_MAX,
  );
  assertIntRange(
    input.maxCuratorPenalty,
    "主理人降权上限",
    EVENT_BRIEFING_MAX_CURATOR_PENALTY_MIN,
    EVENT_BRIEFING_MAX_CURATOR_PENALTY_MAX,
  );
  normalizeWeightedRules(input.weightedRules);
}

export async function ensureEventBriefingConfig(): Promise<EventBriefingConfig> {
  const existing = await prisma.eventBriefingConfig.findFirst({
    orderBy: { createdAt: "asc" },
  });

  if (existing) {
    return existing;
  }

  return prisma.eventBriefingConfig.create({ data: {} });
}

export async function ensureBriefingPreferenceConfig(): Promise<BriefingPreferenceConfig> {
  const existing = await prisma.briefingPreferenceConfig.findFirst({
    orderBy: { createdAt: "asc" },
  });

  if (existing) {
    return existing;
  }

  return prisma.briefingPreferenceConfig.create({ data: {} });
}

export function serializeAdminEventBriefingConfig(config: EventBriefingConfig): AdminEventBriefingConfig {
  return {
    id: config.id,
    minRankScore: config.minRankScore,
    channels: parseEventBriefingChannels(config.briefingChannelsJson),
    createdAt: toIsoString(config.createdAt),
    updatedAt: toIsoString(config.updatedAt),
  };
}

export function serializeAdminBriefingPreferenceConfig(
  config: BriefingPreferenceConfig,
): AdminBriefingPreferenceConfig {
  return {
    id: config.id,
    weightedRules: parseWeightedRules(config.weightedRulesJson),
    maxCuratorBoost: config.maxCuratorBoost,
    maxCuratorPenalty: config.maxCuratorPenalty,
    createdAt: toIsoString(config.createdAt),
    updatedAt: toIsoString(config.updatedAt),
  };
}

export async function updateEventBriefingConfig(input: SaveEventBriefingConfigInput) {
  validateEventBriefingConfigInput(input);
  const current = await ensureEventBriefingConfig();
  const channels = input.channels ?? parseEventBriefingChannels(current.briefingChannelsJson);
  const config = await prisma.eventBriefingConfig.update({
    where: { id: current.id },
    data: {
      minRankScore: input.minRankScore,
      briefingChannelsJson: JSON.stringify(normalizeEventBriefingChannels(channels)),
    },
  });

  invalidateEventBriefingCache();
  return serializeAdminEventBriefingConfig(config);
}

export async function updateBriefingPreferenceConfig(input: SaveBriefingPreferenceConfigInput) {
  validateBriefingPreferenceConfigInput(input);
  const current = await ensureBriefingPreferenceConfig();
  const preference = await prisma.briefingPreferenceConfig.update({
    where: { id: current.id },
    data: {
      weightedRulesJson: JSON.stringify(normalizeWeightedRules(input.weightedRules)),
      maxCuratorBoost: input.maxCuratorBoost,
      maxCuratorPenalty: input.maxCuratorPenalty,
    },
  });

  invalidateEventBriefingCache();
  return serializeAdminBriefingPreferenceConfig(preference);
}
