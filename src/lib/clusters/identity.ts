import crypto from "node:crypto";

import type { AiEventSignature } from "@/lib/ai/provider";
import {
  getEventDatePrecision,
  normalizeEventDateForStorage,
  normalizeEventSignatureForStorage,
} from "@/lib/clusters/normalization";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ClusterEventIdentity = {
  eventFingerprint: string;
  eventBucket: string;
  eventIdentityKey: string;
  identityConfidence: number;
};

function startOfUtcWeek(value: Date) {
  const date = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return new Date(date.getTime() + mondayOffset * DAY_MS);
}

function toUtcDateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function buildEventBucket(input: {
  eventDate?: string | null;
  publishedAt: Date;
}) {
  const eventDate = normalizeEventDateForStorage(input.eventDate);
  const eventDatePrecision = getEventDatePrecision(eventDate);
  if (eventDate && eventDatePrecision === "day") {
    return `date:${eventDate}`;
  }
  if (eventDate && eventDatePrecision === "month") {
    return `month:${eventDate}`;
  }
  if (eventDate && eventDatePrecision === "year") {
    return `year:${eventDate}`;
  }

  return `week:${toUtcDateKey(startOfUtcWeek(input.publishedAt))}`;
}

export function buildEventFingerprint(signature?: AiEventSignature | null) {
  const normalized = normalizeEventSignatureForStorage(signature);
  if (!normalized?.eventSubject || !normalized.eventObject) {
    return null;
  }

  const eventKind = normalized.eventAction || normalized.eventType;
  if (!eventKind) {
    return null;
  }

  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        eventType: normalized.eventType ?? "",
        eventSubject: normalized.eventSubject,
        eventAction: normalized.eventAction ?? "",
        eventObject: normalized.eventObject,
      }),
    )
    .digest("hex");
}

export function buildEventIdentity(input: {
  eventSignature?: AiEventSignature | null;
  publishedAt: Date;
}): ClusterEventIdentity | null {
  const normalized = normalizeEventSignatureForStorage(input.eventSignature);
  const eventFingerprint = buildEventFingerprint(normalized);
  if (!eventFingerprint) {
    return null;
  }

  const eventBucket = buildEventBucket({
    eventDate: normalized?.eventDate,
    publishedAt: input.publishedAt,
  });
  const datePrecision = getEventDatePrecision(normalized?.eventDate);
  const dateConfidence = datePrecision === "day" ? 20 : datePrecision === "month" ? 10 : datePrecision === "year" ? 5 : 0;
  const identityConfidence =
    65 +
    (normalized?.eventType ? 5 : 0) +
    (normalized?.eventAction ? 10 : 0) +
    dateConfidence;

  return {
    eventFingerprint,
    eventBucket,
    eventIdentityKey: `${eventFingerprint}:${eventBucket}`,
    identityConfidence: Math.min(100, identityConfidence),
  };
}
