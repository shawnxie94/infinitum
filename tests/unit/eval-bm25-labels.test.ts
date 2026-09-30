import { describe, expect, it } from "vitest";

import { getReviewedHumanLabel } from "../../scripts/eval-bm25-labels";

describe("BM25 hard-case human labels", () => {
  it("ignores labels while a row is pending review", () => {
    expect(getReviewedHumanLabel({
      reviewStatus: "pending",
      reviewer: "",
      humanLabel: "same",
    })).toBeNull();
  });

  it("accepts a valid label only after review is complete and attributed", () => {
    expect(getReviewedHumanLabel({
      reviewStatus: "reviewed",
      reviewer: "reviewer-1",
      humanLabel: "diff",
    })).toBe("diff");
  });

  it("rejects reviewed rows without a reviewer or a valid label", () => {
    expect(getReviewedHumanLabel({
      reviewStatus: "reviewed",
      reviewer: "  ",
      humanLabel: "same",
    })).toBeNull();
    expect(getReviewedHumanLabel({
      reviewStatus: "reviewed",
      reviewer: "reviewer-1",
      humanLabel: "uncertain",
    })).toBeNull();
  });
});
