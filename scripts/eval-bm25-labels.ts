export type ReviewedHumanLabel = "same" | "diff";

export function getReviewedHumanLabel(
  row: Record<string, string>,
): ReviewedHumanLabel | null {
  if (row.reviewStatus !== "reviewed" || !row.reviewer?.trim()) return null;
  return row.humanLabel === "same" || row.humanLabel === "diff"
    ? row.humanLabel
    : null;
}
