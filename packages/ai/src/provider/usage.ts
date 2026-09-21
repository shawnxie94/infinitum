export type UsageAttemptType =
  | "initial"
  | "transport_retry"
  | "structured_fallback"
  | "json_retry"
  | "business_repair";

export type UsageEvent = {
  usageKey: string;
  attemptType: UsageAttemptType;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
};

export type UsageSummary = {
  calls: number;
  byKey: Record<string, { calls: number; promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number }>;
  byAttempt: Record<UsageAttemptType, number>;
};

export function createUsageInterceptor(onEvent?: (event: UsageEvent) => void) {
  const events: UsageEvent[] = [];
  return {
    record(event: UsageEvent) {
      const normalized = {
        ...event,
        promptTokens: Math.max(0, event.promptTokens),
        completionTokens: Math.max(0, event.completionTokens),
        totalTokens: Math.max(0, event.totalTokens),
        cachedTokens: Math.max(0, event.cachedTokens ?? 0),
      };
      events.push(normalized);
      onEvent?.(normalized);
    },
    events(): UsageEvent[] {
      return events.map((event) => ({ ...event }));
    },
    summary(): UsageSummary {
      const byKey: UsageSummary["byKey"] = {};
      const byAttempt: UsageSummary["byAttempt"] = {
        initial: 0,
        transport_retry: 0,
        structured_fallback: 0,
        json_retry: 0,
        business_repair: 0,
      };
      for (const event of events) {
        byAttempt[event.attemptType] += 1;
        const current = byKey[event.usageKey] ?? { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
        current.calls += 1;
        current.promptTokens += event.promptTokens;
        current.completionTokens += event.completionTokens;
        current.totalTokens += event.totalTokens;
        current.cachedTokens += event.cachedTokens ?? 0;
        byKey[event.usageKey] = current;
      }
      return { calls: events.length, byKey, byAttempt };
    },
  };
}
