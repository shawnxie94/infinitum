import { describe, expect, it } from "vitest";

import { buildEventBucket, buildEventIdentity } from "@/lib/clusters/identity";
import { buildCandidateRange } from "@/lib/clusters/helpers";

describe("cluster event identity", () => {
  it("uses canonical date buckets for equivalent date formats", () => {
    const publishedAt = new Date("2026-04-10T10:00:00.000Z");

    expect(buildEventBucket({ eventDate: "2026/4/10", publishedAt })).toBe("date:2026-04-10");
    expect(buildEventBucket({ eventDate: "2026年4月", publishedAt })).toBe("month:2026-04");
    expect(buildEventBucket({ eventDate: "2026年", publishedAt })).toBe("year:2026");
  });

  it("keeps equivalent date formats on the same event identity", () => {
    const publishedAt = new Date("2026-04-10T10:00:00.000Z");
    const base = {
      eventType: "launch" as const,
      eventSubject: "Acme",
      eventAction: "发布",
      eventObject: "Widget",
    };

    expect(
      buildEventIdentity({ eventSignature: { ...base, eventDate: "2026/4/10" }, publishedAt })?.eventIdentityKey,
    ).toBe(buildEventIdentity({ eventSignature: { ...base, eventDate: "2026-04-10" }, publishedAt })?.eventIdentityKey);
  });

  it("uses createdAt as the candidate time anchor when publication time is unknown", () => {
    const range = buildCandidateRange({
      publishedAt: new Date("2020-01-01T00:00:00.000Z"),
      publishedAtKnown: false,
      createdAt: new Date("2026-04-10T10:00:00.000Z"),
    } as never, 7 * 24 * 60 * 60 * 1000);

    expect(range.timeField).toBe("createdAt");
    expect(range.since.toISOString()).toBe("2026-04-03T10:00:00.000Z");
    expect(range.until.toISOString()).toBe("2026-04-17T10:00:00.000Z");
  });
});
