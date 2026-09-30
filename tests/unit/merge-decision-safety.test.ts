import { describe, expect, it } from "vitest";

import type { ClusterMergeDecision } from "@/lib/ai/provider-types";
import { reconcileApprovedClusterMergeDecision } from "@/lib/clusters/merge-decision-safety";

const APPROVED_DECISION: ClusterMergeDecision = {
  leftClusterId: "left",
  rightClusterId: "right",
  verdict: "approved",
  confidence: 96,
  reasonCode: "same_event",
  reasonText: "两条报道标题不同，但讲的是同一事件，建议合并。",
};

describe("reconcileApprovedClusterMergeDecision", () => {
  it("keeps an approval when the reason and event signals are consistent", () => {
    const result = reconcileApprovedClusterMergeDecision(APPROVED_DECISION, null);

    expect(result.decision).toEqual(APPROVED_DECISION);
    expect(result.audit).toBeNull();
  });

  it("downgrades an approval whose reason explicitly rejects the merge and preserves the original decision", () => {
    const original = {
      ...APPROVED_DECISION,
      reasonText: "这是两个不同的事件，应该拒绝合并。",
    };
    const result = reconcileApprovedClusterMergeDecision(original, null);

    expect(result.decision).toMatchObject({
      verdict: "ambiguous",
      reasonCode: "insufficient_evidence",
      reasonText: expect.stringContaining("原始 AI verdict=approved"),
    });
    expect(result.decision.reasonText).toContain(original.reasonText);
    expect(result.audit).toMatchObject({
      status: "downgraded",
      issueCodes: ["explicit_negative_reason"],
      original: {
        verdict: "approved",
        reasonCode: "same_event",
        reasonText: original.reasonText,
      },
      effective: { verdict: "ambiguous", reasonCode: "insufficient_evidence" },
    });
  });

  it("downgrades an approval when structured event signatures show unrelated named subjects", () => {
    const result = reconcileApprovedClusterMergeDecision(APPROVED_DECISION, "unrelated_subjects");

    expect(result.decision.verdict).toBe("ambiguous");
    expect(result.audit?.issueCodes).toContain("unrelated_structured_entities");
  });

  it("does not mistake a clear statement against rejecting the merge for a contradiction", () => {
    const decision = {
      ...APPROVED_DECISION,
      reasonText: "两条报道标题不同但属于同一事件，无需拒绝合并，建议批准。",
    };
    const result = reconcileApprovedClusterMergeDecision(decision, null);

    expect(result.decision).toEqual(decision);
    expect(result.audit).toBeNull();
  });

  it("does not rewrite a non-approved decision", () => {
    const declined: ClusterMergeDecision = {
      ...APPROVED_DECISION,
      verdict: "declined",
      reasonCode: "different_event",
      reasonText: "这是两个不同的事件，应该拒绝合并。",
    };
    const result = reconcileApprovedClusterMergeDecision(declined, "unrelated_subjects");

    expect(result.decision).toEqual(declined);
    expect(result.audit).toBeNull();
  });
});
