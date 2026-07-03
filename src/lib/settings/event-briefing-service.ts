import type { BriefingPreferenceConfig, EventBriefingConfig } from "@prisma/client";

import { prisma } from "@/lib/db";
import { invalidateEventBriefingCache } from "@/lib/events/cache";
import { toIsoString } from "@/lib/settings/core";
import type {
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
};

export type SaveBriefingPreferenceConfigInput = {
  weightedRules: AdminBriefingWeightRule[];
  maxCuratorBoost: number;
  maxCuratorPenalty: number;
};

const BRIEFING_WEIGHT_RULE_TYPES = new Set<AdminBriefingWeightRuleType>([
  "tag",
  "keyword",
  "source_group",
  "event_type",
]);

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

export function validateEventBriefingConfigInput(input: SaveEventBriefingConfigInput) {
  assertIntRange(input.minRankScore, "最低入选分", EVENT_BRIEFING_MIN_RANK_SCORE_MIN, EVENT_BRIEFING_MIN_RANK_SCORE_MAX);
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
  const config = await prisma.eventBriefingConfig.update({
    where: { id: current.id },
    data: {
      minRankScore: input.minRankScore,
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
