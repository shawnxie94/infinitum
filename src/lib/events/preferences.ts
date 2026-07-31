import type { BriefingPreferenceForRuntime, EventBriefingCandidate } from "@/lib/events/types";

export type CuratorPreferenceResult = {
  curatorBoost: number;
  curatorPenalty: number;
};

function normalizeMatchValue(value: string) {
  return value.trim().toLowerCase();
}

function buildSet(values: string[]) {
  return new Set(values.map(normalizeMatchValue).filter(Boolean));
}

export function calculateCuratorPreference(
  candidate: EventBriefingCandidate,
  preference: BriefingPreferenceForRuntime,
): CuratorPreferenceResult {
  const entityValues = candidate.entities
    .flatMap((entity) => [entity.name, entity.normalized].map(normalizeMatchValue));
  const groupIds = candidate.sources.map((source) => source.groupId).filter((groupId): groupId is string => Boolean(groupId));
  const eventType = normalizeMatchValue(candidate.eventType ?? "");
  let curatorBoost = 0;
  let curatorPenalty = 0;

  for (const rule of preference.weightedRules) {
    const value = normalizeMatchValue(rule.value);
    if (!value || rule.weight === 0) {
      continue;
    }

    const matched = rule.type === "entity"
      ? buildSet(entityValues).has(value)
      : rule.type === "source_group"
        ? groupIds.includes(rule.value)
        : rule.type === "keyword"
          ? candidate.searchText.includes(value)
          : eventType === value;

    if (!matched) {
      continue;
    }

    if (rule.weight > 0) {
      curatorBoost += rule.weight;
    } else {
      curatorPenalty += Math.abs(rule.weight);
    }
  }

  return {
    curatorBoost: Math.min(curatorBoost, preference.maxCuratorBoost),
    curatorPenalty: Math.min(curatorPenalty, preference.maxCuratorPenalty),
  };
}
