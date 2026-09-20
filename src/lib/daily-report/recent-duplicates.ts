

import { type AiEventSignature } from "@/lib/ai/provider";
import { type RecentDailyReportSourceSnapshot } from "@/lib/daily-report/repository";
import { type DailyReportCandidate } from "@/lib/daily-report/types";
import { normalizeEventSignatureForStorage } from "@/lib/clusters/normalization";
import { buildDailyReportSourceKey, compactDailyReportCandidates, normalizeLegacyParsedSourceKey } from "@/lib/daily-report/candidates";


export function normalizeOptionalDailyReportText(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

export function normalizeDailyReportComparableText(value: string | null | undefined) {
  return value
    ?.normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s·・,，.。:：;；'"“”‘’()[\]（）【】{}<>《》_\-—–/\\|]+/g, "") || null;
}

export function buildCharacterBigrams(value: string) {
  if (value.length <= 1) return new Set([value]);
  const grams = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.add(value.slice(index, index + 2));
  }
  return grams;
}

export function calculateDailyReportTitleSimilarity(left: string, right: string) {
  const normalizedLeft = normalizeDailyReportComparableText(left);
  const normalizedRight = normalizeDailyReportComparableText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return 1;
  }

  const leftGrams = buildCharacterBigrams(normalizedLeft);
  const rightGrams = buildCharacterBigrams(normalizedRight);
  const intersectionSize = [...leftGrams].filter((gram) => rightGrams.has(gram)).length;
  const unionSize = new Set([...leftGrams, ...rightGrams]).size;
  return unionSize > 0 ? intersectionSize / unionSize : 0;
}

export function isDailyReportFollowUpTitle(title: string) {
  return /后续|新进展|进展|更新|恢复|解除|回归|重新|修复|回应|澄清|正式/.test(title);
}

export function getDailyReportEventIdentity(input: {
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
}) {
  const normalized = normalizeEventSignatureForStorage({
    eventType: input.eventType as AiEventSignature["eventType"],
    eventSubject: input.eventSubject,
    eventAction: input.eventAction,
    eventObject: input.eventObject,
    eventDate: input.eventDate,
  });

  return {
    eventType: normalizeOptionalDailyReportText(normalized?.eventType),
    eventSubject: normalizeOptionalDailyReportText(normalized?.eventSubject),
    eventAction: normalizeOptionalDailyReportText(normalized?.eventAction),
    eventObject: normalizeOptionalDailyReportText(normalized?.eventObject),
    eventDate: normalizeOptionalDailyReportText(normalized?.eventDate),
  };
}

export function matchesRecentDailyReportEvent(
  candidate: DailyReportCandidate,
  recentSource: RecentDailyReportSourceSnapshot,
) {
  const candidateEvent = getDailyReportEventIdentity(candidate);
  const recentEvent = getDailyReportEventIdentity(recentSource);

  if (
    !candidateEvent.eventSubject ||
    !candidateEvent.eventObject ||
    candidateEvent.eventSubject !== recentEvent.eventSubject ||
    candidateEvent.eventObject !== recentEvent.eventObject
  ) {
    return false;
  }

  if (
    candidateEvent.eventDate &&
    recentEvent.eventDate &&
    candidateEvent.eventDate !== recentEvent.eventDate
  ) {
    return false;
  }

  if (candidateEvent.eventAction && recentEvent.eventAction) {
    return candidateEvent.eventAction === recentEvent.eventAction;
  }

  return Boolean(
    candidateEvent.eventType &&
      recentEvent.eventType &&
      candidateEvent.eventType === recentEvent.eventType,
  );
}

