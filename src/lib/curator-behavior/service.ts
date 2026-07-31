import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import {
  ensureBriefingPreferenceConfig,
  serializeAdminBriefingPreferenceConfig,
  updateBriefingPreferenceConfig,
} from "@/lib/settings/event-briefing-service";
import type { AdminBriefingWeightRule, AdminBriefingWeightRuleType } from "@/lib/settings/types";

export const CURATOR_BEHAVIOR_EVENT_TYPES = [
  "event_detail_opened",
  "feed_item_opened",
  "event_source_clicked",
  "manual_boost",
  "item_filtered",
  "cluster_hidden",
  "manual_penalty",
] as const;

export type CuratorBehaviorEventType = (typeof CURATOR_BEHAVIOR_EVENT_TYPES)[number];
export type CuratorBehaviorTargetType = "event" | "item" | "cluster";
export type CuratorBehaviorEntryType = "single" | "cluster";
export type BriefingPreferenceSuggestionStatus = "pending" | "accepted" | "dismissed";

export type CuratorBehaviorInput = {
  eventType: CuratorBehaviorEventType;
  targetType: CuratorBehaviorTargetType;
  targetId: string;
  entryType?: CuratorBehaviorEntryType | null;
  entryId?: string | null;
  itemId?: string | null;
  clusterId?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
};

export type BriefingPreferenceSuggestionDTO = {
  id: string;
  ruleType: AdminBriefingWeightRuleType;
  value: string;
  label: string | null;
  suggestedWeight: number;
  confidence: number;
  positiveScore: number;
  negativeScore: number;
  sampleCount: number;
  reason: string;
  status: BriefingPreferenceSuggestionStatus;
  createdAt: string;
  updatedAt: string;
};

type BehaviorDimension = {
  ruleType: AdminBriefingWeightRuleType;
  value: string;
  label?: string | null;
};

type DimensionTarget = {
  targetType: CuratorBehaviorTargetType;
  targetId: string;
  itemId?: string | null;
  clusterId?: string | null;
};

const BEHAVIOR_SCORES: Record<CuratorBehaviorEventType, number> = {
  event_detail_opened: 1,
  feed_item_opened: 1,
  event_source_clicked: 2,
  manual_boost: 5,
  item_filtered: -4,
  cluster_hidden: -5,
  manual_penalty: -5,
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  release: "版本发布",
  launch: "产品上线",
  update: "进展更新",
  funding: "融资",
  acquisition: "收购",
  partnership: "合作",
  policy: "政策",
  research: "研究",
  security: "安全",
  other: "其他",
};

const RULE_TYPE_LABELS: Record<AdminBriefingWeightRuleType, string> = {
  entity: "实体",
  keyword: "关键词",
  source_group: "来源组",
  event_type: "事件类型",
};

const KEYWORD_STOPWORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "from",
  "into",
  "about",
  "this",
  "that",
  "news",
  "update",
  "launch",
  "release",
]);

function normalizeRuleValue(type: AdminBriefingWeightRuleType, value: string) {
  const trimmed = value.trim();
  return type === "keyword" || type === "event_type" || type === "entity"
    ? trimmed.toLowerCase()
    : trimmed;
}

