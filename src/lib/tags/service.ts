import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { refreshClusterFeedStatsSafely } from "@/lib/clusters/feed-stats";
import { invalidateFeedCache } from "@/lib/feed/cache";
import { normalizeItemTags, normalizeTagName, type NormalizedTag } from "@/lib/tags/normalization";
import {
  calculateTagSimilarity,
  compactTagSimilarityText,
  normalizeTagSimilarityText,
  sortedTagSimilarityTokenKey,
  tokenizeTagSimilarityText,
  type TagSimilarityReason,
} from "@/lib/tags/similarity";

type PrismaTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const DEFAULT_TAG_PAGE_SIZE = 30;
const MAX_TAG_PAGE_SIZE = 100;
const DEFAULT_TAG_SUGGESTION_LIMIT = 30;
const MAX_TAG_SUGGESTION_LIMIT = 100;
const AUTO_CANONICAL_CONFIDENCE_THRESHOLD = 0.98;
const DEFAULT_AUTO_MERGE_SUGGESTION_LIMIT = 100;
const SUGGESTION_CONFIDENCE_THRESHOLD = 0.82;
const DEFAULT_MIN_TAG_SUGGESTION_AFFECTED_COUNT = 3;
const TAG_SUGGESTION_CANDIDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TAG_SUGGESTION_CANDIDATE_CREATE_BATCH_SIZE = 500;
const MAX_TAG_SUGGESTION_CANDIDATE_PAIRS = 20_000;
const MAX_TAG_SUGGESTION_TOKEN_BUCKET_SIZE = 200;
const MAX_TAG_SUGGESTION_EDIT_BUCKET_SIZE = 80;

export type AdminTagAlias = {
  id: string;
  aliasName: string;
  aliasNormalized: string;
  createdBy: string;
  createdAt: string;
};

export type AdminTag = {
  id: string;
  name: string;
  normalized: string;
  itemCount: number;
  aliasCount: number;
  aliases: AdminTagAlias[];
  createdAt: string;
  updatedAt: string;
};

export type AdminTagList = {
  tags: AdminTag[];
  totalCount: number;
  page: number;
  pageSize: number;
};

export type AdminTagSort = "usage_desc" | "updated_desc" | "name_asc" | "alias_desc";

export type AdminTagSuggestion = {
  id: string;
  sourceTag: Pick<AdminTag, "id" | "name" | "normalized" | "itemCount" | "aliasCount">;
  targetTag: Pick<AdminTag, "id" | "name" | "normalized" | "itemCount" | "aliasCount">;
  confidence: number;
  reasons: string[];
  affectedItemCount: number;
};

export type AdminTagSuggestionList = {
  suggestions: AdminTagSuggestion[];
  totalCount: number;
  page: number;
  pageSize: number;
};

export type AdminTagSuggestionSort = "confidence_desc" | "affected_desc";

export type AdminTagAutoMergeResult = {
  scannedCount: number;
  mergedCount: number;
  affectedClusterCount: number;
  skippedCount: number;
  failedCount: number;
};

export type TagSuggestionPrecomputeResult = {
  tagCount: number;
  scannedPairs: number;
  candidateCount: number;
  storedCandidates: number;
  durationMs: number;
};

