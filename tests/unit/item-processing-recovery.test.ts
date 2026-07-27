
import { describe, expect, it } from "vitest";

import {
  classifyItemProcessingRecoveryReasons,
  computeItemProcessingRetryAt,
} from "@/lib/items/processing-state";
import {
  ITEM_PROCESSING_RECOVERY_BASE_DELAY_MS,
  ITEM_PROCESSING_RECOVERY_BATCH_SIZE,
  ITEM_PROCESSING_RECOVERY_MAX_DELAY_MS,
  ITEM_PROCESSING_RECOVERY_MAX_ROUNDS,
} from "@/config/constants";

describe("item processing recovery state", () => {
  it("classifies failed summary/analysis and retriable aggregation", () => {
    expect(
      classifyItemProcessingRecoveryReasons({
        status: "processed",
        moderationStatus: "allowed",
        summaryStatus: "failed",
        analysisStatus: "succeeded",
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: "Toolkit",
        source: { aiParsingEnabled: true, aggregationDetectionEnabled: true },
      }),
    ).toEqual(["summary_failed"]);

    expect(
      classifyItemProcessingRecoveryReasons({
        status: "processed",
        moderationStatus: "allowed",
        summaryStatus: "succeeded",
        analysisStatus: "failed",
        source: { aiParsingEnabled: true },
      }),
    ).toEqual(["analysis_failed"]);

    expect(
      classifyItemProcessingRecoveryReasons({
        status: "processed",
        moderationStatus: "allowed",
        summaryStatus: "succeeded",
        analysisStatus: "succeeded",
        aggregationParseStatus: "failed",
        source: { aiParsingEnabled: true, aggregationDetectionEnabled: true },
      }),
    ).toEqual(["aggregation_retriable"]);
  });

  it("classifies incomplete event signatures as recovery candidates", () => {
    expect(
      classifyItemProcessingRecoveryReasons({
        status: "processed",
        moderationStatus: "allowed",
        summaryStatus: "succeeded",
        analysisStatus: "succeeded",
        isAggregation: false,
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: null,
        source: { aiParsingEnabled: true },
      }),
    ).toEqual(["incomplete_signature"]);
  });

  it("uses a 30-item batch with at most 3 continuation rounds", () => {
    expect(ITEM_PROCESSING_RECOVERY_BATCH_SIZE).toBe(30);
    expect(ITEM_PROCESSING_RECOVERY_MAX_ROUNDS).toBe(3);
  });

  it("computes exponential retry backoff with a cap", () => {
    const now = new Date("2026-04-10T00:00:00.000Z");
    expect(computeItemProcessingRetryAt(1, now).getTime() - now.getTime()).toBe(
      ITEM_PROCESSING_RECOVERY_BASE_DELAY_MS,
    );
    expect(computeItemProcessingRetryAt(2, now).getTime() - now.getTime()).toBe(
      ITEM_PROCESSING_RECOVERY_BASE_DELAY_MS * 2,
    );
    expect(computeItemProcessingRetryAt(10, now).getTime() - now.getTime()).toBe(
      ITEM_PROCESSING_RECOVERY_MAX_DELAY_MS,
    );
  });
});
