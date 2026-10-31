import { createHash } from "node:crypto";
import type { Item, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { invalidateFeedCache } from "@/lib/feed/cache";
import { buildDedupeKeys } from "@/lib/ingestion/dedupe";
import { AdapterError, type AdapterItem } from "@/lib/adapter/client";

type FingerprintItem = { summaryText: string | null; translatedTitle: string | null; qualityScore: number; qualityRationale: string; eventType: string | null; eventTypeRaw: string | null; eventSubject: string | null; eventAction: string | null; eventObject: string | null; eventDate: string | null };
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function analysisFingerprint(item: FingerprintItem) {
  return hash([item.summaryText, item.translatedTitle, item.qualityScore, item.qualityRationale, item.eventType, item.eventTypeRaw, item.eventSubject, item.eventAction, item.eventObject, item.eventDate]);
}
export function adapterContentHash(item: AdapterItem) {
  return hash([item.title, item.url, item.author ?? null, item.publishedAt ?? null, item.summary ?? null, item.content.status, item.content.text ?? null, item.content.html ?? null]);
}
function analysisWhere(item: Item): Prisma.ItemWhereInput {
  return { id: item.id, summaryText: item.summaryText, translatedTitle: item.translatedTitle, qualityScore: item.qualityScore, qualityRationale: item.qualityRationale, eventType: item.eventType, eventTypeRaw: item.eventTypeRaw, eventSubject: item.eventSubject, eventAction: item.eventAction, eventObject: item.eventObject, eventDate: item.eventDate };
}

export async function guardedAdapterWrite(expected: Item, data: Prisma.ItemUncheckedCreateInput) {
  return prisma.$transaction(async (tx) => {
    const result = await tx.item.updateMany({ where: analysisWhere(expected), data });
    if (result.count !== 1) throw new AdapterError("MANUAL_CHANGED", "文章分析已被修改，请手动重分析。", false);
    return tx.item.findUniqueOrThrow({ where: { id: expected.id } });
  });
}

/** Resolve identity before processing; a conflicting URL never overwrites another item. */
export async function prepareAdapterItem(input: { sourceId: string; instanceId: string; providerId: string; item: AdapterItem; now: Date }) {
  const { item } = input;
  let url: URL;
  try { url = new URL(item.url); } catch { throw new AdapterError("INVALID_ITEM", "文章地址无效。", false); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !item.externalId || !item.title.trim()) throw new AdapterError("INVALID_ITEM", "文章身份无效。", false);
  const keys = buildDedupeKeys({ canonicalUrl: item.url });
  const contentHash = adapterContentHash(item);
  const identityKey = { adapterInstanceId: input.instanceId, providerId: input.providerId, externalId: item.externalId };
  const result = await prisma.$transaction(async (tx) => {
    const identity = await tx.adapterItemIdentity.findUnique({ where: { adapterInstanceId_providerId_externalId: identityKey }, include: { item: true } });
    const byUrl = await tx.item.findUnique({ where: { urlHash: keys.urlHash } });
    if (identity && byUrl && identity.itemId !== byUrl.id) throw new AdapterError("IDENTITY_CONFLICT", "文章地址与其他文章冲突。", false);
    const existing = identity?.item ?? byUrl;
    if (identity && identity.contentHash === contentHash) {
      return { item: existing!, identityId: identity.id, shouldProcess: !identity.needsManualReview && (existing!.status === "new" || existing!.status === "failed" || existing!.summaryStatus === "failed" || existing!.analysisStatus === "failed"), needsManualReview: identity.needsManualReview, isNew: false };
    }
    const published = item.publishedAt ? new Date(item.publishedAt) : null;
    const validPublished = published && Number.isFinite(published.getTime()) ? published : null;
    const content = item.content.html ?? item.content.text ?? null;
    if (!existing) {
      const created = await tx.item.create({ data: { sourceId: input.sourceId, originalUrl: item.url, canonicalUrl: keys.canonicalUrl, urlHash: keys.urlHash, originalTitle: item.title, author: item.author ?? null, publishedAt: validPublished ?? input.now, publishedAtKnown: Boolean(validPublished), rssExcerpt: item.summary ?? null, rssContent: content, fullText: item.content.status === "full" ? item.content.text ?? null : null } });
      const binding = await tx.adapterItemIdentity.create({ data: { ...identityKey, contentHash, itemId: created.id } });
      return { item: created, identityId: binding.id, shouldProcess: true, needsManualReview: false, isNew: true };
    }
    const sameInput = !identity && existing.originalTitle === item.title && existing.rssContent === content && existing.rssExcerpt === (item.summary ?? null) && (!validPublished || (existing.publishedAtKnown && existing.publishedAt.getTime() === validPublished.getTime()));
    if (sameInput) {
      const fingerprint = existing.analysisBaselineHash === analysisFingerprint(existing) ? existing.analysisBaselineHash : null;
      const binding = await tx.adapterItemIdentity.create({ data: { ...identityKey, contentHash, itemId: existing.id, processedFingerprint: fingerprint } });
      return { item: existing, identityId: binding.id, shouldProcess: existing.status === "new" || existing.status === "failed" || existing.summaryStatus === "failed" || existing.analysisStatus === "failed", needsManualReview: false, isNew: false };
    }
    const completed = existing.status === "processed" || existing.status === "filtered";
    const baseline = identity?.processedFingerprint ?? existing.analysisBaselineHash;
    const manuallyChanged = Boolean(identity?.needsManualReview) || (completed && (!baseline || baseline !== analysisFingerprint(existing)));
    const updated = await tx.item.update({ where: { id: existing.id }, data: {
      originalUrl: existing.sourceId === input.sourceId ? item.url : existing.originalUrl, canonicalUrl: keys.canonicalUrl, urlHash: keys.urlHash, originalTitle: item.title,
      author: item.author ?? existing.author, publishedAt: validPublished ?? existing.publishedAt,
      publishedAtKnown: validPublished ? true : existing.publishedAtKnown,
      rssExcerpt: item.summary ?? existing.rssExcerpt, rssContent: content ?? existing.rssContent,
      ...(item.content.status === "full" && content ? { fullText: item.content.text ?? null } : {}),
      ...(!manuallyChanged && completed ? { status: "new" as const, summaryStatus: "pending" as const, analysisStatus: "pending" as const } : {}),
    } });
    const binding = identity
      ? await tx.adapterItemIdentity.update({ where: { id: identity.id }, data: { contentHash, needsManualReview: manuallyChanged } })
      : await tx.adapterItemIdentity.create({ data: { ...identityKey, contentHash, itemId: updated.id, needsManualReview: manuallyChanged } });
    return { item: updated, identityId: binding.id, shouldProcess: !manuallyChanged, needsManualReview: manuallyChanged, isNew: false };
  });
  invalidateFeedCache();
  return result;
}

/** Record a baseline only after processing succeeded, leaving failures retryable. */
export async function recordAdapterProcessing(identityId: string, itemId: string, writtenFingerprint: string) {
  await prisma.$transaction(async (tx) => {
    const item = await tx.item.findUniqueOrThrow({ where: { id: itemId } });
    if (item.status !== "processed" || item.summaryStatus !== "succeeded" || item.analysisStatus !== "succeeded") return;
    const matches = analysisFingerprint(item) === writtenFingerprint;
    const recorded = matches ? await tx.item.updateMany({ where: analysisWhere(item), data: { analysisBaselineHash: writtenFingerprint } }) : { count: 0 };
    await tx.adapterItemIdentity.update({ where: { id: identityId }, data: { processedFingerprint: writtenFingerprint, needsManualReview: recorded.count !== 1 } });
  });
}

export async function recordItemAnalysisBaseline(itemId: string, writtenFingerprint: string, confirmReview = false) {
  await prisma.$transaction(async (tx) => {
    const item = await tx.item.findUniqueOrThrow({ where: { id: itemId } });
    if (item.summaryStatus !== "succeeded" || item.analysisStatus !== "succeeded" || analysisFingerprint(item) !== writtenFingerprint) return;
    const updated = await tx.item.updateMany({ where: analysisWhere(item), data: { analysisBaselineHash: writtenFingerprint } });
    if (updated.count === 1 && confirmReview) await tx.adapterItemIdentity.updateMany({ where: { itemId }, data: { processedFingerprint: writtenFingerprint, needsManualReview: false } });
  });
}