export function hasSimilarDailyReportEventCore(
  candidate: DailyReportCandidate,
  recentSource: RecentDailyReportSourceSnapshot,
) {
  const candidateSubject = normalizeDailyReportComparableText(candidate.eventSubject);
  const recentSubject = normalizeDailyReportComparableText(recentSource.eventSubject);
  const candidateObject = normalizeDailyReportComparableText(candidate.eventObject);
  const recentObject = normalizeDailyReportComparableText(recentSource.eventObject);
  const titleSimilarity = calculateDailyReportTitleSimilarity(candidate.title, recentSource.title);

  if (candidateSubject && recentSubject && candidateSubject === recentSubject) {
    if (candidateObject && recentObject) {
      return (
        candidateObject === recentObject ||
        candidateObject.includes(recentObject) ||
        recentObject.includes(candidateObject) ||
        titleSimilarity >= 0.52
      );
    }

    return titleSimilarity >= 0.68;
  }

  if (candidateObject && recentObject) {
    return (
      (candidateObject === recentObject ||
        candidateObject.includes(recentObject) ||
        recentObject.includes(candidateObject)) &&
      titleSimilarity >= 0.5
    );
  }

  return titleSimilarity >= 0.72;
}

export function matchesRecentDailyReportSoftDuplicate(
  candidate: DailyReportCandidate,
  recentSource: RecentDailyReportSourceSnapshot,
) {
  if (!hasSimilarDailyReportEventCore(candidate, recentSource)) {
    return false;
  }

  const candidateEvent = getDailyReportEventIdentity(candidate);
  const recentEvent = getDailyReportEventIdentity(recentSource);
  const sameAction = Boolean(
    candidateEvent.eventAction &&
      recentEvent.eventAction &&
      candidateEvent.eventAction === recentEvent.eventAction,
  );
  const sameDate = Boolean(
    candidateEvent.eventDate &&
      recentEvent.eventDate &&
      candidateEvent.eventDate === recentEvent.eventDate,
  );
  const missingDate = !candidateEvent.eventDate || !recentEvent.eventDate;
  const titleSimilarity = calculateDailyReportTitleSimilarity(candidate.title, recentSource.title);

  if (isDailyReportFollowUpTitle(candidate.title) && (!sameDate || !sameAction)) {
    return false;
  }

  return sameAction || sameDate || missingDate || titleSimilarity >= 0.62;
}

export function matchesRecentDailyReportSource(
  candidate: DailyReportCandidate,
  recentSource: RecentDailyReportSourceSnapshot,
) {
  const sameCluster = Boolean(candidate.clusterId && recentSource.clusterId && candidate.clusterId === recentSource.clusterId);
  const isMeaningfulFollowUp = Boolean(
    sameCluster &&
      candidate.isFollowUp &&
      ((candidate.newItemCountOnDate ?? 0) > 0 || (candidate.newSourceCountOnDate ?? 0) > 0),
  );

  if (isMeaningfulFollowUp) {
    return false;
  }

  const candidateSourceKey = buildDailyReportSourceKey(candidate);
  const recentSourceKey = normalizeLegacyParsedSourceKey(recentSource.sourceKey) ?? buildDailyReportSourceKey(recentSource);
  const hasSameItemSourceKey = Boolean(
    candidate.itemId &&
      recentSource.itemId &&
      candidate.itemId === recentSource.itemId &&
      candidateSourceKey === `item:${candidate.itemId}` &&
      (!recentSource.sourceKey || recentSourceKey === `item:${recentSource.itemId}`),
  );

  return Boolean(
    (recentSourceKey && candidateSourceKey === recentSourceKey) ||
      hasSameItemSourceKey ||
      sameCluster ||
      matchesRecentDailyReportEvent(candidate, recentSource) ||
      matchesRecentDailyReportSoftDuplicate(candidate, recentSource),
  );
}

export function filterRecentDailyReportDuplicates(
  candidates: DailyReportCandidate[],
  recentSources: RecentDailyReportSourceSnapshot[],
  limit = candidates.length,
) {
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : candidates.length;

  if (recentSources.length === 0) {
    return compactDailyReportCandidates(candidates.slice(0, normalizedLimit));
  }

  return compactDailyReportCandidates(candidates.filter(
    (candidate) => !recentSources.some((recentSource) => matchesRecentDailyReportSource(candidate, recentSource)),
  ).slice(0, normalizedLimit));
}

