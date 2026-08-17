import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { refreshClusterFeedStatsSafely } from "@/lib/clusters/feed-stats";
import { invalidateDailyReportCache } from "@/lib/daily-report/cache";
import { invalidateEventBriefingCache } from "@/lib/events/cache";
import { invalidateFeedCache } from "@/lib/feed/cache";
import {
  extractEventEntityNames,
  normalizeItemEntities,
  normalizeEntityName,
  type EventEntitySource,
  type NormalizedEntity,
} from "@/lib/entities/normalization";
import {
  calculateEntitySimilarity,
  compactEntitySimilarityText,
  normalizeEntitySimilarityText,
  sortedEntitySimilarityTokenKey,
  tokenizeEntitySimilarityText,
  type EntitySimilarityReason,
} from "@/lib/entities/similarity";

type PrismaTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const DEFAULT_ENTITY_PAGE_SIZE = 30;
const MAX_ENTITY_PAGE_SIZE = 100;
const DEFAULT_ENTITY_SUGGESTION_LIMIT = 30;
const MAX_ENTITY_SUGGESTION_LIMIT = 100;
const AUTO_CANONICAL_CONFIDENCE_THRESHOLD = 0.98;
const DEFAULT_AUTO_MERGE_SUGGESTION_LIMIT = 100;
const SUGGESTION_CONFIDENCE_THRESHOLD = 0.82;
const ENTITY_SUGGESTION_CANDIDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ENTITY_SUGGESTION_CANDIDATE_CREATE_BATCH_SIZE = 500;
const MAX_ENTITY_SUGGESTION_CANDIDATE_PAIRS = 20_000;
const MAX_ENTITY_SUGGESTION_TOKEN_BUCKET_SIZE = 200;
const MAX_ENTITY_SUGGESTION_EDIT_BUCKET_SIZE = 80;

export type AdminEntityAlias = {
  id: string;
  aliasName: string;
  aliasNormalized: string;
  createdBy: string;
  createdAt: string;
};

export type AdminEntity = {
  id: string;
  name: string;
  normalized: string;
  itemCount: number;
  aliasCount: number;
  aliases: AdminEntityAlias[];
  createdAt: string;
  updatedAt: string;
};

export type AdminEntityList = {
  entities: AdminEntity[];
  totalCount: number;
  page: number;
  pageSize: number;
};

export type AdminEntitySort = "usage_desc" | "updated_desc" | "name_asc" | "alias_desc";

export type AdminEntitySuggestion = {
  id: string;
  sourceEntity: Pick<AdminEntity, "id" | "name" | "normalized" | "itemCount" | "aliasCount">;
  targetEntity: Pick<AdminEntity, "id" | "name" | "normalized" | "itemCount" | "aliasCount">;
  confidence: number;
  reasons: string[];
  affectedItemCount: number;
};

export type AdminEntitySuggestionList = {
  suggestions: AdminEntitySuggestion[];
  totalCount: number;
  page: number;
  pageSize: number;
};

export type AdminEntitySuggestionSort = "confidence_desc" | "affected_desc";

export type AdminEntityAutoMergeResult = {
  scannedCount: number;
  mergedCount: number;
  affectedClusterCount: number;
  skippedCount: number;
  failedCount: number;
};

export type EntitySuggestionPrecomputeResult = {
  entityCount: number;
  scannedPairs: number;
  candidateCount: number;
  storedCandidates: number;
  durationMs: number;
};

type EntityCandidate = {
  id: string;
  name: string;
  normalized: string;
  createdAt: Date;
  updatedAt: Date;
  aliases?: Array<{
    aliasName: string;
    aliasNormalized: string;
  }>;
  _count: {
    items: number;
    aliases: number;
  };
};

type EntitySuggestionCandidatePair = {
  left: EntityCandidate;
  right: EntityCandidate;
};

type EntitySuggestionDraft = {
  sourceEntity: EntityCandidate;
  targetEntity: EntityCandidate;
  baseConfidence: number;
  reason: EntitySimilarityReason;
};

type EntitySuggestionCandidateRecord = {
  pairKey: string;
  sourceEntityId: string;
  targetEntityId: string;
  sourceEntityNormalized: string;
  targetEntityNormalized: string;
  confidence: number;
  affectedItemCount: number;
  sharedItemCount: number;
  reason: EntitySimilarityReason;
  status: string;
  expiresAt: Date;
};

function normalizePage(value: number | null | undefined) {
  return Number.isInteger(value) && value && value > 0 ? value : 1;
}

function normalizePageSize(value: number | null | undefined) {
  if (!Number.isInteger(value) || !value || value <= 0) {
    return DEFAULT_ENTITY_PAGE_SIZE;
  }

  return Math.min(value, MAX_ENTITY_PAGE_SIZE);
}

