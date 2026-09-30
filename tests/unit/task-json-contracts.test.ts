import { describe, expect, it } from "vitest";

import {
  normalizeTaskStageTimingSnapshot,
  normalizeTaskTimelineNodeSnapshot,
  parseTaskStageTimingsJson,
  parseTaskTimelineJson,
  serializeTaskStageTimings,
  serializeTaskTimeline,
} from "@/lib/tasks/json-contracts";

function buildNode(overrides: Record<string, unknown> = {}) {
  return {
    key: "daily_report_write",
    label: "自定义标签",
    status: "succeeded",
    startedAt: "2026-09-30T00:00:00.000Z",
    finishedAt: "2026-09-30T00:01:00.000Z",
    durationMs: 60000,
    modelName: "glm-4",
    metrics: [{ label: "条数", value: 3 }],
    audit: { groupConflict: { merged: 2, kept: 5 } },
    ...overrides,
  };
}

describe("parseTaskStageTimingsJson", () => {
  it("returns [] for null/empty/corrupt/non-array input", () => {
    expect(parseTaskStageTimingsJson(null)).toEqual([]);
    expect(parseTaskStageTimingsJson(undefined)).toEqual([]);
    expect(parseTaskStageTimingsJson("")).toEqual([]);
    expect(parseTaskStageTimingsJson("not-json")).toEqual([]);
    expect(parseTaskStageTimingsJson(JSON.stringify({ key: "x" }))).toEqual([]);
  });

  it("filters bad records item by item while keeping valid ones", () => {
    const parsed = parseTaskStageTimingsJson(JSON.stringify([
      "not-an-object",
      null,
      { label: "missing key" },
      { key: "assess", label: "评估", startedAt: "2026-09-30T00:00:00.000Z", finishedAt: null, durationMs: 5 },
    ]));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      key: "assess",
      label: "评估",
      startedAt: "2026-09-30T00:00:00.000Z",
      finishedAt: null,
      durationMs: 5,
    });
  });

  it("coerces bad status/detail/duration per field without dropping the record", () => {
    const snapshot = normalizeTaskStageTimingSnapshot({
      key: "write",
      label: "写作",
      startedAt: 123,
      finishedAt: 456,
      durationMs: "not-a-number",
      status: "bogus-status",
      detail: "x".repeat(400),
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.startedAt).toBeNull();
    expect(snapshot?.finishedAt).toBeNull();
    expect(snapshot?.durationMs).toBeNull();
    expect(snapshot?.status).toBeUndefined();
    expect(snapshot?.detail).toHaveLength(300);
  });
});

describe("serializeTaskStageTimings", () => {
  it("serializes null as null and roundtrips valid snapshots", () => {
    expect(serializeTaskStageTimings(null)).toBeNull();

    const snapshots = parseTaskStageTimingsJson(serializeTaskStageTimings(parseTaskStageTimingsJson(JSON.stringify([
      { key: "assess", label: "评估", startedAt: null, finishedAt: null, durationMs: null, status: "failed", detail: "boom" },
    ]))));

    expect(snapshots).toEqual([
      { key: "assess", label: "评估", startedAt: null, finishedAt: null, durationMs: null, status: "failed", detail: "boom" },
    ]);
  });
});

describe("parseTaskTimelineJson", () => {
  it("returns [] for null/empty/corrupt/non-array input", () => {
    expect(parseTaskTimelineJson(null)).toEqual([]);
    expect(parseTaskTimelineJson(undefined)).toEqual([]);
    expect(parseTaskTimelineJson("")).toEqual([]);
    expect(parseTaskTimelineJson("nope")).toEqual([]);
    expect(parseTaskTimelineJson(JSON.stringify({ nodes: [] }))).toEqual([]);
  });

  it("filters unsupported keys/statuses item by item", () => {
    const parsed = parseTaskTimelineJson(JSON.stringify([
      buildNode({ key: "unknown_key" }),
      buildNode({ status: "exploded" }),
      buildNode(),
    ]));

    expect(parsed).toHaveLength(1);
    expect(parsed[0].key).toBe("daily_report_write");
  });

  it("overrides known labels and keeps custom labels otherwise", () => {
    const overridden = normalizeTaskTimelineNodeSnapshot(buildNode({ key: "daily_report_assess" }));
    expect(overridden?.label).toBe("评估");

    const kept = normalizeTaskTimelineNodeSnapshot(buildNode({ key: "daily_report_merge" }));
    expect(kept?.label).toBe("自定义标签");
  });

  it("normalizes metrics item by item and coerces bad numbers to 0", () => {
    const node = normalizeTaskTimelineNodeSnapshot(buildNode({
      metrics: [
        "bad",
        null,
        { label: "条数", value: 3 },
        { value: 1 },
        { label: "坏数值", value: "NaN" },
        { label: "非有限", value: Number.POSITIVE_INFINITY },
      ],
    }));

    expect(node?.metrics).toEqual([
      { label: "条数", value: 3 },
      { label: "坏数值", value: 0 },
      { label: "非有限", value: 0 },
    ]);
  });

  it("keeps audit objects transparent, including cluster groupConflict records", () => {
    const node = normalizeTaskTimelineNodeSnapshot(buildNode({
      key: "cluster_merge",
      audit: { groupConflict: { groups: [1, 2], decision: "kept" } },
    }));

    expect(node?.audit).toEqual({ groupConflict: { groups: [1, 2], decision: "kept" } });

    const dropped = normalizeTaskTimelineNodeSnapshot(buildNode({ audit: "not-an-object" }));
    expect(dropped?.audit).toBeUndefined();
  });

  it("defaults optional fields on legacy nodes missing them", () => {
    const node = normalizeTaskTimelineNodeSnapshot(buildNode({
      startedAt: undefined,
      finishedAt: undefined,
      durationMs: undefined,
      modelName: undefined,
      metrics: undefined,
      audit: undefined,
    }));

    expect(node).toMatchObject({
      key: "daily_report_write",
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      modelName: null,
      metrics: [],
    });
    expect(node?.audit).toBeUndefined();
  });

  it("roundtrips a valid timeline through serialize without loss", () => {
    const timeline = parseTaskTimelineJson(JSON.stringify([buildNode()]));

    expect(parseTaskTimelineJson(serializeTaskTimeline(timeline))).toEqual(timeline);
  });

  it("serializes null timeline as null", () => {
    expect(serializeTaskTimeline(null)).toBeNull();
  });
});
