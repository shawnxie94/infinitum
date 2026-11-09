import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EventBriefingCard } from "@/components/events/event-briefing-card";
import type { EventBriefingEntryDTO } from "@/lib/events/types";

describe("EventBriefingCard", () => {
  it("shows effective update time on the Shanghai calendar day, independent of capture time and process TZ", () => {
    const entry: EventBriefingEntryDTO = {
      id: "cross-day-event",
      type: "cluster",
      title: "迟到补抓报道",
      summary: "摘要",
      qualityScore: 80,
      rankScore: 80,
      isFollowUp: false,
      sourceCount: 1,
      itemCount: 1,
      newItemCountOnDate: 1,
      newSourceCountOnDate: 1,
      latestCreatedAt: "2026-11-09T04:00:00.000Z",
      latestPublishedAt: "2026-11-06T20:00:00.000Z",
      latestEffectiveAt: "2026-11-06T20:00:00.000Z",
      eventType: null,
      eventSubject: null,
      eventAction: null,
      eventObject: null,
      eventDate: null,
      detailHref: "/events/cross-day-event",
      items: [],
    };
    render(<EventBriefingCard entry={entry} rank={1} onOpen={vi.fn()} />);

    expect(screen.getByText("11/07 04:00 更新")).toBeInTheDocument();
    expect(screen.queryByText("12:00 更新")).not.toBeInTheDocument();
  });
});