function serializeAdminEntity(entity: {
  id: string;
  name: string;
  normalized: string;
  createdAt: Date;
  updatedAt: Date;
  aliases: Array<{
    id: string;
    aliasName: string;
    aliasNormalized: string;
    createdBy: string;
    createdAt: Date;
  }>;
  _count: {
    items: number;
    aliases: number;
  };
}): AdminEntity {
  return {
    id: entity.id,
    name: entity.name,
    normalized: entity.normalized,
    itemCount: entity._count.items,
    aliasCount: entity._count.aliases,
    aliases: entity.aliases.map((alias) => ({
      id: alias.id,
      aliasName: alias.aliasName,
      aliasNormalized: alias.aliasNormalized,
      createdBy: alias.createdBy,
      createdAt: alias.createdAt.toISOString(),
    })),
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

function normalizeSuggestionLimit(value: number | null | undefined) {
  if (!Number.isInteger(value) || !value || value <= 0) {
    return DEFAULT_ENTITY_SUGGESTION_LIMIT;
  }

  return Math.min(value, MAX_ENTITY_SUGGESTION_LIMIT);
}

function normalizeSuggestionSort(value: string | null | undefined): AdminEntitySuggestionSort {
  return value === "affected_desc" ? "affected_desc" : "confidence_desc";
}

function serializeEntitySummary(entity: EntityCandidate): AdminEntitySuggestion["sourceEntity"] {
  return {
    id: entity.id,
    name: entity.name,
    normalized: entity.normalized,
    itemCount: entity._count.items,
    aliasCount: entity._count.aliases,
  };
}

function getSimilarityReasonLabel(reason: EntitySimilarityReason) {
  switch (reason) {
    case "compact_match":
      return "空格差异，高置信重复";
    case "punctuation_match":
      return "标点差异，高置信重复";
    case "singular_match":
      return "英文单复数或词序差异";
    case "token_overlap":
      return "关键词包含关系，谨慎合并";
    case "edit_distance":
      return "拼写距离接近";
    default:
      return "实体表达接近";
  }
}

function compareCanonicalPreference(left: EntityCandidate, right: EntityCandidate) {
  if (left._count.items !== right._count.items) {
    return right._count.items - left._count.items;
  }

  if (left._count.aliases !== right._count.aliases) {
    return right._count.aliases - left._count.aliases;
  }

  if (left.name.length !== right.name.length) {
    return left.name.length - right.name.length;
  }

  return left.createdAt.getTime() - right.createdAt.getTime();
}

function resolveSuggestionDirection(left: EntityCandidate, right: EntityCandidate) {
  const [targetEntity, sourceEntity] = [left, right].sort(compareCanonicalPreference);

  return { sourceEntity, targetEntity };
}

function getComparableEntityTexts(entity: EntityCandidate) {
  return [
    entity.name,
    entity.normalized,
    ...((entity.aliases ?? []).flatMap((alias) => [alias.aliasName, alias.aliasNormalized])),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function entityMatchesSuggestionSearch(entity: EntityCandidate, search: string) {
  if (!search) {
    return true;
  }

  return getComparableEntityTexts(entity).some((value) => normalizeEntitySimilarityText(value).includes(search));
}

function addEntityToIndex(index: Map<string, EntityCandidate[]>, key: string, entity: EntityCandidate) {
  if (!key) {
    return;
  }

  const entities = index.get(key) ?? [];
  if (!entities.some((existingEntity) => existingEntity.id === entity.id)) {
    entities.push(entity);
    index.set(key, entities);
  }
}

function addCandidatePair(
  pairs: EntitySuggestionCandidatePair[],
  seenPairIds: Set<string>,
  left: EntityCandidate,
  right: EntityCandidate,
  matchedEntityIds: Set<string> | null,
) {
  if (left.id === right.id || pairs.length >= MAX_ENTITY_SUGGESTION_CANDIDATE_PAIRS) {
    return;
  }

  if (matchedEntityIds && !matchedEntityIds.has(left.id) && !matchedEntityIds.has(right.id)) {
    return;
  }

  const pairId = left.id < right.id ? `${left.id}:${right.id}` : `${right.id}:${left.id}`;
  if (seenPairIds.has(pairId)) {
    return;
  }

  seenPairIds.add(pairId);
  pairs.push({ left, right });
}

function addPairsFromBucket(
  pairs: EntitySuggestionCandidatePair[],
  seenPairIds: Set<string>,
  bucket: EntityCandidate[],
  matchedEntityIds: Set<string> | null,
  maxBucketSize: number,
) {
  if (bucket.length < 2 || bucket.length > maxBucketSize) {
    return;
  }

  for (let leftIndex = 0; leftIndex < bucket.length; leftIndex += 1) {
    const left = bucket[leftIndex];
    if (!left) {
      continue;
    }

    for (let rightIndex = leftIndex + 1; rightIndex < bucket.length; rightIndex += 1) {
      const right = bucket[rightIndex];
      if (!right) {
        continue;
      }

      addCandidatePair(pairs, seenPairIds, left, right, matchedEntityIds);
      if (pairs.length >= MAX_ENTITY_SUGGESTION_CANDIDATE_PAIRS) {
        return;
      }
    }
  }
}

function buildEntitySuggestionCandidatePairs(entities: EntityCandidate[], search: string) {
  const exactIndexes = new Map<string, EntityCandidate[]>();
  const tokenIndexes = new Map<string, EntityCandidate[]>();
  const editIndexes = new Map<string, EntityCandidate[]>();
  const matchedEntityIds = search
    ? new Set(entities.filter((entity) => entityMatchesSuggestionSearch(entity, search)).map((entity) => entity.id))
    : null;

  if (matchedEntityIds && matchedEntityIds.size === 0) {
    return [];
  }

  for (const entity of entities) {
    for (const text of getComparableEntityTexts(entity)) {
      const compact = compactEntitySimilarityText(text);
      const sortedTokenKey = sortedEntitySimilarityTokenKey(text);
      const tokens = tokenizeEntitySimilarityText(text);

      addEntityToIndex(exactIndexes, `compact:${compact}`, entity);
      addEntityToIndex(exactIndexes, `sorted:${sortedTokenKey}`, entity);

      for (const token of tokens) {
        if (token.length >= 2) {
          addEntityToIndex(tokenIndexes, `token:${token}`, entity);
        }
      }

      if (compact.length >= 5) {
        addEntityToIndex(editIndexes, `edit:${compact.slice(0, 3)}:${Math.floor(compact.length / 2)}`, entity);
      }
    }
  }

  const pairs: EntitySuggestionCandidatePair[] = [];
  const seenPairIds = new Set<string>();

  for (const bucket of exactIndexes.values()) {
    addPairsFromBucket(
      pairs,
      seenPairIds,
      bucket,
      matchedEntityIds,
      Number.MAX_SAFE_INTEGER,
    );
  }

  for (const bucket of tokenIndexes.values()) {
    addPairsFromBucket(
      pairs,
      seenPairIds,
      bucket,
      matchedEntityIds,
      MAX_ENTITY_SUGGESTION_TOKEN_BUCKET_SIZE,
    );
  }

  for (const bucket of editIndexes.values()) {
    addPairsFromBucket(
      pairs,
      seenPairIds,
      bucket,
      matchedEntityIds,
      MAX_ENTITY_SUGGESTION_EDIT_BUCKET_SIZE,
    );
  }

  return pairs;
}

function buildSuggestionId(sourceEntity: EntityCandidate, targetEntity: EntityCandidate) {
  return `${sourceEntity.id}:${targetEntity.id}`;
}

function getSuggestionConfidence(baseConfidence: number) {
  return baseConfidence;
}

type PreparedAutoCanonicalAlias = {
  targetNormalized: string;
  aliasName: string;
  aliasNormalized: string;
};

export type PreparedEntityReplacement = {
  entities: NormalizedEntity[];
  autoCanonicalAliases: PreparedAutoCanonicalAlias[];
};

export type PreparedEntityAssignment = {
  itemId: string;
  replacement: PreparedEntityReplacement;
};

export type ItemEntitySource = EventEntitySource;

export function getItemEntityNamesFromEvent(input: ItemEntitySource | null | undefined) {
  return extractEventEntityNames(input).map((entity) => entity.name);
}

export function normalizeItemEntityNames(input: unknown) {
  return normalizeItemEntities(input).map((entity) => entity.name);
}

function findBestCanonicalEntity(entity: NormalizedEntity, candidates: EntityCandidate[]) {
  return candidates
    .map((candidate) => {
      const entitySimilarity = calculateEntitySimilarity(entity.name, candidate.name)
        ?? calculateEntitySimilarity(entity.normalized, candidate.normalized);
      const aliasSimilarity = candidate.aliases
        ?.map((alias) => calculateEntitySimilarity(entity.name, alias.aliasName)
          ?? calculateEntitySimilarity(entity.normalized, alias.aliasNormalized))
        .filter((similarity): similarity is NonNullable<typeof similarity> => Boolean(similarity))
        .sort((left, right) => right.confidence - left.confidence)[0];
      const similarity = [entitySimilarity, aliasSimilarity]
        .filter((value): value is NonNullable<typeof value> => Boolean(value))
        .sort((left, right) => right.confidence - left.confidence)[0];

      return similarity ? { candidate, similarity } : null;
    })
    .filter((match): match is NonNullable<typeof match> => Boolean(match))
    .sort((left, right) => {
      if (left.similarity.confidence !== right.similarity.confidence) {
        return right.similarity.confidence - left.similarity.confidence;
      }

      return compareCanonicalPreference(left.candidate, right.candidate);
    })[0];
}

/**
 * Resolve exact, alias, and fuzzy canonical entities before opening a write
 * transaction. Virtual candidates preserve the old sequential behavior where
 * later items in one aggregation batch can match entities introduced earlier in
 * the same batch.
 */
export async function prepareEntityReplacements(
  entitiesInputs: unknown[],
): Promise<PreparedEntityReplacement[]> {
  const normalizedInputs = entitiesInputs.map(normalizeItemEntities);
  const normalizedKeys = Array.from(new Set(
    normalizedInputs.flatMap((entities) => entities.map((entity) => entity.normalized)),
  ));

  if (normalizedKeys.length === 0) {
    return normalizedInputs.map(() => ({ entities: [], autoCanonicalAliases: [] }));
  }

  const [aliases, exactEntities] = await Promise.all([
    prisma.entityAlias.findMany({
      where: { aliasNormalized: { in: normalizedKeys } },
      include: { entity: true },
    }),
    prisma.entity.findMany({
      where: { normalized: { in: normalizedKeys } },
    }),
  ]);
  const entityByNormalized = new Map(aliases.map((alias) => [alias.aliasNormalized, alias.entity]));
  const exactEntityByNormalized = new Map(exactEntities.map((entity) => [entity.normalized, entity]));
  const hasUnresolvedEntities = normalizedKeys.some(
    (normalized) => !entityByNormalized.has(normalized) && !exactEntityByNormalized.has(normalized),
  );
  const fuzzyCandidates: EntityCandidate[] = hasUnresolvedEntities
    ? await prisma.entity.findMany({
        include: {
          aliases: {
            select: {
              aliasName: true,
              aliasNormalized: true,
            },
          },
          _count: {
            select: {
              items: true,
              aliases: true,
            },
          },
        },
      })
    : [];
  const candidateByNormalized = new Map(
    fuzzyCandidates.map((candidate) => [candidate.normalized, candidate]),
  );
  const resolvedEntityByNormalized = new Map<string, NormalizedEntity>();
  const autoAliasByNormalized = new Map<string, PreparedAutoCanonicalAlias>();
  let virtualCandidateIndex = 0;

  return normalizedInputs.map((entities) => {
    const seen = new Set<string>();
    const canonicalEntities: NormalizedEntity[] = [];
    const autoCanonicalAliases: PreparedAutoCanonicalAlias[] = [];

    for (const entity of entities) {
      let nextEntity = resolvedEntityByNormalized.get(entity.normalized);
      let autoAlias = autoAliasByNormalized.get(entity.normalized);

      if (!nextEntity) {
        const canonicalEntity = entityByNormalized.get(entity.normalized);
        const exactEntity = exactEntityByNormalized.get(entity.normalized);
        nextEntity = canonicalEntity
          ? { name: canonicalEntity.name, normalized: canonicalEntity.normalized }
          : exactEntity
            ? { name: exactEntity.name, normalized: exactEntity.normalized }
            : entity;

        if (!canonicalEntity && !exactEntity && fuzzyCandidates.length > 0) {
          const bestMatch = findBestCanonicalEntity(entity, fuzzyCandidates);
          if (bestMatch && bestMatch.similarity.confidence >= AUTO_CANONICAL_CONFIDENCE_THRESHOLD) {
            nextEntity = {
              name: bestMatch.candidate.name,
              normalized: bestMatch.candidate.normalized,
            };
            autoAlias = {
              targetNormalized: bestMatch.candidate.normalized,
              aliasName: entity.name,
              aliasNormalized: entity.normalized,
            };
            autoAliasByNormalized.set(entity.normalized, autoAlias);
          }
        }

        if (nextEntity.normalized === entity.normalized && !candidateByNormalized.has(entity.normalized)) {
          const virtualCandidate: EntityCandidate = {
            id: `batch:${virtualCandidateIndex}`,
            name: entity.name,
            normalized: entity.normalized,
            createdAt: new Date(virtualCandidateIndex),
            updatedAt: new Date(virtualCandidateIndex),
            aliases: [],
            _count: { items: 0, aliases: 0 },
          };
          virtualCandidateIndex += 1;
          fuzzyCandidates.push(virtualCandidate);
          candidateByNormalized.set(entity.normalized, virtualCandidate);
        }

        resolvedEntityByNormalized.set(entity.normalized, nextEntity);
      }

      if (autoAlias) {
        autoCanonicalAliases.push(autoAlias);
      }
      if (!seen.has(nextEntity.normalized)) {
        seen.add(nextEntity.normalized);
        canonicalEntities.push(nextEntity);
        const candidate = candidateByNormalized.get(nextEntity.normalized);
        if (candidate) {
          candidate._count.items += 1;
        }
      }
    }

    return { entities: canonicalEntities, autoCanonicalAliases };
  });
}

function setsAreEqual(left: Set<string>, right: Set<string>) {
  return left.size === right.size && Array.from(left).every((value) => right.has(value));
}

/**
 * Apply one or more prepared replacements with bounded transaction work:
 * canonical entity upserts, safe alias writes, one current-state read, and at
 * most one batched delete/create pair for changed item relations.
 */
export async function replacePreparedItemEntitiesInTransaction(
  tx: PrismaTransaction,
  assignments: PreparedEntityAssignment[],
) {
  const replacementByItemId = new Map(
    assignments.map((assignment) => [assignment.itemId, assignment.replacement]),
  );
  const entitiesByNormalized = new Map<string, NormalizedEntity>();
  const aliasesByNormalized = new Map<string, PreparedAutoCanonicalAlias>();

  for (const replacement of replacementByItemId.values()) {
    for (const entity of replacement.entities) {
      entitiesByNormalized.set(entity.normalized, entity);
    }
    for (const alias of replacement.autoCanonicalAliases) {
      aliasesByNormalized.set(alias.aliasNormalized, alias);
    }
  }

  const entityIdByNormalized = new Map<string, string>();
  for (const entity of entitiesByNormalized.values()) {
    const storedEntity = await tx.entity.upsert({
      where: { normalized: entity.normalized },
      update: { name: entity.name },
      create: entity,
    });
    entityIdByNormalized.set(storedEntity.normalized, storedEntity.id);
  }

  const aliasesToCheck = Array.from(aliasesByNormalized.values()).filter(
    (alias) => alias.aliasNormalized !== alias.targetNormalized,
  );
  if (aliasesToCheck.length > 0) {
    const aliasKeys = aliasesToCheck.map((alias) => alias.aliasNormalized);
    const existingAliases = await tx.entityAlias.findMany({
      where: { aliasNormalized: { in: aliasKeys } },
      select: { aliasNormalized: true },
    });
    const conflictingEntities = await tx.entity.findMany({
      where: { normalized: { in: aliasKeys } },
      select: { normalized: true },
    });
    const blockedAliases = new Set([
      ...existingAliases.map((alias) => alias.aliasNormalized),
      ...conflictingEntities.map((entity) => entity.normalized),
    ]);
    const aliasData = aliasesToCheck.flatMap((alias) => {
      const entityId = entityIdByNormalized.get(alias.targetNormalized);
      if (!entityId || blockedAliases.has(alias.aliasNormalized)) {
        return [];
      }

      return [{
        entityId,
        aliasName: alias.aliasName,
        aliasNormalized: alias.aliasNormalized,
        createdBy: "system:auto-canonical",
      }];
    });
    if (aliasData.length > 0) {
      await tx.entityAlias.createMany({ data: aliasData });
    }
  }

  const itemIds = Array.from(replacementByItemId.keys());
  if (itemIds.length === 0) {
    return 0;
  }
  const currentRelations = await tx.itemEntity.findMany({
    where: { itemId: { in: itemIds } },
    select: { itemId: true, entityId: true },
  });
  const currentEntityIdsByItemId = new Map<string, Set<string>>();
  for (const relation of currentRelations) {
    const entityIds = currentEntityIdsByItemId.get(relation.itemId) ?? new Set<string>();
    entityIds.add(relation.entityId);
    currentEntityIdsByItemId.set(relation.itemId, entityIds);
  }
  const desiredEntityIdsByItemId = new Map<string, Set<string>>();
  for (const [itemId, replacement] of replacementByItemId) {
    desiredEntityIdsByItemId.set(itemId, new Set(
      replacement.entities.flatMap((entity) => {
        const entityId = entityIdByNormalized.get(entity.normalized);
        return entityId ? [entityId] : [];
      }),
    ));
  }
  const changedItemIds = itemIds.filter((itemId) => !setsAreEqual(
    currentEntityIdsByItemId.get(itemId) ?? new Set(),
    desiredEntityIdsByItemId.get(itemId) ?? new Set(),
  ));

  if (changedItemIds.length === 0) {
    return 0;
  }

  await tx.itemEntity.deleteMany({
    where: { itemId: { in: changedItemIds } },
  });
  const relationData = changedItemIds.flatMap((itemId) => Array.from(
    desiredEntityIdsByItemId.get(itemId) ?? [],
    (entityId) => ({ itemId, entityId }),
  ));
  if (relationData.length > 0) {
    await tx.itemEntity.createMany({ data: relationData });
  }

  return changedItemIds.length;
}

async function replaceItemEntityRelations(itemId: string, entitiesInput: unknown) {
  const [replacement] = await prepareEntityReplacements([entitiesInput]);
  await prisma.$transaction((tx) => replacePreparedItemEntitiesInTransaction(tx, [{
    itemId,
    replacement: replacement ?? { entities: [], autoCanonicalAliases: [] },
  }]));
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    select: { clusterId: true },
  });
  if (item?.clusterId) {
    await refreshClusterFeedStatsSafely([item.clusterId], "replace item entities");
  }
  invalidateFeedCache();
}

export async function replaceItemEntities(itemId: string, entitiesInput: unknown) {
  return replaceItemEntityRelations(itemId, normalizeItemEntityNames(entitiesInput));
}

export type BackfillItemEntitiesOptions = {
  batchSize?: number;
  dryRun?: boolean;
};

export type BackfillItemEntitiesResult = {
  scannedItems: number;
  changedItems: number;
  affectedClusterCount: number;
  dryRun: boolean;
};

/**
 * Rebuild entity associations from stored event subject/object fields. The
 * operation is idempotent and deliberately uses bounded transactions so it
 * can be resumed safely on a large database.
 */
export async function backfillItemEntities(
  input: BackfillItemEntitiesOptions = {},
): Promise<BackfillItemEntitiesResult> {
  const batchSize = Math.max(1, Math.min(500, Math.floor(input.batchSize ?? 200)));
  const dryRun = input.dryRun === true;
  let lastId: string | undefined;
  let scannedItems = 0;
  let changedItems = 0;
  const affectedClusterIds = new Set<string>();

  while (true) {
    const items = await prisma.item.findMany({
      where: {
        OR: [{ eventSubject: { not: null } }, { eventObject: { not: null } }],
      },
      ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
      take: batchSize,
      orderBy: { id: "asc" },
      select: {
        id: true,
        clusterId: true,
        eventSubject: true,
        eventObject: true,
        entities: {
          select: {
            entity: { select: { name: true } },
          },
        },
      },
    });

    if (items.length === 0) {
      break;
    }

    scannedItems += items.length;
    for (const item of items) {
      if (item.clusterId) {
        affectedClusterIds.add(item.clusterId);
      }
    }

    const entityInputs = items.map((item) => getItemEntityNamesFromEvent(item));
    const replacements = await prepareEntityReplacements(entityInputs);

    if (!dryRun) {
      changedItems += await prisma.$transaction(
        (tx) => replacePreparedItemEntitiesInTransaction(tx, items.map((item, index) => ({
          itemId: item.id,
          replacement: replacements[index] ?? { entities: [], autoCanonicalAliases: [] },
        }))),
        { timeout: 15_000 },
      );
    } else {
      changedItems += items.filter((item, index) => {
        const current = new Set(
          normalizeItemEntities(item.entities.map(({ entity }) => entity.name))
            .map((entity) => entity.normalized),
        );
        const desired = new Set((replacements[index]?.entities ?? []).map((entity) => entity.normalized));
        return desired.size > current.size || [...desired].some((value) => !current.has(value));
      }).length;
    }

    lastId = items[items.length - 1]?.id;
    if (items.length < batchSize) {
      break;
    }
  }

  if (!dryRun && changedItems > 0) {
    const clusterIds = [...affectedClusterIds];
    for (let index = 0; index < clusterIds.length; index += 100) {
      await refreshClusterFeedStatsSafely(clusterIds.slice(index, index + 100), "backfill item entities");
    }
    invalidateFeedCache();
    invalidateEventBriefingCache();
    invalidateDailyReportCache();
  }

  return {
    scannedItems,
    changedItems,
    affectedClusterCount: affectedClusterIds.size,
    dryRun,
  };
}

export async function listAdminEntities(input?: {
  search?: string | null;
  page?: number | null;
  pageSize?: number | null;
  sort?: string | null;
}): Promise<AdminEntityList> {
  const page = normalizePage(input?.page);
  const pageSize = normalizePageSize(input?.pageSize);
  const search = input?.search?.trim() ?? "";
  const sort = normalizeAdminEntitySort(input?.sort);
  const where: Prisma.EntityWhereInput = search
    ? {
        OR: [
          { name: { contains: search } },
          { normalized: { contains: search.toLocaleLowerCase() } },
          { aliases: { some: { aliasName: { contains: search } } } },
          { aliases: { some: { aliasNormalized: { contains: search.toLocaleLowerCase() } } } },
        ],
      }
    : {};

  const [totalCount, entities] = await Promise.all([
    prisma.entity.count({ where }),
    prisma.entity.findMany({
      where,
      include: {
        aliases: {
          orderBy: [{ aliasName: "asc" }],
        },
        _count: {
          select: {
            items: true,
            aliases: true,
          },
        },
      },
      orderBy: getAdminEntityOrderBy(sort),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const serializedEntities = entities.map(serializeAdminEntity);
  return {
    entities: serializedEntities,
    totalCount,
    page,
    pageSize,
  };
}

function normalizeAdminEntitySort(value: string | null | undefined): AdminEntitySort {
  if (value === "updated_desc" || value === "name_asc" || value === "alias_desc") {
    return value;
  }
  return "usage_desc";
}

function getAdminEntityOrderBy(sort: AdminEntitySort): Prisma.EntityOrderByWithRelationInput[] {
  if (sort === "updated_desc") {
    return [{ updatedAt: "desc" }, { name: "asc" }];
  }
  if (sort === "name_asc") {
    return [{ name: "asc" }];
  }
  if (sort === "alias_desc") {
    return [{ aliases: { _count: "desc" } }, { name: "asc" }];
  }
  return [{ items: { _count: "desc" } }, { name: "asc" }];
}

function getBestEntitySimilarity(left: EntityCandidate, right: EntityCandidate) {
  const values = [
    calculateEntitySimilarity(left.name, right.name),
    calculateEntitySimilarity(left.normalized, right.normalized),
    ...((left.aliases ?? []).flatMap((leftAlias) => [
      calculateEntitySimilarity(leftAlias.aliasName, right.name),
      calculateEntitySimilarity(leftAlias.aliasNormalized, right.normalized),
    ])),
    ...((right.aliases ?? []).flatMap((rightAlias) => [
      calculateEntitySimilarity(left.name, rightAlias.aliasName),
      calculateEntitySimilarity(left.normalized, rightAlias.aliasNormalized),
    ])),
  ].filter((similarity): similarity is NonNullable<typeof similarity> => Boolean(similarity));

  return values.sort((leftSimilarity, rightSimilarity) => rightSimilarity.confidence - leftSimilarity.confidence)[0]
    ?? null;
}

function buildItemEntitySets(itemEntities: Array<{ itemId: string; entityId: string }>) {
  const itemIdsByEntityId = new Map<string, Set<string>>();

  for (const itemEntity of itemEntities) {
    const itemIds = itemIdsByEntityId.get(itemEntity.entityId) ?? new Set<string>();
    itemIds.add(itemEntity.itemId);
    itemIdsByEntityId.set(itemEntity.entityId, itemIds);
  }

  return itemIdsByEntityId;
}

function countSharedItems(left: Set<string> | undefined, right: Set<string> | undefined) {
  if (!left || !right) {
    return 0;
  }

  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  let count = 0;

  for (const itemId of smaller) {
    if (larger.has(itemId)) {
      count += 1;
    }
  }

  return count;
}

function buildSuppressedPairKey(sourceEntityNormalized: string, targetEntityNormalized: string) {
  return `${sourceEntityNormalized}\u0000${targetEntityNormalized}`;
}

async function loadSuppressedEntitySuggestionPairs() {
  const suppressedDecisions = await prisma.entitySuggestionDecision.findMany({
    select: {
      sourceEntityNormalized: true,
      targetEntityNormalized: true,
    },
  });

  return new Set(
    suppressedDecisions.map((decision) => buildSuppressedPairKey(
      decision.sourceEntityNormalized,
      decision.targetEntityNormalized,
    )),
  );
}

function buildEntitySuggestionSearchWhere(rawSearch: string, normalizedSearch: string): Prisma.EntityWhereInput {
  return {
    OR: [
      { name: { contains: rawSearch } },
      { normalized: { contains: normalizedSearch } },
      {
        aliases: {
          some: {
            OR: [
              { aliasName: { contains: rawSearch } },
              { aliasNormalized: { contains: normalizedSearch } },
            ],
          },
        },
      },
    ],
  };
}

function serializeEntitySuggestionCandidate(candidate: {
  id: string;
  confidence: number;
  reason: string;
  affectedItemCount: number;
  sharedItemCount: number;
  sourceEntity: EntityCandidate;
  targetEntity: EntityCandidate;
}): AdminEntitySuggestion {
  const reasons = [getSimilarityReasonLabel(candidate.reason as EntitySimilarityReason)];

  if (candidate.sharedItemCount > 0) {
    reasons.push(`同文共现 ${candidate.sharedItemCount} 条，需谨慎确认是否为同一实体`);
  }

  if (candidate.affectedItemCount <= 2) {
    reasons.push("来源实体使用量较低，适合优先治理");
  }

  return {
    id: candidate.id,
    sourceEntity: serializeEntitySummary(candidate.sourceEntity),
    targetEntity: serializeEntitySummary(candidate.targetEntity),
    confidence: candidate.confidence,
    reasons,
    affectedItemCount: candidate.affectedItemCount,
  };
}

async function deleteEntitySuggestionCandidatesForEntityIds(tx: PrismaTransaction, entityIds: string[]) {
  const uniqueEntityIds = [...new Set(entityIds.filter(Boolean))];

  if (uniqueEntityIds.length === 0) {
    return;
  }

  await tx.entitySuggestionCandidate.deleteMany({
    where: {
      OR: [
        { sourceEntityId: { in: uniqueEntityIds } },
        { targetEntityId: { in: uniqueEntityIds } },
      ],
    },
  });
}

async function loadEntitySuggestionPrecomputeInputs() {
  const entities: EntityCandidate[] = await prisma.entity.findMany({
    include: {
      aliases: {
        select: {
          aliasName: true,
          aliasNormalized: true,
        },
      },
      _count: {
        select: {
          items: true,
          aliases: true,
        },
      },
    },
  });

  return entities;
}

async function buildEntitySuggestionCandidateRecords(now: Date): Promise<{
  entities: EntityCandidate[];
  scannedPairs: number;
  records: EntitySuggestionCandidateRecord[];
}> {
  const entities = await loadEntitySuggestionPrecomputeInputs();
  const suppressedPairs = await loadSuppressedEntitySuggestionPairs();
  const suggestionDrafts: EntitySuggestionDraft[] = [];
  const seenPairs = new Set<string>();
  const pairs = buildEntitySuggestionCandidatePairs(entities, "");

  for (const { left, right } of pairs) {
    const similarity = getBestEntitySimilarity(left, right);
    if (!similarity || similarity.confidence < SUGGESTION_CONFIDENCE_THRESHOLD) {
      continue;
    }

    const { sourceEntity, targetEntity } = resolveSuggestionDirection(left, right);
    const pairKey = buildSuggestionId(sourceEntity, targetEntity);
    const suppressedPairKey = buildSuppressedPairKey(sourceEntity.normalized, targetEntity.normalized);

    if (seenPairs.has(pairKey) || suppressedPairs.has(suppressedPairKey)) {
      continue;
    }

    seenPairs.add(pairKey);
    suggestionDrafts.push({
      sourceEntity,
      targetEntity,
      baseConfidence: similarity.confidence,
      reason: similarity.reason,
    });
  }

  const entityIds = [...new Set(suggestionDrafts.flatMap((suggestion) => [
    suggestion.sourceEntity.id,
    suggestion.targetEntity.id,
  ]))];
  const itemEntities = entityIds.length > 0
    ? await prisma.itemEntity.findMany({
        where: {
          entityId: {
            in: entityIds,
          },
        },
        select: {
          itemId: true,
          entityId: true,
        },
      })
    : [];
  const itemIdsByEntityId = buildItemEntitySets(itemEntities);
  const expiresAt = new Date(now.getTime() + ENTITY_SUGGESTION_CANDIDATE_TTL_MS);
  const records = suggestionDrafts.map((suggestion) => {
    const sharedItemCount = countSharedItems(
      itemIdsByEntityId.get(suggestion.sourceEntity.id),
      itemIdsByEntityId.get(suggestion.targetEntity.id),
    );
    const confidence = getSuggestionConfidence(suggestion.baseConfidence);

    return {
      pairKey: buildSuggestionId(suggestion.sourceEntity, suggestion.targetEntity),
      sourceEntityId: suggestion.sourceEntity.id,
      targetEntityId: suggestion.targetEntity.id,
      sourceEntityNormalized: suggestion.sourceEntity.normalized,
      targetEntityNormalized: suggestion.targetEntity.normalized,
      confidence,
      affectedItemCount: suggestion.sourceEntity._count.items,
      sharedItemCount,
      reason: suggestion.reason,
      status: "active",
      expiresAt,
    };
  });

  return {
    entities,
    scannedPairs: pairs.length,
    records,
  };
}

export async function precomputeEntitySuggestionCandidates(now = new Date()): Promise<EntitySuggestionPrecomputeResult> {
  const startedAt = Date.now();
  const { entities, scannedPairs, records } = await buildEntitySuggestionCandidateRecords(now);

  await prisma.$transaction(async (tx) => {
    await tx.entitySuggestionCandidate.deleteMany({});

    for (let start = 0; start < records.length; start += ENTITY_SUGGESTION_CANDIDATE_CREATE_BATCH_SIZE) {
      await tx.entitySuggestionCandidate.createMany({
        data: records.slice(start, start + ENTITY_SUGGESTION_CANDIDATE_CREATE_BATCH_SIZE),
      });
    }
  });

  return {
    entityCount: entities.length,
    scannedPairs,
    candidateCount: records.length,
    storedCandidates: records.length,
    durationMs: Date.now() - startedAt,
  };
}

export async function listAdminEntitySuggestions(input?: {
  limit?: number | null;
  search?: string | null;
  page?: number | null;
  pageSize?: number | null;
  sort?: string | null;
  since?: Date | null;
}): Promise<AdminEntitySuggestionList> {
  const page = normalizePage(input?.page);
  const pageSize = normalizeSuggestionLimit(input?.pageSize ?? input?.limit);
  const sort = normalizeSuggestionSort(input?.sort);
  const rawSearch = input?.search?.trim() ?? "";
  const search = normalizeEntitySimilarityText(rawSearch);
  const entitySearchWhere = search ? buildEntitySuggestionSearchWhere(rawSearch, search) : null;
  const where: Prisma.EntitySuggestionCandidateWhereInput = {
    status: "active",
    reason: {
      not: "token_overlap",
    },
    ...(entitySearchWhere
      ? {
          OR: [
            { sourceEntity: { is: entitySearchWhere } },
            { targetEntity: { is: entitySearchWhere } },
          ],
        }
      : {}),
    ...(input?.since ? { updatedAt: { gte: input.since } } : {}),
  };
  const orderBy: Prisma.EntitySuggestionCandidateOrderByWithRelationInput[] = sort === "affected_desc"
    ? [
        { affectedItemCount: "desc" },
        { confidence: "desc" },
        { sourceEntityNormalized: "asc" },
      ]
    : [
        { confidence: "desc" },
        { affectedItemCount: "desc" },
        { sourceEntityNormalized: "asc" },
      ];
  const skip = (page - 1) * pageSize;
  const [totalCount, candidates] = await Promise.all([
    prisma.entitySuggestionCandidate.count({ where }),
    prisma.entitySuggestionCandidate.findMany({
      where,
      include: {
        sourceEntity: {
          include: {
            _count: {
              select: {
                items: true,
                aliases: true,
              },
            },
          },
        },
        targetEntity: {
          include: {
            _count: {
              select: {
                items: true,
                aliases: true,
              },
            },
          },
        },
      },
      orderBy,
      skip,
      take: pageSize,
    }),
  ]);

  return {
    suggestions: candidates.map(serializeEntitySuggestionCandidate),
    totalCount,
    page,
    pageSize,
  };
}

export async function autoMergeHighConfidenceEntitySuggestions(input?: {
  limit?: number | null;
}): Promise<AdminEntityAutoMergeResult> {
  const limit = normalizeSuggestionLimit(input?.limit ?? DEFAULT_AUTO_MERGE_SUGGESTION_LIMIT);
  // The candidate table can outlive the algorithm version that produced it.
  // Refresh before any automatic write so stale high-confidence rows cannot
  // bypass the current relationship and subset guards.
  await precomputeEntitySuggestionCandidates();
  const plans = await prisma.entitySuggestionCandidate.findMany({
    where: {
      status: "active",
      reason: {
        in: ["compact_match", "punctuation_match"],
      },
      confidence: {
        gte: AUTO_CANONICAL_CONFIDENCE_THRESHOLD,
      },
    },
    orderBy: [
      { confidence: "desc" },
      { affectedItemCount: "desc" },
      { sourceEntityNormalized: "asc" },
    ],
    take: limit,
    select: {
      sourceEntityId: true,
      targetEntityId: true,
    },
  });

  let mergedCount = 0;
  let affectedClusterCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const plan of plans) {
    const existingEntities = await prisma.entity.findMany({
      where: {
        id: {
          in: [plan.sourceEntityId, plan.targetEntityId],
        },
      },
      select: {
        id: true,
      },
    });

    if (existingEntities.length !== 2) {
      skippedCount += 1;
      continue;
    }

    try {
      const result = await mergeEntities({
        targetEntityId: plan.targetEntityId,
        sourceEntityIds: [plan.sourceEntityId],
        createdBy: "system:auto-merge",
      });
      mergedCount += result.mergedCount;
      affectedClusterCount += result.affectedClusterCount;
    } catch {
      failedCount += 1;
    }
  }

  return {
    scannedCount: plans.length,
    mergedCount,
    affectedClusterCount,
    skippedCount,
    failedCount,
  };
}

export async function dismissEntitySuggestion(input: {
  sourceEntityId: string;
  targetEntityId: string;
  decision: "ignored" | "kept";
  decidedBy?: string;
}) {
  if (input.sourceEntityId === input.targetEntityId) {
    throw new Error("来源实体和目标实体不能相同。");
  }

  const [sourceEntity, targetEntity] = await Promise.all([
    prisma.entity.findUnique({
      where: { id: input.sourceEntityId },
    }),
    prisma.entity.findUnique({
      where: { id: input.targetEntityId },
    }),
  ]);

  if (!sourceEntity || !targetEntity) {
    throw new Error("实体建议对应的实体不存在。");
  }

  await prisma.entitySuggestionDecision.upsert({
    where: {
      sourceEntityNormalized_targetEntityNormalized: {
        sourceEntityNormalized: sourceEntity.normalized,
        targetEntityNormalized: targetEntity.normalized,
      },
    },
    update: {
      decision: input.decision,
      decidedBy: input.decidedBy ?? "admin",
    },
    create: {
      sourceEntityNormalized: sourceEntity.normalized,
      targetEntityNormalized: targetEntity.normalized,
      decision: input.decision,
      decidedBy: input.decidedBy ?? "admin",
    },
  });
  await prisma.entitySuggestionCandidate.deleteMany({
    where: {
      sourceEntityNormalized: sourceEntity.normalized,
      targetEntityNormalized: targetEntity.normalized,
    },
  });

  return { ok: true };
}

async function upsertEntityAliasInTransaction(
  tx: PrismaTransaction,
  input: {
    entityId: string;
    aliasName: string;
    aliasNormalized: string;
    createdBy?: string;
    allowReassign?: boolean;
  },
) {
  const existing = await tx.entityAlias.findUnique({
    where: { aliasNormalized: input.aliasNormalized },
  });

  if (existing && existing.entityId !== input.entityId && !input.allowReassign) {
    throw new Error("该别名已指向其他实体。");
  }

  return tx.entityAlias.upsert({
    where: { aliasNormalized: input.aliasNormalized },
    update: {
      entityId: input.entityId,
      aliasName: input.aliasName,
      createdBy: input.createdBy ?? "admin",
    },
    create: {
      entityId: input.entityId,
      aliasName: input.aliasName,
      aliasNormalized: input.aliasNormalized,
      createdBy: input.createdBy ?? "admin",
    },
  });
}

export async function addEntityAlias(input: {
  entityId: string;
  aliasName: string;
  createdBy?: string;
}): Promise<AdminEntityAlias> {
  const alias = normalizeEntityName(input.aliasName);
  if (!alias) {
    throw new Error("别名不能为空、过长或属于泛词。");
  }

  const created = await prisma.$transaction(async (tx) => {
    const targetEntity = await tx.entity.findUnique({
      where: { id: input.entityId },
    });

    if (!targetEntity) {
      throw new Error("目标实体不存在。");
    }

    if (alias.normalized === targetEntity.normalized) {
      throw new Error("别名与规范实体相同，无需添加。");
    }

    const conflictingEntity = await tx.entity.findUnique({
      where: { normalized: alias.normalized },
    });

    if (conflictingEntity && conflictingEntity.id !== targetEntity.id) {
      throw new Error("该表达已是独立实体，请使用实体合并。");
    }

    return upsertEntityAliasInTransaction(tx, {
      entityId: targetEntity.id,
      aliasName: alias.name,
      aliasNormalized: alias.normalized,
      createdBy: input.createdBy,
    });
  });
  await prisma.entitySuggestionCandidate.deleteMany({
    where: {
      OR: [
        { sourceEntityId: input.entityId },
        { targetEntityId: input.entityId },
      ],
    },
  });

  return {
    id: created.id,
    aliasName: created.aliasName,
    aliasNormalized: created.aliasNormalized,
    createdBy: created.createdBy,
    createdAt: created.createdAt.toISOString(),
  };
}

export async function deleteEntityAlias(aliasId: string): Promise<void> {
  const deleted = await prisma.entityAlias.delete({
    where: { id: aliasId },
  });
  await prisma.entitySuggestionCandidate.deleteMany({
    where: {
      OR: [
        { sourceEntityId: deleted.entityId },
        { targetEntityId: deleted.entityId },
      ],
    },
  });
}

export async function mergeEntities(input: {
  targetEntityId: string;
  sourceEntityIds: string[];
  createdBy?: string;
}): Promise<{ mergedCount: number; affectedClusterCount: number }> {
  const sourceEntityIds = [...new Set(input.sourceEntityIds.map((id) => id.trim()).filter(Boolean))]
    .filter((id) => id !== input.targetEntityId);

  if (!input.targetEntityId.trim()) {
    throw new Error("请选择规范实体。");
  }

  if (sourceEntityIds.length === 0) {
    throw new Error("请选择至少一个需要合并的来源实体。");
  }

  const affectedClusterIds = await prisma.$transaction(async (tx) => {
    const targetEntity = await tx.entity.findUnique({
      where: { id: input.targetEntityId },
    });

    if (!targetEntity) {
      throw new Error("规范实体不存在。");
    }

    const sourceEntities = await tx.entity.findMany({
      where: { id: { in: sourceEntityIds } },
      include: { aliases: true },
    });

    if (sourceEntities.length !== sourceEntityIds.length) {
      throw new Error("部分来源实体不存在。");
    }

    const affectedItems = await tx.item.findMany({
      where: {
        entities: {
          some: {
            entityId: {
              in: sourceEntityIds,
            },
          },
        },
      },
      select: {
        clusterId: true,
      },
    });

    for (const sourceEntity of sourceEntities) {
      const aliasesToPreserve = [
        {
          aliasName: sourceEntity.name,
          aliasNormalized: sourceEntity.normalized,
        },
        ...sourceEntity.aliases.map((alias) => ({
          aliasName: alias.aliasName,
          aliasNormalized: alias.aliasNormalized,
        })),
      ].filter((alias) => alias.aliasNormalized !== targetEntity.normalized);

      for (const alias of aliasesToPreserve) {
        await upsertEntityAliasInTransaction(tx, {
          entityId: targetEntity.id,
          aliasName: alias.aliasName,
          aliasNormalized: alias.aliasNormalized,
          createdBy: input.createdBy,
          allowReassign: true,
        });
      }

      await tx.$executeRaw`
        DELETE FROM "item_entities"
        WHERE "entityId" = ${sourceEntity.id}
          AND EXISTS (
            SELECT 1
            FROM "item_entities" existing
            WHERE existing."itemId" = "item_entities"."itemId"
              AND existing."entityId" = ${targetEntity.id}
          )
      `;
      await tx.itemEntity.updateMany({
        where: { entityId: sourceEntity.id },
        data: { entityId: targetEntity.id },
      });
      await tx.entity.delete({
        where: { id: sourceEntity.id },
      });
    }
    await deleteEntitySuggestionCandidatesForEntityIds(tx, [targetEntity.id, ...sourceEntityIds]);

    return [...new Set(
      affectedItems
        .map((item) => item.clusterId)
        .filter((clusterId): clusterId is string => Boolean(clusterId)),
    )];
  });

  if (affectedClusterIds.length > 0) {
    await refreshClusterFeedStatsSafely(affectedClusterIds, "merge entities");
  }
  invalidateFeedCache();

  return {
    mergedCount: sourceEntityIds.length,
    affectedClusterCount: affectedClusterIds.length,
  };
}
