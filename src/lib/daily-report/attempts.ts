import { DAILY_REPORT_ATTEMPT_MATRIX } from "@/lib/daily-report/planning";

export function getDailyReportAttemptLimit(stage: string) {
  const matrixStage = stage.toUpperCase();
  return DAILY_REPORT_ATTEMPT_MATRIX.find((entry) => entry.stage === matrixStage)?.maxAttempts ?? 1;
}

export function isDailyReportContextOverflowError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /context\s*(length|window|limit)|maximum\s+context|too\s+many\s+tokens|token\s+limit|上下文.{0,8}(超|限制)|令牌.{0,8}(超|限制)/iu.test(message);
}
