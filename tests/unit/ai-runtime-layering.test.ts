import { describe, expect, it } from "vitest";

import { createAiOperationRegistry, createAiOperationRunner } from "@infinitum/ai/provider/operations";
import type { JsonCompleteRequest } from "@infinitum/ai/provider/types";
import { createUsageLedger } from "@infinitum/ai/provider/usage-ledger";
import { AI_OPERATION_REGISTRY } from "@/lib/ai/operations";

const usageDefinitions = AI_OPERATION_REGISTRY.list();

describe("AI runtime layering contracts", () => {
  it("keeps product AI operation keys in a framework-neutral registry", () => {
    expect(AI_OPERATION_REGISTRY.has("item_understanding")).toBe(true);
    expect(AI_OPERATION_REGISTRY.get("daily_report_review").label).toBe("审核");
    expect(() => AI_OPERATION_REGISTRY.get("unknown_operation")).toThrow("Unknown AI operation");
  });

  it("aggregates usage and attempt telemetry independently from business storage", () => {
    const ledger = createUsageLedger(usageDefinitions);
    ledger.setEstimated(1, "item_understanding");
    ledger.recordCall("item_understanding", false);
    ledger.recordUsage("item_understanding", {
      promptTokens: 12,
      completionTokens: 3,
      totalTokens: 15,
      cachedTokens: 0,
      tokenUsageSource: "provider",
    });
    ledger.recordAttempt({ usageKey: "item_understanding", attemptType: "initial" });

    const snapshot = ledger.snapshot();
    const itemUsage = snapshot.breakdown.find((entry) => entry.key === "item_understanding");
    expect(snapshot.actual).toBe(1);
    expect(snapshot.estimated).toBe(1);
    expect(itemUsage?.tokens.totalTokens).toBe(15);
    expect(snapshot.attempts["item_understanding:initial"]).toBe(1);
  });

  it("binds operation retry policy before entering the model gateway", async () => {
    const registry = createAiOperationRegistry([
      { key: "structured_test", label: "测试", retryPolicy: { jsonParseRetryCount: 2 } },
    ]);
    const requests: unknown[] = [];
    const runner = createAiOperationRunner({
      registry,
      gateway: {
        completeJson: async (request: JsonCompleteRequest) => {
          requests.push(request);
          return { ok: true };
        },
      } as never,
    });

    await runner.completeJson({
      taskType: "structured_test",
      usageKey: "structured_test",
      systemPrompt: "system",
      userContent: "{}",
    }, () => ({ ok: true }));

    expect(requests).toHaveLength(1);
    expect((requests[0] as { jsonParseRetryCount?: number }).jsonParseRetryCount).toBe(2);
  });

  it("rejects duplicate operation definitions before runtime startup", () => {
    expect(() => createAiOperationRegistry([
      { key: "same", label: "A" },
      { key: "same", label: "B" },
    ])).toThrow("Duplicate or empty AI operation key");
  });
});
