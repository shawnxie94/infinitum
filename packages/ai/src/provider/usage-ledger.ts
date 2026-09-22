export type UsageLedgerDefinition = {
  key: string;
  label: string;
};

export type UsageLedgerTokenSnapshot = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  tokenUsageSource: "provider" | "estimated" | "mixed" | null;
};

export type UsageLedgerBreakdown = UsageLedgerDefinition & {
  actual: number;
  estimated: number;
  tokens: UsageLedgerTokenSnapshot;
};

export type UsageLedgerSnapshot = {
  actual: number;
  estimated: number;
  breakdown: UsageLedgerBreakdown[];
  attempts: Record<string, number>;
};

type Entry = UsageLedgerBreakdown;

type UsageInput = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  tokenUsageSource?: "provider" | "estimated" | "mixed";
};

export function createUsageLedger(definitions: readonly UsageLedgerDefinition[]) {
  const entries = new Map<string, Entry>();
  const attempts: Record<string, number> = {};

  for (const definition of definitions) {
    if (!definition.key.trim() || entries.has(definition.key)) {
      throw new Error(`Duplicate or empty AI usage key: ${definition.key}`);
    }
    entries.set(definition.key, {
      ...definition,
      actual: 0,
      estimated: 0,
      tokens: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        tokenUsageSource: null,
      },
    });
  }

  const entryFor = (key: string) => {
    const entry = entries.get(key);
    if (!entry) throw new Error(`Unknown AI usage key: ${key}`);
    return entry;
  };

  const syncEstimateFloor = () => {
    for (const entry of entries.values()) {
      if (entry.estimated < entry.actual) entry.estimated = entry.actual;
    }
  };

  return {
    setEstimated(value: number, key: string) {
      entryFor(key).estimated = Math.max(0, value);
      syncEstimateFloor();
    },
    addEstimated(value: number, key: string) {
      entryFor(key).estimated += Math.max(0, value);
      syncEstimateFloor();
    },
    recordCall(key: string, estimated = true) {
      const entry = entryFor(key);
      entry.actual += 1;
      if (estimated) entry.estimated += 1;
      syncEstimateFloor();
    },
    recordUsage(key: string, usage: UsageInput) {
      const entry = entryFor(key);
      entry.tokens.promptTokens += Math.max(0, usage.promptTokens);
      entry.tokens.completionTokens += Math.max(0, usage.completionTokens);
      entry.tokens.totalTokens += Math.max(0, usage.totalTokens);
      entry.tokens.cachedTokens += Math.max(0, usage.cachedTokens ?? 0);
      const source = usage.tokenUsageSource ?? "estimated";
      entry.tokens.tokenUsageSource = entry.tokens.tokenUsageSource === null || entry.tokens.tokenUsageSource === source
        ? source
        : "mixed";
    },
    recordAttempt(event: { usageKey?: string; attemptType: string }) {
      const key = `${event.usageKey ?? "unknown"}:${event.attemptType}`;
      attempts[key] = (attempts[key] ?? 0) + 1;
    },
    snapshot(): UsageLedgerSnapshot {
      const breakdown = [...entries.values()].map((entry) => ({
        ...entry,
        tokens: { ...entry.tokens },
      }));
      return {
        actual: breakdown.reduce((sum, entry) => sum + entry.actual, 0),
        estimated: breakdown.reduce((sum, entry) => sum + entry.estimated, 0),
        breakdown,
        attempts: { ...attempts },
      };
    },
  };
}
