import { describe, expect, it } from "vitest";

import { buildEventBucket, buildEventIdentity } from "@/lib/clusters/identity";

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
});