function serializeSuggestion(row: {
  id: string;
  ruleType: string;
  value: string;
  label: string | null;
  suggestedWeight: number;
  confidence: number;
  positiveScore: number;
  negativeScore: number;
  sampleCount: number;
  reason: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): BriefingPreferenceSuggestionDTO {
  return {
    id: row.id,
    ruleType: row.ruleType as AdminBriefingWeightRuleType,
    value: row.value,
    label: row.label,
    suggestedWeight: row.suggestedWeight,
    confidence: row.confidence,
    positiveScore: row.positiveScore,
    negativeScore: row.negativeScore,
    sampleCount: row.sampleCount,
    reason: row.reason,
    status: row.status as BriefingPreferenceSuggestionStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function uniqueDimensions(dimensions: BehaviorDimension[]) {
  const seen = new Set<string>();
  const result: BehaviorDimension[] = [];

  for (const dimension of dimensions) {
    const value = normalizeRuleValue(dimension.ruleType, dimension.value);
    if (!value) {
      continue;
    }

    const key = `${dimension.ruleType}:${value}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({
      ruleType: dimension.ruleType,
      value,
      label: dimension.label?.trim() || null,
    });
  }

  return result;
}

function parseClusterEntities(raw: string | null | undefined): BehaviorDimension[] {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry): BehaviorDimension | null => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        const name = "name" in entry && typeof entry.name === "string" ? entry.name.trim() : "";
        const normalized = "normalized" in entry && typeof entry.normalized === "string"
          ? entry.normalized.trim()
          : name.toLowerCase();

        return normalized ? { ruleType: "entity", value: normalized, label: name || normalized } : null;
      })
      .filter((entry): entry is BehaviorDimension => Boolean(entry));
  } catch {
    return [];
  }
}

function extractKeywords(parts: Array<string | null | undefined>) {
  const keywords = new Set<string>();

  for (const part of parts) {
    const text = part?.trim();
    if (!text) {
      continue;
    }

    if (/[\u4e00-\u9fff]/.test(text) && text.length <= 16) {
      keywords.add(text.toLowerCase());
    }

    for (const token of text.match(/[A-Za-z0-9][A-Za-z0-9.+_-]{2,}/g) ?? []) {
      const normalized = token.toLowerCase();
      if (!KEYWORD_STOPWORDS.has(normalized)) {
        keywords.add(normalized);
      }
    }
  }

  return [...keywords].slice(0, 5).map((keyword) => ({
    ruleType: "keyword" as const,
    value: keyword,
    label: keyword,
  }));
}

function buildDedupKey(input: {
  eventType: CuratorBehaviorEventType;
  targetType: CuratorBehaviorTargetType;
  targetId: string;
  ruleType: AdminBriefingWeightRuleType;
  value: string;
  occurredAt: Date;
}) {
  const day = input.occurredAt.toISOString().slice(0, 10);
  return [
    input.eventType,
    input.targetType,
    input.targetId,
    input.ruleType,
    input.value.toLowerCase(),
    day,
  ].join(":");
}

async function resolveItemDimensions(itemId: string): Promise<BehaviorDimension[]> {
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    select: {
      originalTitle: true,
      translatedTitle: true,
      eventType: true,
      eventSubject: true,
      eventAction: true,
      eventObject: true,
      source: {
        select: {
          groupId: true,
          group: {
            select: { name: true },
          },
        },
      },
      entities: {
        select: {
          entity: {
            select: {
              name: true,
              normalized: true,
            },
          },
        },
      },
    },
  });

  if (!item) {
    return [];
  }

  return uniqueDimensions([
    ...(item.source.groupId
      ? [{
        ruleType: "source_group" as const,
        value: item.source.groupId,
        label: item.source.group?.name ?? item.source.groupId,
      }]
      : []),
    ...item.entities.map(({ entity }) => ({
      ruleType: "entity" as const,
      value: entity.normalized,
      label: entity.name,
    })),
    ...(item.eventType
      ? [{
        ruleType: "event_type" as const,
        value: item.eventType,
        label: EVENT_TYPE_LABELS[item.eventType] ?? item.eventType,
      }]
      : []),
    ...extractKeywords([
      item.eventSubject,
      item.eventObject,
      item.translatedTitle,
      item.originalTitle,
    ]),
  ]);
}

async function resolveClusterDimensions(clusterId: string): Promise<BehaviorDimension[]> {
  const cluster = await prisma.contentCluster.findUnique({
    where: { id: clusterId },
    select: {
      title: true,
      eventType: true,
      eventSubject: true,
      eventAction: true,
      eventObject: true,
      feedEntitiesJson: true,
      dominantGroupId: true,
      dominantGroup: {
        select: { name: true },
      },
      items: {
        select: {
          eventType: true,
          eventSubject: true,
          eventObject: true,
          originalTitle: true,
          translatedTitle: true,
          source: {
            select: {
              groupId: true,
              group: {
                select: { name: true },
              },
            },
          },
          entities: {
            select: {
              entity: {
                select: {
                  name: true,
                  normalized: true,
                },
              },
            },
          },
        },
        take: 80,
      },
    },
  });

  if (!cluster) {
    return [];
  }

  return uniqueDimensions([
    ...(cluster.dominantGroupId
      ? [{
        ruleType: "source_group" as const,
        value: cluster.dominantGroupId,
        label: cluster.dominantGroup?.name ?? cluster.dominantGroupId,
      }]
      : []),
    ...cluster.items.flatMap((item) => item.source.groupId
      ? [{
        ruleType: "source_group" as const,
        value: item.source.groupId,
        label: item.source.group?.name ?? item.source.groupId,
      }]
      : []),
    ...parseClusterEntities(cluster.feedEntitiesJson),
    ...cluster.items.flatMap((item) => item.entities.map(({ entity }) => ({
      ruleType: "entity" as const,
      value: entity.normalized,
      label: entity.name,
    }))),
    ...(cluster.eventType
      ? [{
        ruleType: "event_type" as const,
        value: cluster.eventType,
        label: EVENT_TYPE_LABELS[cluster.eventType] ?? cluster.eventType,
      }]
      : []),
    ...cluster.items.flatMap((item) => item.eventType
      ? [{
        ruleType: "event_type" as const,
        value: item.eventType,
        label: EVENT_TYPE_LABELS[item.eventType] ?? item.eventType,
      }]
      : []),
    ...extractKeywords([
      cluster.eventSubject,
      cluster.eventObject,
      cluster.title,
      ...cluster.items.flatMap((item) => [
        item.eventSubject,
        item.eventObject,
        item.translatedTitle,
        item.originalTitle,
      ]),
    ]),
  ]);
}

function resolveTarget(input: CuratorBehaviorInput): DimensionTarget {
  if (input.targetType === "event") {
    const entryType = input.entryType;
    const entryId = input.entryId ?? input.targetId;

    if (entryType === "cluster") {
      return {
        targetType: "cluster",
        targetId: entryId,
        clusterId: entryId,
        itemId: input.itemId ?? null,
      };
    }

    return {
      targetType: "item",
      targetId: input.itemId ?? entryId,
      itemId: input.itemId ?? entryId,
      clusterId: input.clusterId ?? null,
    };
  }

  return {
    targetType: input.targetType,
    targetId: input.targetId,
    itemId: input.itemId ?? (input.targetType === "item" ? input.targetId : null),
    clusterId: input.clusterId ?? (input.targetType === "cluster" ? input.targetId : null),
  };
}

async function resolveDimensions(target: DimensionTarget) {
  if (target.targetType === "cluster") {
    return resolveClusterDimensions(target.targetId);
  }

  return resolveItemDimensions(target.targetId);
}

export function getCuratorBehaviorScore(eventType: CuratorBehaviorEventType) {
  return BEHAVIOR_SCORES[eventType];
}

export function compressBehaviorNetScore(netScore: number) {
  const abs = Math.abs(netScore);
  if (abs === 0) {
    return 0;
  }
  const magnitude = abs >= 7 ? 3 : abs >= 3 ? 2 : 1;
  return netScore > 0 ? magnitude : -magnitude;
}

export async function recordCuratorBehavior(input: CuratorBehaviorInput) {
  const score = BEHAVIOR_SCORES[input.eventType];
  const occurredAt = input.occurredAt ?? new Date();
  const target = resolveTarget(input);
  const dimensions = await resolveDimensions(target);

  const event = await prisma.curatorBehaviorEvent.create({
    data: {
      eventType: input.eventType,
      targetType: input.targetType,
      targetId: input.targetId,
      entryType: input.entryType ?? null,
      entryId: input.entryId ?? null,
      itemId: target.itemId ?? null,
      clusterId: target.clusterId ?? null,
      score,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      createdAt: occurredAt,
    },
  });

  for (const dimension of dimensions) {
    try {
      await prisma.curatorBehaviorDimension.create({
        data: {
          eventId: event.id,
          ruleType: dimension.ruleType,
          value: dimension.value,
          label: dimension.label ?? null,
          score,
          occurredAt,
          targetDedupKey: buildDedupKey({
            eventType: input.eventType,
            targetType: target.targetType,
            targetId: target.targetId,
            ruleType: dimension.ruleType,
            value: dimension.value,
            occurredAt,
          }),
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
        throw error;
      }
    }
  }

  return event;
}

function suggestionKey(type: AdminBriefingWeightRuleType, value: string) {
  return `${type}:${value.toLowerCase()}`;
}

function buildSuggestionReason(input: {
  ruleType: AdminBriefingWeightRuleType;
  label: string;
  netScore: number;
  sampleCount: number;
}) {
  const direction = input.netScore > 0 ? "偏好更强" : "降权信号更强";
  return `${RULE_TYPE_LABELS[input.ruleType]}「${input.label}」近 30 天${direction}，来自 ${input.sampleCount} 次管理行为。`;
}

function calculateConfidence(sampleCount: number, netScore: number) {
  return Math.min(0.95, Number((0.35 + Math.min(sampleCount, 10) * 0.04 + Math.min(Math.abs(netScore), 12) * 0.02).toFixed(2)));
}

export async function generateBriefingPreferenceSuggestions(options: { now?: Date; days?: number } = {}) {
  const now = options.now ?? new Date();
  const days = options.days ?? 30;
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const [rows, preferenceRow] = await Promise.all([
    prisma.curatorBehaviorDimension.findMany({
      where: { occurredAt: { gte: since, lte: now } },
      select: {
        ruleType: true,
        value: true,
        label: true,
        score: true,
      },
    }),
    ensureBriefingPreferenceConfig(),
  ]);
  const preference = serializeAdminBriefingPreferenceConfig(preferenceRow);
  const configured = new Set(preference.weightedRules.map((rule) => suggestionKey(rule.type, rule.value)));
  const grouped = new Map<string, {
    ruleType: AdminBriefingWeightRuleType;
    value: string;
    label: string;
    positiveScore: number;
    negativeScore: number;
    sampleCount: number;
  }>();

  for (const row of rows) {
    const ruleType = row.ruleType as AdminBriefingWeightRuleType;
    const value = normalizeRuleValue(ruleType, row.value);
    if (!value || configured.has(suggestionKey(ruleType, value))) {
      continue;
    }

    const key = suggestionKey(ruleType, value);
    const current = grouped.get(key) ?? {
      ruleType,
      value,
      label: row.label?.trim() || value,
      positiveScore: 0,
      negativeScore: 0,
      sampleCount: 0,
    };

    if (row.score > 0) {
      current.positiveScore += row.score;
    } else {
      current.negativeScore += Math.abs(row.score);
    }
    current.sampleCount += 1;
    grouped.set(key, current);
  }

  const generated: BriefingPreferenceSuggestionDTO[] = [];

  for (const item of grouped.values()) {
    const netScore = item.positiveScore - item.negativeScore;
    const suggestedWeight = compressBehaviorNetScore(netScore);
    if (suggestedWeight === 0) {
      continue;
    }

    const key = suggestionKey(item.ruleType, item.value);
    const existing = await prisma.briefingPreferenceSuggestion.findUnique({
      where: { suggestionKey: key },
    });

    if (existing && existing.status !== "pending") {
      continue;
    }

    const data = {
      ruleType: item.ruleType,
      value: item.value,
      label: item.label,
      suggestedWeight,
      confidence: calculateConfidence(item.sampleCount, netScore),
      positiveScore: item.positiveScore,
      negativeScore: item.negativeScore,
      sampleCount: item.sampleCount,
      reason: buildSuggestionReason({
        ruleType: item.ruleType,
        label: item.label,
        netScore,
        sampleCount: item.sampleCount,
      }),
      status: "pending",
      dismissedAt: null,
      acceptedAt: null,
    };
    const row = existing
      ? await prisma.briefingPreferenceSuggestion.update({
        where: { id: existing.id },
        data,
      })
      : await prisma.briefingPreferenceSuggestion.create({
        data: {
          suggestionKey: key,
          ...data,
        },
      });

    generated.push(serializeSuggestion(row));
  }

  return generated.sort((left, right) => {
    if (Math.abs(right.suggestedWeight) !== Math.abs(left.suggestedWeight)) {
      return Math.abs(right.suggestedWeight) - Math.abs(left.suggestedWeight);
    }
    return right.confidence - left.confidence;
  });
}

export async function listBriefingPreferenceSuggestions() {
  const rows = await prisma.briefingPreferenceSuggestion.findMany({
    where: { status: "pending" },
    orderBy: [
      { confidence: "desc" },
      { sampleCount: "desc" },
      { updatedAt: "desc" },
    ],
    take: 50,
  });

  return rows.map(serializeSuggestion);
}

function mergeAcceptedRule(rules: AdminBriefingWeightRule[], accepted: AdminBriefingWeightRule) {
  const key = suggestionKey(accepted.type, accepted.value);
  const result = rules.filter((rule) => suggestionKey(rule.type, rule.value) !== key);
  return [...result, accepted];
}

export async function acceptBriefingPreferenceSuggestion(id: string) {
  const suggestion = await prisma.briefingPreferenceSuggestion.findUnique({
    where: { id },
  });

  if (!suggestion || suggestion.status !== "pending") {
    throw new Error("偏好建议不存在或已处理。");
  }

  const preferenceRow = await ensureBriefingPreferenceConfig();
  const preference = serializeAdminBriefingPreferenceConfig(preferenceRow);
  const weightedRules = mergeAcceptedRule(preference.weightedRules, {
    type: suggestion.ruleType as AdminBriefingWeightRuleType,
    value: suggestion.value,
    weight: suggestion.suggestedWeight,
  });
  const updatedPreference = await updateBriefingPreferenceConfig({
    weightedRules,
    maxCuratorBoost: preference.maxCuratorBoost,
    maxCuratorPenalty: preference.maxCuratorPenalty,
  });
  const updatedSuggestion = await prisma.briefingPreferenceSuggestion.update({
    where: { id },
    data: {
      status: "accepted",
      acceptedAt: new Date(),
    },
  });

  return {
    suggestion: serializeSuggestion(updatedSuggestion),
    preference: updatedPreference,
  };
}

export async function dismissBriefingPreferenceSuggestion(id: string) {
  const suggestion = await prisma.briefingPreferenceSuggestion.findUnique({
    where: { id },
  });

  if (!suggestion || suggestion.status !== "pending") {
    throw new Error("偏好建议不存在或已处理。");
  }

  const updated = await prisma.briefingPreferenceSuggestion.update({
    where: { id },
    data: {
      status: "dismissed",
      dismissedAt: new Date(),
    },
  });

  return serializeSuggestion(updated);
}
