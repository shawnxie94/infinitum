export type EntitySimilarityReason =
  | "compact_match"
  | "singular_match"
  | "punctuation_match"
  | "token_overlap"
  | "edit_distance";

export type EntitySimilarityResult = {
  confidence: number;
  reason: EntitySimilarityReason;
};

export function normalizeEntitySimilarityText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function normalizeToken(value: string) {
  const normalized = normalizeEntitySimilarityText(value);

  if (normalized.endsWith("ies") && normalized.length > 4) {
    return `${normalized.slice(0, -3)}y`;
  }

  if (
    normalized.endsWith("s") &&
    normalized.length > 3 &&
    !normalized.endsWith("ss") &&
    !normalized.endsWith("us")
  ) {
    return normalized.slice(0, -1);
  }

  return normalized;
}

export function tokenizeEntitySimilarityText(value: string) {
  return normalizeEntitySimilarityText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalizeToken)
    .filter(Boolean);
}

export function compactEntitySimilarityText(value: string) {
  return tokenizeEntitySimilarityText(value).join("");
}

export function sortedEntitySimilarityTokenKey(value: string) {
  return tokenizeEntitySimilarityText(value).sort().join(" ");
}

function levenshteinDistance(left: string, right: string) {
  if (left === right) {
    return 0;
  }

  if (!left) {
    return right.length;
  }

  if (!right) {
    return left.length;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }

    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index] ?? 0;
    }
  }

  return previous[right.length] ?? 0;
}

function editSimilarity(left: string, right: string) {
  const maxLength = Math.max(left.length, right.length);

  if (maxLength === 0) {
    return 1;
  }

  return 1 - levenshteinDistance(left, right) / maxLength;
}

function containsRelationshipMarker(value: string) {
  return /[、/&|]|(?:^|[\s([{（【])(?:与|和|及|以及)(?=$|[\s)\]}）】])|[\p{L}\p{N}](?:与|和|及|以及)[\p{L}\p{N}]|(?:^|\s)(?:vs|versus)(?=$|\s)/iu.test(value);
}

export function calculateEntitySimilarity(left: string, right: string): EntitySimilarityResult | null {
  const normalizedLeft = normalizeEntitySimilarityText(left);
  const normalizedRight = normalizeEntitySimilarityText(right);

  if (!normalizedLeft || !normalizedRight || normalizedLeft === normalizedRight) {
    return null;
  }

  const leftTokens = tokenizeEntitySimilarityText(normalizedLeft);
  const rightTokens = tokenizeEntitySimilarityText(normalizedRight);
  const leftCompact = leftTokens.join("");
  const rightCompact = rightTokens.join("");

  if (!leftCompact || !rightCompact) {
    return null;
  }

  // Relationship phrases such as "ChatGPT 与 Gemini" and
  // "Mark Zuckerberg / Meta" are not entity aliases, even when their
  // normalized tokens are identical after reordering.
  if (containsRelationshipMarker(normalizedLeft) || containsRelationshipMarker(normalizedRight)) {
    return null;
  }

  if (leftCompact === rightCompact) {
    return {
      confidence: 0.99,
      reason: normalizedLeft.replace(/\s+/g, "") === normalizedRight.replace(/\s+/g, "")
        ? "punctuation_match"
        : "compact_match",
    };
  }

  if (sortedEntitySimilarityTokenKey(normalizedLeft) === sortedEntitySimilarityTokenKey(normalizedRight)) {
    return {
      confidence: 0.96,
      reason: "singular_match",
    };
  }

  const editScore = editSimilarity(compactEntitySimilarityText(normalizedLeft), compactEntitySimilarityText(normalizedRight));
  if (editScore >= 0.82 && Math.max(leftCompact.length, rightCompact.length) >= 5) {
    return {
      confidence: Math.min(0.94, Math.max(0.82, editScore)),
      reason: "edit_distance",
    };
  }

  return null;
}