type TagCandidate = {
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

type TagSuggestionCandidatePair = {
  left: TagCandidate;
  right: TagCandidate;
};

type TagSuggestionDraft = {
  sourceTag: TagCandidate;
  targetTag: TagCandidate;
  baseConfidence: number;
  reason: TagSimilarityReason;
};

type TagSuggestionCandidateRecord = {
  pairKey: string;
  sourceTagId: string;
  targetTagId: string;
  sourceTagNormalized: string;
  targetTagNormalized: string;
  confidence: number;
  affectedItemCount: number;
  sharedItemCount: number;
  reason: TagSimilarityReason;
  status: string;
  expiresAt: Date;
};

function normalizePage(value: number | null | undefined) {
  return Number.isInteger(value) && value && value > 0 ? value : 1;
}

function normalizePageSize(value: number | null | undefined) {
  if (!Number.isInteger(value) || !value || value <= 0) {
    return DEFAULT_TAG_PAGE_SIZE;
  }

  return Math.min(value, MAX_TAG_PAGE_SIZE);
}

function serializeAdminTag(tag: {
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
}): AdminTag {
  return {
    id: tag.id,
    name: tag.name,
    normalized: tag.normalized,
    itemCount: tag._count.items,
    aliasCount: tag._count.aliases,
    aliases: tag.aliases.map((alias) => ({
      id: alias.id,
      aliasName: alias.aliasName,
      aliasNormalized: alias.aliasNormalized,
      createdBy: alias.createdBy,
      createdAt: alias.createdAt.toISOString(),
    })),
    createdAt: tag.createdAt.toISOString(),
    updatedAt: tag.updatedAt.toISOString(),
  };
}

function normalizeSuggestionLimit(value: number | null | undefined) {
  if (!Number.isInteger(value) || !value || value <= 0) {
    return DEFAULT_TAG_SUGGESTION_LIMIT;
  }

  return Math.min(value, MAX_TAG_SUGGESTION_LIMIT);
}

function normalizeSuggestionSort(value: string | null | undefined): AdminTagSuggestionSort {
  return value === "confidence_desc" ? "confidence_desc" : "affected_desc";
}

function serializeTagSummary(tag: TagCandidate): AdminTagSuggestion["sourceTag"] {
  return {
    id: tag.id,
    name: tag.name,
    normalized: tag.normalized,
    itemCount: tag._count.items,
    aliasCount: tag._count.aliases,
  };
}

function getSimilarityReasonLabel(reason: TagSimilarityReason) {
  switch (reason) {
    case "compact_match":
      return "空格差异，高置信重复";
    case "punctuation_match":
      return "标点差异，高置信重复";
    case "singular_match":
      return "英文单复数或词序差异";
    case "token_overlap":
      return "关键词高度重叠";
    case "edit_distance":
      return "拼写距离接近";
    default:
      return "标签表达接近";
  }
}

function compareCanonicalPreference(left: TagCandidate, right: TagCandidate) {
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

function resolveSuggestionDirection(left: TagCandidate, right: TagCandidate) {
  const [targetTag, sourceTag] = [left, right].sort(compareCanonicalPreference);

  return { sourceTag, targetTag };
}

function getComparableTagTexts(tag: TagCandidate) {
  return [
    tag.name,
    tag.normalized,
    ...((tag.aliases ?? []).flatMap((alias) => [alias.aliasName, alias.aliasNormalized])),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function tagMatchesSuggestionSearch(tag: TagCandidate, search: string) {
  if (!search) {
    return true;
  }

  return getComparableTagTexts(tag).some((value) => normalizeTagSimilarityText(value).includes(search));
}

function addTagToIndex(index: Map<string, TagCandidate[]>, key: string, tag: TagCandidate) {
  if (!key) {
    return;
  }

  const tags = index.get(key) ?? [];
  if (!tags.some((existingTag) => existingTag.id === tag.id)) {
    tags.push(tag);
    index.set(key, tags);
  }
}

function addCandidatePair(
  pairs: TagSuggestionCandidatePair[],
  seenPairIds: Set<string>,
  left: TagCandidate,
  right: TagCandidate,
  matchedTagIds: Set<string> | null,
) {
  if (left.id === right.id || pairs.length >= MAX_TAG_SUGGESTION_CANDIDATE_PAIRS) {
    return;
  }

  if (matchedTagIds && !matchedTagIds.has(left.id) && !matchedTagIds.has(right.id)) {
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
  pairs: TagSuggestionCandidatePair[],
  seenPairIds: Set<string>,
  bucket: TagCandidate[],
  matchedTagIds: Set<string> | null,
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

      addCandidatePair(pairs, seenPairIds, left, right, matchedTagIds);
      if (pairs.length >= MAX_TAG_SUGGESTION_CANDIDATE_PAIRS) {
        return;
      }
    }
  }
}

function buildTagSuggestionCandidatePairs(tags: TagCandidate[], search: string) {
  const exactIndexes = new Map<string, TagCandidate[]>();
  const tokenIndexes = new Map<string, TagCandidate[]>();
  const editIndexes = new Map<string, TagCandidate[]>();
  const matchedTagIds = search
    ? new Set(tags.filter((tag) => tagMatchesSuggestionSearch(tag, search)).map((tag) => tag.id))
    : null;

  if (matchedTagIds && matchedTagIds.size === 0) {
    return [];
  }

  for (const tag of tags) {
    for (const text of getComparableTagTexts(tag)) {
      const compact = compactTagSimilarityText(text);
      const sortedTokenKey = sortedTagSimilarityTokenKey(text);
      const tokens = tokenizeTagSimilarityText(text);

      addTagToIndex(exactIndexes, `compact:${compact}`, tag);
      addTagToIndex(exactIndexes, `sorted:${sortedTokenKey}`, tag);

      for (const token of tokens) {
        if (token.length >= 2) {
          addTagToIndex(tokenIndexes, `token:${token}`, tag);
        }
      }

      if (compact.length >= 5) {
        addTagToIndex(editIndexes, `edit:${compact.slice(0, 3)}:${Math.floor(compact.length / 2)}`, tag);
      }
    }
  }

  const pairs: TagSuggestionCandidatePair[] = [];
  const seenPairIds = new Set<string>();

  for (const bucket of exactIndexes.values()) {
    addPairsFromBucket(
      pairs,
      seenPairIds,
      bucket,
      matchedTagIds,
      Number.MAX_SAFE_INTEGER,
    );
  }

  for (const bucket of tokenIndexes.values()) {
    addPairsFromBucket(
      pairs,
      seenPairIds,
      bucket,
      matchedTagIds,
      MAX_TAG_SUGGESTION_TOKEN_BUCKET_SIZE,
    );
  }

  for (const bucket of editIndexes.values()) {
    addPairsFromBucket(
      pairs,
      seenPairIds,
      bucket,
      matchedTagIds,
      MAX_TAG_SUGGESTION_EDIT_BUCKET_SIZE,
    );
  }

  return pairs;
}

function buildSuggestionId(sourceTag: TagCandidate, targetTag: TagCandidate) {
  return `${sourceTag.id}:${targetTag.id}`;
}

function getSuggestionConfidence(
  sourceTag: TagCandidate,
  targetTag: TagCandidate,
  baseConfidence: number,
  sharedItemCount: number,
) {
  if (sourceTag._count.items === 0 || sharedItemCount === 0) {
    return baseConfidence;
  }

  const overlapRatio = sharedItemCount / sourceTag._count.items;
  const overlapBoost = overlapRatio >= 0.8 ? 0.04 : overlapRatio >= 0.5 ? 0.02 : 0;

  return Math.min(0.99, baseConfidence + overlapBoost);
}

type PreparedAutoCanonicalAlias = {
  targetNormalized: string;
  aliasName: string;
  aliasNormalized: string;
};

export type PreparedItemTagReplacement = {
  tags: NormalizedTag[];
  autoCanonicalAliases: PreparedAutoCanonicalAlias[];
};

export type PreparedItemTagAssignment = {
  itemId: string;
  replacement: PreparedItemTagReplacement;
};

function findBestCanonicalTag(tag: NormalizedTag, candidates: TagCandidate[]) {
  return candidates
    .map((candidate) => {
      const tagSimilarity = calculateTagSimilarity(tag.name, candidate.name)
        ?? calculateTagSimilarity(tag.normalized, candidate.normalized);
      const aliasSimilarity = candidate.aliases
        ?.map((alias) => calculateTagSimilarity(tag.name, alias.aliasName)
          ?? calculateTagSimilarity(tag.normalized, alias.aliasNormalized))
        .filter((similarity): similarity is NonNullable<typeof similarity> => Boolean(similarity))
        .sort((left, right) => right.confidence - left.confidence)[0];
      const similarity = [tagSimilarity, aliasSimilarity]
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
 * Resolve exact, alias, and fuzzy canonical tags before opening a write
 * transaction. Virtual candidates preserve the old sequential behavior where
 * later items in one aggregation batch can match tags introduced earlier in
 * the same batch.
 */
export async function prepareItemTagReplacements(
  tagsInputs: unknown[],
): Promise<PreparedItemTagReplacement[]> {
  const normalizedInputs = tagsInputs.map(normalizeItemTags);
  const normalizedKeys = Array.from(new Set(
    normalizedInputs.flatMap((tags) => tags.map((tag) => tag.normalized)),
  ));

  if (normalizedKeys.length === 0) {
    return normalizedInputs.map(() => ({ tags: [], autoCanonicalAliases: [] }));
  }

  const [aliases, exactTags] = await Promise.all([
    prisma.tagAlias.findMany({
      where: { aliasNormalized: { in: normalizedKeys } },
      include: { tag: true },
    }),
    prisma.tag.findMany({
      where: { normalized: { in: normalizedKeys } },
    }),
  ]);
  const aliasByNormalized = new Map(aliases.map((alias) => [alias.aliasNormalized, alias.tag]));
  const exactTagByNormalized = new Map(exactTags.map((tag) => [tag.normalized, tag]));
  const hasUnresolvedTags = normalizedKeys.some(
    (normalized) => !aliasByNormalized.has(normalized) && !exactTagByNormalized.has(normalized),
  );
  const fuzzyCandidates: TagCandidate[] = hasUnresolvedTags
    ? await prisma.tag.findMany({
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
  const resolvedTagByNormalized = new Map<string, NormalizedTag>();
  const autoAliasByNormalized = new Map<string, PreparedAutoCanonicalAlias>();
  let virtualCandidateIndex = 0;

  return normalizedInputs.map((tags) => {
    const seen = new Set<string>();
    const canonicalTags: NormalizedTag[] = [];
    const autoCanonicalAliases: PreparedAutoCanonicalAlias[] = [];

    for (const tag of tags) {
      let nextTag = resolvedTagByNormalized.get(tag.normalized);
      let autoAlias = autoAliasByNormalized.get(tag.normalized);

      if (!nextTag) {
        const canonicalTag = aliasByNormalized.get(tag.normalized);
        const exactTag = exactTagByNormalized.get(tag.normalized);
        nextTag = canonicalTag
          ? { name: canonicalTag.name, normalized: canonicalTag.normalized }
          : exactTag
            ? { name: exactTag.name, normalized: exactTag.normalized }
            : tag;

        if (!canonicalTag && !exactTag && fuzzyCandidates.length > 0) {
          const bestMatch = findBestCanonicalTag(tag, fuzzyCandidates);
          if (bestMatch && bestMatch.similarity.confidence >= AUTO_CANONICAL_CONFIDENCE_THRESHOLD) {
            nextTag = {
              name: bestMatch.candidate.name,
              normalized: bestMatch.candidate.normalized,
            };
            autoAlias = {
              targetNormalized: bestMatch.candidate.normalized,
              aliasName: tag.name,
              aliasNormalized: tag.normalized,
            };
            autoAliasByNormalized.set(tag.normalized, autoAlias);
          }
        }

        if (nextTag.normalized === tag.normalized && !candidateByNormalized.has(tag.normalized)) {
          const virtualCandidate: TagCandidate = {
            id: `batch:${virtualCandidateIndex}`,
            name: tag.name,
            normalized: tag.normalized,
            createdAt: new Date(virtualCandidateIndex),
            updatedAt: new Date(virtualCandidateIndex),
            aliases: [],
            _count: { items: 0, aliases: 0 },
          };
          virtualCandidateIndex += 1;
          fuzzyCandidates.push(virtualCandidate);
          candidateByNormalized.set(tag.normalized, virtualCandidate);
        }

        resolvedTagByNormalized.set(tag.normalized, nextTag);
      }

      if (autoAlias) {
        autoCanonicalAliases.push(autoAlias);
      }
      if (!seen.has(nextTag.normalized)) {
        seen.add(nextTag.normalized);
        canonicalTags.push(nextTag);
        const candidate = candidateByNormalized.get(nextTag.normalized);
        if (candidate) {
          candidate._count.items += 1;
        }
      }
    }

    return { tags: canonicalTags, autoCanonicalAliases };
  });
}

function setsAreEqual(left: Set<string>, right: Set<string>) {
  return left.size === right.size && Array.from(left).every((value) => right.has(value));
}

/**
 * Apply one or more prepared replacements with bounded transaction work:
 * canonical tag upserts, safe alias writes, one current-state read, and at
 * most one batched delete/create pair for changed item relations.
 */
export async function replacePreparedItemTagsInTransaction(
  tx: PrismaTransaction,
  assignments: PreparedItemTagAssignment[],
) {
  const replacementByItemId = new Map(
    assignments.map((assignment) => [assignment.itemId, assignment.replacement]),
  );
  const tagsByNormalized = new Map<string, NormalizedTag>();
  const aliasesByNormalized = new Map<string, PreparedAutoCanonicalAlias>();

  for (const replacement of replacementByItemId.values()) {
    for (const tag of replacement.tags) {
      tagsByNormalized.set(tag.normalized, tag);
    }
    for (const alias of replacement.autoCanonicalAliases) {
      aliasesByNormalized.set(alias.aliasNormalized, alias);
    }
  }

  const tagIdByNormalized = new Map<string, string>();
  for (const tag of tagsByNormalized.values()) {
    const storedTag = await tx.tag.upsert({
      where: { normalized: tag.normalized },
      update: { name: tag.name },
      create: tag,
    });
    tagIdByNormalized.set(storedTag.normalized, storedTag.id);
  }

  const aliasesToCheck = Array.from(aliasesByNormalized.values()).filter(
    (alias) => alias.aliasNormalized !== alias.targetNormalized,
  );
  if (aliasesToCheck.length > 0) {
    const aliasKeys = aliasesToCheck.map((alias) => alias.aliasNormalized);
    const existingAliases = await tx.tagAlias.findMany({
      where: { aliasNormalized: { in: aliasKeys } },
      select: { aliasNormalized: true },
    });
    const conflictingTags = await tx.tag.findMany({
      where: { normalized: { in: aliasKeys } },
      select: { normalized: true },
    });
    const blockedAliases = new Set([
      ...existingAliases.map((alias) => alias.aliasNormalized),
      ...conflictingTags.map((tag) => tag.normalized),
    ]);
    const aliasData = aliasesToCheck.flatMap((alias) => {
      const tagId = tagIdByNormalized.get(alias.targetNormalized);
      if (!tagId || blockedAliases.has(alias.aliasNormalized)) {
        return [];
      }

      return [{
        tagId,
        aliasName: alias.aliasName,
        aliasNormalized: alias.aliasNormalized,
        createdBy: "system:auto-canonical",
      }];
    });
    if (aliasData.length > 0) {
      await tx.tagAlias.createMany({ data: aliasData });
    }
  }

  const itemIds = Array.from(replacementByItemId.keys());
  if (itemIds.length === 0) {
    return 0;
  }
  const currentRelations = await tx.itemTag.findMany({
    where: { itemId: { in: itemIds } },
    select: { itemId: true, tagId: true },
  });
  const currentTagIdsByItemId = new Map<string, Set<string>>();
  for (const relation of currentRelations) {
    const tagIds = currentTagIdsByItemId.get(relation.itemId) ?? new Set<string>();
    tagIds.add(relation.tagId);
    currentTagIdsByItemId.set(relation.itemId, tagIds);
  }
  const desiredTagIdsByItemId = new Map<string, Set<string>>();
  for (const [itemId, replacement] of replacementByItemId) {
    desiredTagIdsByItemId.set(itemId, new Set(
      replacement.tags.flatMap((tag) => {
        const tagId = tagIdByNormalized.get(tag.normalized);
        return tagId ? [tagId] : [];
      }),
    ));
  }
  const changedItemIds = itemIds.filter((itemId) => !setsAreEqual(
    currentTagIdsByItemId.get(itemId) ?? new Set(),
    desiredTagIdsByItemId.get(itemId) ?? new Set(),
  ));

  if (changedItemIds.length === 0) {
    return 0;
  }

  await tx.itemTag.deleteMany({
    where: { itemId: { in: changedItemIds } },
  });
  const relationData = changedItemIds.flatMap((itemId) => Array.from(
    desiredTagIdsByItemId.get(itemId) ?? [],
    (tagId) => ({ itemId, tagId }),
  ));
  if (relationData.length > 0) {
    await tx.itemTag.createMany({ data: relationData });
  }

  return changedItemIds.length;
}

export async function replaceItemTags(itemId: string, tagsInput: unknown) {
  const [replacement] = await prepareItemTagReplacements([tagsInput]);
  await prisma.$transaction((tx) => replacePreparedItemTagsInTransaction(tx, [{
    itemId,
    replacement: replacement ?? { tags: [], autoCanonicalAliases: [] },
  }]));
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    select: { clusterId: true },
  });
  if (item?.clusterId) {
    await refreshClusterFeedStatsSafely([item.clusterId], "replace item tags");
  }
  invalidateFeedCache();
}

export async function listAdminTags(input?: {
  search?: string | null;
  page?: number | null;
  pageSize?: number | null;
  sort?: string | null;
}): Promise<AdminTagList> {
  const page = normalizePage(input?.page);
  const pageSize = normalizePageSize(input?.pageSize);
  const search = input?.search?.trim() ?? "";
  const sort = normalizeAdminTagSort(input?.sort);
  const where: Prisma.TagWhereInput = search
    ? {
        OR: [
          { name: { contains: search } },
          { normalized: { contains: search.toLocaleLowerCase() } },
          { aliases: { some: { aliasName: { contains: search } } } },
          { aliases: { some: { aliasNormalized: { contains: search.toLocaleLowerCase() } } } },
        ],
      }
    : {};

  const [totalCount, tags] = await Promise.all([
    prisma.tag.count({ where }),
    prisma.tag.findMany({
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
      orderBy: getAdminTagOrderBy(sort),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    tags: tags.map(serializeAdminTag),
    totalCount,
    page,
    pageSize,
  };
}

function normalizeAdminTagSort(value: string | null | undefined): AdminTagSort {
  if (value === "updated_desc" || value === "name_asc" || value === "alias_desc") {
    return value;
  }
  return "usage_desc";
}

function getAdminTagOrderBy(sort: AdminTagSort): Prisma.TagOrderByWithRelationInput[] {
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

function getBestTagSimilarity(left: TagCandidate, right: TagCandidate) {
  const values = [
    calculateTagSimilarity(left.name, right.name),
    calculateTagSimilarity(left.normalized, right.normalized),
    ...((left.aliases ?? []).flatMap((leftAlias) => [
      calculateTagSimilarity(leftAlias.aliasName, right.name),
      calculateTagSimilarity(leftAlias.aliasNormalized, right.normalized),
    ])),
    ...((right.aliases ?? []).flatMap((rightAlias) => [
      calculateTagSimilarity(left.name, rightAlias.aliasName),
      calculateTagSimilarity(left.normalized, rightAlias.aliasNormalized),
    ])),
  ].filter((similarity): similarity is NonNullable<typeof similarity> => Boolean(similarity));

  return values.sort((leftSimilarity, rightSimilarity) => rightSimilarity.confidence - leftSimilarity.confidence)[0]
    ?? null;
}

function buildItemTagSets(itemTags: Array<{ itemId: string; tagId: string }>) {
  const itemIdsByTagId = new Map<string, Set<string>>();

  for (const itemTag of itemTags) {
    const itemIds = itemIdsByTagId.get(itemTag.tagId) ?? new Set<string>();
    itemIds.add(itemTag.itemId);
    itemIdsByTagId.set(itemTag.tagId, itemIds);
  }

  return itemIdsByTagId;
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

function buildSuppressedPairKey(sourceTagNormalized: string, targetTagNormalized: string) {
  return `${sourceTagNormalized}\u0000${targetTagNormalized}`;
}

async function loadSuppressedTagSuggestionPairs() {
  const suppressedDecisions = await prisma.tagSuggestionDecision.findMany({
    select: {
      sourceTagNormalized: true,
      targetTagNormalized: true,
    },
  });

  return new Set(
    suppressedDecisions.map((decision) => buildSuppressedPairKey(
      decision.sourceTagNormalized,
      decision.targetTagNormalized,
    )),
  );
}

function buildTagSuggestionSearchWhere(rawSearch: string, normalizedSearch: string): Prisma.TagWhereInput {
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

function serializeTagSuggestionCandidate(candidate: {
  id: string;
  confidence: number;
  reason: string;
  affectedItemCount: number;
  sharedItemCount: number;
  sourceTag: TagCandidate;
  targetTag: TagCandidate;
}): AdminTagSuggestion {
  const reasons = [getSimilarityReasonLabel(candidate.reason as TagSimilarityReason)];

  if (candidate.sharedItemCount > 0) {
    reasons.push(`已有 ${candidate.sharedItemCount} 条内容同时带有两个标签`);
  }

  if (candidate.affectedItemCount <= 2) {
    reasons.push("来源标签使用量较低，适合优先治理");
  }

  return {
    id: candidate.id,
    sourceTag: serializeTagSummary(candidate.sourceTag),
    targetTag: serializeTagSummary(candidate.targetTag),
    confidence: candidate.confidence,
    reasons,
    affectedItemCount: candidate.affectedItemCount,
  };
}

async function deleteTagSuggestionCandidatesForTagIds(tx: PrismaTransaction, tagIds: string[]) {
  const uniqueTagIds = [...new Set(tagIds.filter(Boolean))];

  if (uniqueTagIds.length === 0) {
    return;
  }

  await tx.tagSuggestionCandidate.deleteMany({
    where: {
      OR: [
        { sourceTagId: { in: uniqueTagIds } },
        { targetTagId: { in: uniqueTagIds } },
      ],
    },
  });
}

async function loadTagSuggestionPrecomputeInputs() {
  const tags: TagCandidate[] = await prisma.tag.findMany({
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

  return tags;
}

async function buildTagSuggestionCandidateRecords(now: Date): Promise<{
  tags: TagCandidate[];
  scannedPairs: number;
  records: TagSuggestionCandidateRecord[];
}> {
  const tags = await loadTagSuggestionPrecomputeInputs();
  const suppressedPairs = await loadSuppressedTagSuggestionPairs();
  const suggestionDrafts: TagSuggestionDraft[] = [];
  const seenPairs = new Set<string>();
  const pairs = buildTagSuggestionCandidatePairs(tags, "");

  for (const { left, right } of pairs) {
    const similarity = getBestTagSimilarity(left, right);
    if (!similarity || similarity.confidence < SUGGESTION_CONFIDENCE_THRESHOLD) {
      continue;
    }

    const { sourceTag, targetTag } = resolveSuggestionDirection(left, right);
    const pairKey = buildSuggestionId(sourceTag, targetTag);
    const suppressedPairKey = buildSuppressedPairKey(sourceTag.normalized, targetTag.normalized);

    if (seenPairs.has(pairKey) || suppressedPairs.has(suppressedPairKey)) {
      continue;
    }

    seenPairs.add(pairKey);
    suggestionDrafts.push({
      sourceTag,
      targetTag,
      baseConfidence: similarity.confidence,
      reason: similarity.reason,
    });
  }

  const tagIds = [...new Set(suggestionDrafts.flatMap((suggestion) => [
    suggestion.sourceTag.id,
    suggestion.targetTag.id,
  ]))];
  const itemTags = tagIds.length > 0
    ? await prisma.itemTag.findMany({
        where: {
          tagId: {
            in: tagIds,
          },
        },
        select: {
          itemId: true,
          tagId: true,
        },
      })
    : [];
  const itemIdsByTagId = buildItemTagSets(itemTags);
  const expiresAt = new Date(now.getTime() + TAG_SUGGESTION_CANDIDATE_TTL_MS);
  const records = suggestionDrafts.map((suggestion) => {
    const sharedItemCount = countSharedItems(
      itemIdsByTagId.get(suggestion.sourceTag.id),
      itemIdsByTagId.get(suggestion.targetTag.id),
    );
    const confidence = getSuggestionConfidence(
      suggestion.sourceTag,
      suggestion.targetTag,
      suggestion.baseConfidence,
      sharedItemCount,
    );

    return {
      pairKey: buildSuggestionId(suggestion.sourceTag, suggestion.targetTag),
      sourceTagId: suggestion.sourceTag.id,
      targetTagId: suggestion.targetTag.id,
      sourceTagNormalized: suggestion.sourceTag.normalized,
      targetTagNormalized: suggestion.targetTag.normalized,
      confidence,
      affectedItemCount: suggestion.sourceTag._count.items,
      sharedItemCount,
      reason: suggestion.reason,
      status: "active",
      expiresAt,
    };
  });

  return {
    tags,
    scannedPairs: pairs.length,
    records,
  };
}

export async function precomputeTagSuggestionCandidates(now = new Date()): Promise<TagSuggestionPrecomputeResult> {
  const startedAt = Date.now();
  const { tags, scannedPairs, records } = await buildTagSuggestionCandidateRecords(now);

  await prisma.$transaction(async (tx) => {
    await tx.tagSuggestionCandidate.deleteMany({});

    for (let start = 0; start < records.length; start += TAG_SUGGESTION_CANDIDATE_CREATE_BATCH_SIZE) {
      await tx.tagSuggestionCandidate.createMany({
        data: records.slice(start, start + TAG_SUGGESTION_CANDIDATE_CREATE_BATCH_SIZE),
      });
    }
  });

  return {
    tagCount: tags.length,
    scannedPairs,
    candidateCount: records.length,
    storedCandidates: records.length,
    durationMs: Date.now() - startedAt,
  };
}

export async function listAdminTagSuggestions(input?: {
  limit?: number | null;
  search?: string | null;
  page?: number | null;
  pageSize?: number | null;
  sort?: string | null;
  since?: Date | null;
}): Promise<AdminTagSuggestionList> {
  const page = normalizePage(input?.page);
  const pageSize = normalizeSuggestionLimit(input?.pageSize ?? input?.limit);
  const sort = normalizeSuggestionSort(input?.sort);
  const rawSearch = input?.search?.trim() ?? "";
  const search = normalizeTagSimilarityText(rawSearch);
  const tagSearchWhere = search ? buildTagSuggestionSearchWhere(rawSearch, search) : null;
  const where: Prisma.TagSuggestionCandidateWhereInput = {
    status: "active",
    ...(!tagSearchWhere
      ? {
          affectedItemCount: {
            gte: DEFAULT_MIN_TAG_SUGGESTION_AFFECTED_COUNT,
          },
        }
      : {}),
    ...(tagSearchWhere
      ? {
          OR: [
            { sourceTag: { is: tagSearchWhere } },
            { targetTag: { is: tagSearchWhere } },
          ],
        }
      : {}),
    ...(input?.since ? { updatedAt: { gte: input.since } } : {}),
  };
  const orderBy: Prisma.TagSuggestionCandidateOrderByWithRelationInput[] = sort === "affected_desc"
    ? [
        { affectedItemCount: "desc" },
        { confidence: "desc" },
        { sourceTagNormalized: "asc" },
      ]
    : [
        { confidence: "desc" },
        { affectedItemCount: "desc" },
        { sourceTagNormalized: "asc" },
      ];
  const skip = (page - 1) * pageSize;
  const [totalCount, candidates] = await Promise.all([
    prisma.tagSuggestionCandidate.count({ where }),
    prisma.tagSuggestionCandidate.findMany({
      where,
      include: {
        sourceTag: {
          include: {
            _count: {
              select: {
                items: true,
                aliases: true,
              },
            },
          },
        },
        targetTag: {
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
    suggestions: candidates.map(serializeTagSuggestionCandidate),
    totalCount,
    page,
    pageSize,
  };
}

export async function autoMergeHighConfidenceTagSuggestions(input?: {
  limit?: number | null;
}): Promise<AdminTagAutoMergeResult> {
  const limit = normalizeSuggestionLimit(input?.limit ?? DEFAULT_AUTO_MERGE_SUGGESTION_LIMIT);
  const activeCandidateCount = await prisma.tagSuggestionCandidate.count({
    where: { status: "active" },
  });

  if (activeCandidateCount === 0) {
    await precomputeTagSuggestionCandidates();
  }
  const plans = await prisma.tagSuggestionCandidate.findMany({
    where: {
      status: "active",
      confidence: {
        gte: AUTO_CANONICAL_CONFIDENCE_THRESHOLD,
      },
    },
    orderBy: [
      { confidence: "desc" },
      { affectedItemCount: "desc" },
      { sourceTagNormalized: "asc" },
    ],
    take: limit,
    select: {
      sourceTagId: true,
      targetTagId: true,
    },
  });

  let mergedCount = 0;
  let affectedClusterCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const plan of plans) {
    const existingTags = await prisma.tag.findMany({
      where: {
        id: {
          in: [plan.sourceTagId, plan.targetTagId],
        },
      },
      select: {
        id: true,
      },
    });

    if (existingTags.length !== 2) {
      skippedCount += 1;
      continue;
    }

    try {
      const result = await mergeTags({
        targetTagId: plan.targetTagId,
        sourceTagIds: [plan.sourceTagId],
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

export async function dismissTagSuggestion(input: {
  sourceTagId: string;
  targetTagId: string;
  decision: "ignored" | "kept";
  decidedBy?: string;
}) {
  if (input.sourceTagId === input.targetTagId) {
    throw new Error("来源标签和目标标签不能相同。");
  }

  const [sourceTag, targetTag] = await Promise.all([
    prisma.tag.findUnique({
      where: { id: input.sourceTagId },
    }),
    prisma.tag.findUnique({
      where: { id: input.targetTagId },
    }),
  ]);

  if (!sourceTag || !targetTag) {
    throw new Error("标签建议对应的标签不存在。");
  }

  await prisma.tagSuggestionDecision.upsert({
    where: {
      sourceTagNormalized_targetTagNormalized: {
        sourceTagNormalized: sourceTag.normalized,
        targetTagNormalized: targetTag.normalized,
      },
    },
    update: {
      decision: input.decision,
      decidedBy: input.decidedBy ?? "admin",
    },
    create: {
      sourceTagNormalized: sourceTag.normalized,
      targetTagNormalized: targetTag.normalized,
      decision: input.decision,
      decidedBy: input.decidedBy ?? "admin",
    },
  });
  await prisma.tagSuggestionCandidate.deleteMany({
    where: {
      sourceTagNormalized: sourceTag.normalized,
      targetTagNormalized: targetTag.normalized,
    },
  });

  return { ok: true };
}

async function upsertTagAliasInTransaction(
  tx: PrismaTransaction,
  input: {
    tagId: string;
    aliasName: string;
    aliasNormalized: string;
    createdBy?: string;
    allowReassign?: boolean;
  },
) {
  const existing = await tx.tagAlias.findUnique({
    where: { aliasNormalized: input.aliasNormalized },
  });

  if (existing && existing.tagId !== input.tagId && !input.allowReassign) {
    throw new Error("该别名已指向其他标签。");
  }

  return tx.tagAlias.upsert({
    where: { aliasNormalized: input.aliasNormalized },
    update: {
      tagId: input.tagId,
      aliasName: input.aliasName,
      createdBy: input.createdBy ?? "admin",
    },
    create: {
      tagId: input.tagId,
      aliasName: input.aliasName,
      aliasNormalized: input.aliasNormalized,
      createdBy: input.createdBy ?? "admin",
    },
  });
}

export async function addTagAlias(input: {
  tagId: string;
  aliasName: string;
  createdBy?: string;
}): Promise<AdminTagAlias> {
  const alias = normalizeTagName(input.aliasName);
  if (!alias) {
    throw new Error("别名不能为空、过长或属于泛词。");
  }

  const created = await prisma.$transaction(async (tx) => {
    const targetTag = await tx.tag.findUnique({
      where: { id: input.tagId },
    });

    if (!targetTag) {
      throw new Error("目标标签不存在。");
    }

    if (alias.normalized === targetTag.normalized) {
      throw new Error("别名与规范标签相同，无需添加。");
    }

    const conflictingTag = await tx.tag.findUnique({
      where: { normalized: alias.normalized },
    });

    if (conflictingTag && conflictingTag.id !== targetTag.id) {
      throw new Error("该表达已是独立标签，请使用标签合并。");
    }

    return upsertTagAliasInTransaction(tx, {
      tagId: targetTag.id,
      aliasName: alias.name,
      aliasNormalized: alias.normalized,
      createdBy: input.createdBy,
    });
  });
  await prisma.tagSuggestionCandidate.deleteMany({
    where: {
      OR: [
        { sourceTagId: input.tagId },
        { targetTagId: input.tagId },
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

export async function deleteTagAlias(aliasId: string): Promise<void> {
  const deleted = await prisma.tagAlias.delete({
    where: { id: aliasId },
  });
  await prisma.tagSuggestionCandidate.deleteMany({
    where: {
      OR: [
        { sourceTagId: deleted.tagId },
        { targetTagId: deleted.tagId },
      ],
    },
  });
}

export async function mergeTags(input: {
  targetTagId: string;
  sourceTagIds: string[];
  createdBy?: string;
}): Promise<{ mergedCount: number; affectedClusterCount: number }> {
  const sourceTagIds = [...new Set(input.sourceTagIds.map((id) => id.trim()).filter(Boolean))]
    .filter((id) => id !== input.targetTagId);

  if (!input.targetTagId.trim()) {
    throw new Error("请选择规范标签。");
  }

  if (sourceTagIds.length === 0) {
    throw new Error("请选择至少一个需要合并的来源标签。");
  }

  const affectedClusterIds = await prisma.$transaction(async (tx) => {
    const targetTag = await tx.tag.findUnique({
      where: { id: input.targetTagId },
    });

    if (!targetTag) {
      throw new Error("规范标签不存在。");
    }

    const sourceTags = await tx.tag.findMany({
      where: { id: { in: sourceTagIds } },
      include: { aliases: true },
    });

    if (sourceTags.length !== sourceTagIds.length) {
      throw new Error("部分来源标签不存在。");
    }

    const affectedItems = await tx.item.findMany({
      where: {
        tags: {
          some: {
            tagId: {
              in: sourceTagIds,
            },
          },
        },
      },
      select: {
        clusterId: true,
      },
    });

    for (const sourceTag of sourceTags) {
      const aliasesToPreserve = [
        {
          aliasName: sourceTag.name,
          aliasNormalized: sourceTag.normalized,
        },
        ...sourceTag.aliases.map((alias) => ({
          aliasName: alias.aliasName,
          aliasNormalized: alias.aliasNormalized,
        })),
      ].filter((alias) => alias.aliasNormalized !== targetTag.normalized);

      for (const alias of aliasesToPreserve) {
        await upsertTagAliasInTransaction(tx, {
          tagId: targetTag.id,
          aliasName: alias.aliasName,
          aliasNormalized: alias.aliasNormalized,
          createdBy: input.createdBy,
          allowReassign: true,
        });
      }

      await tx.$executeRaw`
        DELETE FROM "item_tags"
        WHERE "tagId" = ${sourceTag.id}
          AND EXISTS (
            SELECT 1
            FROM "item_tags" existing
            WHERE existing."itemId" = "item_tags"."itemId"
              AND existing."tagId" = ${targetTag.id}
          )
      `;
      await tx.itemTag.updateMany({
        where: { tagId: sourceTag.id },
        data: { tagId: targetTag.id },
      });
      await tx.tag.delete({
        where: { id: sourceTag.id },
      });
    }
    await deleteTagSuggestionCandidatesForTagIds(tx, [targetTag.id, ...sourceTagIds]);

    return [...new Set(
      affectedItems
        .map((item) => item.clusterId)
        .filter((clusterId): clusterId is string => Boolean(clusterId)),
    )];
  });

  if (affectedClusterIds.length > 0) {
    await refreshClusterFeedStatsSafely(affectedClusterIds, "merge tags");
  }
  invalidateFeedCache();

  return {
    mergedCount: sourceTagIds.length,
    affectedClusterCount: affectedClusterIds.length,
  };
}
