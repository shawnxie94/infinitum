import type { DailyReportReviewStatus } from "@/lib/daily-report/types";

type ReviewViolationLike = {
  severity?: unknown;
  message?: unknown;
};

type ReviewAuditLike = {
  error?: unknown;
  retryError?: unknown;
  first?: {
    violations?: unknown;
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeReviewErrorMessage(message: string) {
  return message
    .replace(/^Review\s+触发/, "审核触发")
    .replace(/^Review\s+输入/, "审核输入");
}

function readViolations(value: unknown): ReviewViolationLike[] {
  return Array.isArray(value)
    ? value.filter((violation): violation is ReviewViolationLike => asRecord(violation) !== null)
    : [];
}

function summarizeViolations(violations: ReviewViolationLike[]) {
  const messages = violations
    .map((violation) => nonEmptyString(violation.message))
    .filter((message): message is string => message !== null);
  if (messages.length === 0) return null;

  const errorMessages = violations
    .filter((violation) => violation.severity === "error")
    .map((violation) => nonEmptyString(violation.message))
    .filter((message): message is string => message !== null);
  const selected = errorMessages.length > 0 ? errorMessages : messages;
  const visible = selected.slice(0, 3).join("；");
  const remaining = selected.length - Math.min(selected.length, 3);
  return `审核未通过：${visible}${remaining > 0 ? `；另有 ${remaining} 条审核问题` : ""}`;
}

export function getDailyReportFailureSummary(input: {
  status?: DailyReportReviewStatus | null;
  audit?: unknown;
  violations?: unknown;
  partial?: boolean;
  omittedTopicCount?: number;
}) {
  const audit = asRecord(input.audit) as ReviewAuditLike | null;
  const retryError = normalizeReviewErrorMessage(nonEmptyString(audit?.retryError) ?? "");
  if (retryError) return retryError;

  const reviewError = nonEmptyString(audit?.error);
  if (reviewError) return `审核调用失败：${reviewError}`;

  const auditViolations = asRecord(audit?.first)?.violations;
  const explicitViolations = readViolations(input.violations);
  const violationSummary = summarizeViolations(
    explicitViolations.length > 0 ? explicitViolations : readViolations(auditViolations),
  );
  if (violationSummary) return violationSummary;

  if (input.status === "unavailable") {
    return "审核未完成，已保留草稿并阻止自动发布。";
  }

  if (input.status === "rejected") {
    return "审核未通过，已保留草稿并阻止自动发布。";
  }

  if (input.partial) {
    const count = input.omittedTopicCount && input.omittedTopicCount > 0
      ? `（剔除 ${input.omittedTopicCount} 条）`
      : "";
    return `部分条目因校验失败被剔除${count}。`;
  }

  return null;
}
