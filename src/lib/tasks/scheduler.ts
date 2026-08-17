import { CronExpressionParser } from "cron-parser";

import type { ScheduleUpdateInput } from "@/lib/tasks/types";

export const DEFAULT_SCHEDULE_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_SCHEDULE_CRON_EXPRESSION = "0 * * * *";
export const DEFAULT_SOURCE_CONCURRENCY = 2;
export const DEFAULT_FULL_TEXT_FETCH_THRESHOLD = 80;
export const DEFAULT_PER_SOURCE_ITEM_LIMIT = 20;
export const DEFAULT_AGGREGATION_SPLIT_MAX_EVENTS = 20;
export const DEFAULT_DAILY_REPORT_CANDIDATE_LIMIT = 120;
export const DEFAULT_DAILY_REPORT_OFFSET_DAYS = 0;
export const MIN_SOURCE_CONCURRENCY = 1;
export const MAX_SOURCE_CONCURRENCY = 10;
export const MIN_FULL_TEXT_FETCH_THRESHOLD = 0;
export const MAX_FULL_TEXT_FETCH_THRESHOLD = 5000;
export const MIN_PER_SOURCE_ITEM_LIMIT = 1;
export const MAX_PER_SOURCE_ITEM_LIMIT = 200;
export const MIN_AGGREGATION_SPLIT_MAX_EVENTS = 1;
export const MAX_AGGREGATION_SPLIT_MAX_EVENTS = 50;
export const MIN_DAILY_REPORT_CANDIDATE_LIMIT = 2;
export const MAX_DAILY_REPORT_CANDIDATE_LIMIT = 500;
export const MIN_DAILY_REPORT_PLANNING_BATCH_SIZE = 1;
export const MIN_DAILY_REPORT_OFFSET_DAYS = 0;
export const MAX_DAILY_REPORT_OFFSET_DAYS = 365;
export const DEFAULT_CLEANUP_RETENTION_DAYS = 365;
export const MIN_CLEANUP_RETENTION_DAYS = 30;
export const MAX_CLEANUP_RETENTION_DAYS = 730;

function normalizeProcessingStartAt(value: string | null): string | null {
  const normalized = value?.trim();

  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Processing start time must be a valid date time.");
  }

  return parsed.toISOString();
}

export function normalizeScheduleInput(input: ScheduleUpdateInput): ScheduleUpdateInput {
  const cronExpression = input.cronExpression.trim();

  if (!cronExpression) {
    throw new Error("Cron expression is required.");
  }

  CronExpressionParser.parse(cronExpression, {
    currentDate: new Date(),
    tz: DEFAULT_SCHEDULE_TIMEZONE,
  });

  if (
    !Number.isInteger(input.sourceConcurrency) ||
    input.sourceConcurrency < MIN_SOURCE_CONCURRENCY ||
    input.sourceConcurrency > MAX_SOURCE_CONCURRENCY
  ) {
    throw new Error(
      `Source concurrency must be an integer between ${MIN_SOURCE_CONCURRENCY} and ${MAX_SOURCE_CONCURRENCY}.`,
    );
  }

  if (
    !Number.isInteger(input.fullTextFetchThreshold) ||
    input.fullTextFetchThreshold < MIN_FULL_TEXT_FETCH_THRESHOLD ||
    input.fullTextFetchThreshold > MAX_FULL_TEXT_FETCH_THRESHOLD
  ) {
    throw new Error(
      `Full text fetch threshold must be an integer between ${MIN_FULL_TEXT_FETCH_THRESHOLD} and ${MAX_FULL_TEXT_FETCH_THRESHOLD}.`,
    );
  }

  if (
    !Number.isInteger(input.perSourceItemLimit) ||
    input.perSourceItemLimit < MIN_PER_SOURCE_ITEM_LIMIT ||
    input.perSourceItemLimit > MAX_PER_SOURCE_ITEM_LIMIT
  ) {
    throw new Error(
      `Per source item limit must be an integer between ${MIN_PER_SOURCE_ITEM_LIMIT} and ${MAX_PER_SOURCE_ITEM_LIMIT}.`,
    );
  }

  const aggregationSplitMaxEvents =
    input.aggregationSplitMaxEvents ?? DEFAULT_AGGREGATION_SPLIT_MAX_EVENTS;

  if (
    !Number.isInteger(aggregationSplitMaxEvents) ||
    aggregationSplitMaxEvents < MIN_AGGREGATION_SPLIT_MAX_EVENTS ||
    aggregationSplitMaxEvents > MAX_AGGREGATION_SPLIT_MAX_EVENTS
  ) {
    throw new Error(
      `Aggregation split max events must be an integer between ${MIN_AGGREGATION_SPLIT_MAX_EVENTS} and ${MAX_AGGREGATION_SPLIT_MAX_EVENTS}.`,
    );
  }

  return {
    enabled: input.enabled,
    cronExpression,
    sourceConcurrency: input.sourceConcurrency,
    fullTextFetchThreshold: input.fullTextFetchThreshold,
    perSourceItemLimit: input.perSourceItemLimit,
    aggregationSplitMaxEvents,
    processingStartAt: normalizeProcessingStartAt(input.processingStartAt ?? null),
  };
}

export function computeNextRunAt(input: {
  cronExpression: string;
  now: Date;
  anchor?: Date | null;
  timezone?: string;
}) {
  const interval = CronExpressionParser.parse(input.cronExpression, {
    currentDate: input.anchor ?? input.now,
    tz: input.timezone ?? DEFAULT_SCHEDULE_TIMEZONE,
  });

  return interval.next().toDate();
}

export function isSchedulerHeartbeatStale(input: { lastHeartbeatAt: Date | null; now: Date; maxAgeMs: number }) {
  if (!input.lastHeartbeatAt) {
    return true;
  }

  return input.now.getTime() - input.lastHeartbeatAt.getTime() > input.maxAgeMs;
}
