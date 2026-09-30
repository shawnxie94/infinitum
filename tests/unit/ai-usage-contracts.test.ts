import { describe, expect, it } from "vitest";

import {
  TASK_AI_CALL_BREAKDOWN_LABELS,
  getDefaultTaskAiCallBreakdown,
  normalizeAiUsageCount,
  normalizeAiUsageTokenField,
  normalizeTaskAiCallBreakdownEntry,
  parseTaskAiCallBreakdownArray,
  parseTaskAiCallBreakdownJson,
} from "@/lib/tasks/ai-usage-contracts";
import { toTaskRunSnapshot } from "@/lib/tasks/service";

const baseTask = {
  id: "task-contract",
  kind: "ingestion" as const,
  triggerType: "manual" as const,
  status: "succeeded" as const,
  label: "抓取任务",
  entityId: null,
  progressCurrent: 0,
  progressTotal: 0,
  progressLabel: null,
  itemsAdded: 0,
  fullTextFetchedCount: 0,
  aiCallCountActual: 0,
  aiCallCountEstimated: 0,
  cancelRequestedAt: null,
  startedAt: null,
  finishedAt: null,
  errorSummary: null,
  stageTimingsJson: null,
  taskTimelineJson: null,
};

describe("ai usage count normalization", () => {
  it("accepts finite non-negative numbers only", () => {
    expect(normalizeAiUsageCount(3)).toBe(3);
    expect(normalizeAiUsageCount(0)).toBe(0);
    expect(normalizeAiUsageCount(-1)).toBe(0);
    expect(normalizeAiUsageCount(Number.NaN)).toBe(0);
    expect(normalizeAiUsageCount(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeAiUsageCount("5")).toBe(0);
    expect(normalizeAiUsageCount(null)).toBe(0);
  });

  it("keeps optional token fields undefined on invalid input", () => {
    expect(normalizeAiUsageTokenField(12)).toBe(12);
    expect(normalizeAiUsageTokenField(-3)).toBeUndefined();
    expect(normalizeAiUsageTokenField(Number.NaN)).toBeUndefined();
    expect(normalizeAiUsageTokenField("12")).toBeUndefined();
    expect(normalizeAiUsageTokenField(undefined)).toBeUndefined();
  });
});

describe("normalizeTaskAiCallBreakdownEntry", () => {
  it("drops entries without a usable key", () => {
    expect(normalizeTaskAiCallBreakdownEntry(null)).toBeNull();
    expect(normalizeTaskAiCallBreakdownEntry("nope")).toBeNull();
    expect(normalizeTaskAiCallBreakdownEntry({ label: "x" })).toBeNull();
    expect(normalizeTaskAiCallBreakdownEntry({ key: "" })).toBeNull();
  });

  it("rejects unknown keys in strict mode but keeps them in lenient mode", () => {
    const entry = { key: "mystery_stage", actual: 2, estimated: 1 };
    expect(normalizeTaskAiCallBreakdownEntry(entry)).toBeNull();
    const lenient = normalizeTaskAiCallBreakdownEntry(entry, { mode: "lenient" });
    expect(lenient).toMatchObject({ key: "mystery_stage", label: "mystery_stage", actual: 2, estimated: 1 });
  });

  it("falls back missing labels to the key in lenient mode and keeps known actual", () => {
    const entry = normalizeTaskAiCallBreakdownEntry({ key: "item_understanding", actual: 4 }, { mode: "lenient" });
    expect(entry).toMatchObject({ key: "item_understanding", actual: 4 });
    expect(typeof entry!.label).toBe("string");
  });

  it("keeps stored labels in lenient mode even for known keys", () => {
    const entry = normalizeTaskAiCallBreakdownEntry(
      { key: "daily_report", label: "历史标签", actual: 1 },
      { mode: "lenient" },
    );
    expect(entry).toMatchObject({ key: "daily_report", label: "历史标签" });
  });

  it("defaults invalid required counts to 0 without fabricating tokens", () => {
    const entry = normalizeTaskAiCallBreakdownEntry({
      key: "cluster_match",
      actual: "9",
      estimated: -2,
      promptTokens: Number.NaN,
    }, { mode: "lenient" });
    expect(entry).toMatchObject({ key: "cluster_match", actual: 0, estimated: 0 });
    expect(entry).not.toHaveProperty("promptTokens");
    expect(entry).not.toHaveProperty("totalTokens");
  });

  it("derives totalTokens and keeps enum-guarded metadata", () => {
    const entry = normalizeTaskAiCallBreakdownEntry({
      key: "item_understanding",
      actual: 1,
      estimated: 1,
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 2,
      cachedTokensStatus: "weird",
      tokenUsageSource: "provider",
      contractVersion: "v1",
      contractHash: "hash-1",
      modelNames: ["model-a", "model-a", " ", "model-b"],
    }, { mode: "lenient" });
    expect(entry).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cachedTokens: 2,
      tokenUsageSource: "provider",
      contractVersion: "v1",
      contractHash: "hash-1",
    });
    expect(entry).not.toHaveProperty("cachedTokensStatus");
    expect(entry!.modelNames).toEqual(["model-a", "model-b"]);
  });
});

