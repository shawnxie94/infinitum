export type Bm25ClusterDocument = {
  id: string;
  title: string;
  summary: string;
  eventSubject: string | null;
  eventObject: string | null;
};

type IndexedDocument = {
  tokens: ReadonlySet<string>;
  length: number;
};

export type ClusterMergeBm25Index = {
  documents: ReadonlyMap<string, IndexedDocument>;
  documentFrequency: ReadonlyMap<string, number>;
  docCount: number;
  averageDocumentLength: number;
};

export const CLUSTER_MERGE_BM25_CACHE_VERSION = "bm25-v1";

export const CLUSTER_MERGE_BM25_SCORE_SCALE = 100_000;

const BM25_K1 = 1.2;
const BM25_B = 0.75;

function tokenizeMergeText(value: string | null | undefined): Set<string> {
  const normalized = (value ?? "").trim().toLowerCase();
  const words = normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? [];
  const tokens = new Set<string>();

  for (const word of words) {
    if (/^[\u4e00-\u9fff]+$/u.test(word)) {
      if (word.length <= 2) {
        tokens.add(word);
        continue;
      }

      for (let index = 0; index < word.length - 1; index += 1) {
        tokens.add(word.slice(index, index + 2));
      }
      continue;
    }

    if (word.length >= 2) {
      tokens.add(word);
    }
  }

  return tokens;
}

function tokenizeDocument(document: Bm25ClusterDocument) {
  return tokenizeMergeText([
    document.title,
    document.summary,
    document.eventSubject,
    document.eventObject,
  ].filter(Boolean).join(" "));
}

export function buildClusterMergeBm25Index(
  clusters: readonly Bm25ClusterDocument[],
): ClusterMergeBm25Index {
  const documents = new Map<string, IndexedDocument>();
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;

  for (const cluster of clusters) {
    const tokens = tokenizeDocument(cluster);
    const length = tokens.size;
    documents.set(cluster.id, { tokens, length });
    totalLength += length;

    for (const token of tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  return {
    documents,
    documentFrequency,
    docCount: documents.size,
    averageDocumentLength: documents.size === 0 ? 0 : totalLength / documents.size,
  };
}

function scoreDocument(
  index: ClusterMergeBm25Index,
  queryTokens: ReadonlySet<string>,
  document: IndexedDocument,
): number {
  if (document.length === 0 || index.averageDocumentLength === 0) {
    return 0;
  }

  let score = 0;
  for (const token of queryTokens) {
    if (!document.tokens.has(token)) {
      continue;
    }

    const frequency = index.documentFrequency.get(token) ?? 0;
    const inverseFrequency = Math.log(
      (index.docCount - frequency + 0.5) / (frequency + 0.5) + 1,
    );
    const denominator = 1 + BM25_K1 * (
      1 - BM25_B + BM25_B * (document.length / index.averageDocumentLength)
    );
    score += inverseFrequency * ((BM25_K1 + 1) / denominator);
  }

  return score;
}

function scoreDocumentPair(
  index: ClusterMergeBm25Index,
  left: IndexedDocument,
  right: IndexedDocument,
): number {
  // Fixed-point score keeps sub-unit BM25 values sortable in the existing Int cache column.
  return Math.round((
    scoreDocument(index, left.tokens, right) + scoreDocument(index, right.tokens, left)
  ) / 2 * CLUSTER_MERGE_BM25_SCORE_SCALE);
}

/** Symmetric mean of both directed BM25 scores; each document uses binary term frequency. */
export function scoreClusterMergeBm25Pair(
  index: ClusterMergeBm25Index,
  leftId: string,
  rightId: string,
): number {
  const left = index.documents.get(leftId);
  const right = index.documents.get(rightId);
  return left && right ? scoreDocumentPair(index, left, right) : 0;
}

/** Offline pair scorer uses the production corpus statistics with externally supplied pair documents. */
export function scoreClusterMergeBm25Documents(
  index: ClusterMergeBm25Index,
  left: Bm25ClusterDocument,
  right: Bm25ClusterDocument,
): number {
  const leftTokens = tokenizeDocument(left);
  const rightTokens = tokenizeDocument(right);
  return scoreDocumentPair(
    index,
    { tokens: leftTokens, length: leftTokens.size },
    { tokens: rightTokens, length: rightTokens.size },
  );
}