describe("parseTaskAiCallBreakdownJson tolerance", () => {
  it("returns empty for broken JSON / null / non-array", () => {
    expect(parseTaskAiCallBreakdownJson("{broken")).toEqual([]);
    expect(parseTaskAiCallBreakdownJson(null)).toEqual([]);
    expect(parseTaskAiCallBreakdownJson(JSON.stringify({ key: "item_understanding" }))).toEqual([]);
    expect(parseTaskAiCallBreakdownJson("null")).toEqual([]);
  });

  it("skips broken items without dropping the following valid ones", () => {
    const parsed = parseTaskAiCallBreakdownArray([
      null,
      "junk",
      { key: "cluster_match", actual: 1 },
      { key: "cluster_summary", actual: Number.NaN },
      { key: "daily_report", actual: 2, estimated: 1e309 },
      { key: "item_understanding", actual: 3 },
    ], { mode: "lenient" });
    expect(parsed.map((entry) => entry.key)).toEqual(["cluster_match", "cluster_summary", "daily_report", "item_understanding"]);
    expect(parsed.find((entry) => entry.key === "cluster_summary")?.actual).toBe(0);
    // 1e309 序列化后是 Infinity，非法值回退 0
    expect(parsed.find((entry) => entry.key === "daily_report")).toMatchObject({ actual: 2, estimated: 0 });
  });
});

describe("monitor snapshot defaults (strict mode)", () => {
  it("fills all 11 keys in label-table order with defaults on bad input", () => {
    for (const json of [null, "{broken", JSON.stringify({ nope: 1 }), JSON.stringify([{ key: "unknown" }])]) {
      const snapshot = toTaskRunSnapshot({ ...baseTask, aiCallBreakdownJson: json });
      expect(snapshot.aiCallBreakdown).toEqual(getDefaultTaskAiCallBreakdown());
    }
    expect(getDefaultTaskAiCallBreakdown()).toHaveLength(Object.keys(TASK_AI_CALL_BREAKDOWN_LABELS).length);
  });

  it("applies last-key-wins over defaults and keeps legacy key-only entries", () => {
    const snapshot = toTaskRunSnapshot({
      ...baseTask,
      aiCallBreakdownJson: JSON.stringify([
        { key: "item_understanding", actual: 1 },
        { key: "item_understanding", actual: 3, estimated: 2 },
      ]),
    });
    const entry = snapshot.aiCallBreakdown!.find((item) => item.key === "item_understanding");
    expect(entry).toMatchObject({ actual: 3, estimated: 2, label: "条目理解" });
    expect(snapshot.aiCallBreakdown!.find((item) => item.key === "daily_report")).toMatchObject({ actual: 0 });
  });
});
