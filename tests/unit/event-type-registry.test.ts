import { describe, expect, it } from "vitest";

import { normalizeEventTypeKeyInput } from "@/lib/event-types/key";
import { buildEnabledEventTypeResolver, resolveEventTypeOutput, resolveEventTypeLabel } from "@/lib/event-types/resolve";
import { toRegistrySnapshot, validateEventTypeDefinitions } from "@/lib/event-types/validation";

function snapshotOf(types: Array<{ key: string; label: string; enabled?: boolean; aliases?: string[]; description?: string | null; sortOrder?: number }>) {
  return toRegistrySnapshot(types.map((type, index) => ({
    id: `id-${index}`,
    key: type.key,
    label: type.label,
    description: type.description ?? null,
    aliasesJson: JSON.stringify(type.aliases ?? []),
    enabled: type.enabled ?? true,
    sortOrder: type.sortOrder ?? index,
  })));
}

describe("event type key normalization", () => {
  it("derives a stable machine key from free-form input", () => {
    expect(normalizeEventTypeKeyInput("Economic Data")).toBe("economic-data");
    expect(normalizeEventTypeKeyInput("  融资 Events_2026 ")).toBe("events_2026");
    expect(normalizeEventTypeKeyInput("A_B")).toBe("a_b");
    expect(normalizeEventTypeKeyInput("x")).toBe("x");
  });

  it("rejects inputs that cannot form a key", () => {
    expect(normalizeEventTypeKeyInput("")).toBeNull();
    expect(normalizeEventTypeKeyInput("!!!")).toBeNull();
    expect(normalizeEventTypeKeyInput(null)).toBeNull();
  });
});

describe("event type definition validation", () => {
  it("rejects alias collisions atomically", () => {
    expect(() => validateEventTypeDefinitions([
      { key: "finance", label: "财经", aliases: ["经济数据"] },
      { key: "macro", label: "宏观", aliases: ["经济数据"] },
    ])).toThrow(/经济数据/);
  });

  it("rejects a key colliding with another type's alias", () => {
    expect(() => validateEventTypeDefinitions([
      { key: "finance", label: "财经", aliases: ["经济"] },
      { key: "经济", label: "宏观经济" },
    ])).toThrow();
  });

  it("rejects repeated identical keys inside one definition set", () => {
    expect(() => validateEventTypeDefinitions([
      { key: "finance", label: "财经" },
      { key: "finance", label: "财经二" },
    ])).toThrow(/重复/);
  });

  it("rejects a custom definition disabling the protected other", () => {
    expect(() => validateEventTypeDefinitions([
      { key: "other", label: "其他", enabled: false },
    ])).toThrow(/other/);
  });

  it("rejects aliases claiming the protected other token", () => {
    expect(() => validateEventTypeDefinitions([
      { key: "finance", label: "财经", aliases: ["other"] },
    ])).toThrow(/other/);
  });

  it("accepts distinct definitions and dedupes aliases", () => {
    const validated = validateEventTypeDefinitions([
      { key: "finance", label: "财经", aliases: ["经济数据", "经济数据", "经济"] },
    ]);
    expect(validated[0]?.key).toBe("finance");
    expect(validated[0]?.aliases).toEqual(["经济数据", "经济"]);
  });
});

describe("registry fingerprint", () => {
  it("is deterministic and independent of id/order-insensitive metadata", () => {
    const left = snapshotOf([
      { key: "finance", label: "财经", aliases: ["经济数据"], sortOrder: 0 },
      { key: "other", label: "其他", sortOrder: 1 },
    ]);
    const right = snapshotOf([
      { key: "other", label: "其他", sortOrder: 1 },
      { key: "finance", label: "财经", aliases: ["经济数据"], sortOrder: 0 },
    ]);
    expect(left.fingerprint).toBe(right.fingerprint);
    expect(left.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when definitions change", () => {
    const before = snapshotOf([{ key: "finance", label: "财经" }]);
    const after = snapshotOf([{ key: "finance", label: "财经（改）" }]);
    expect(before.fingerprint).not.toBe(after.fingerprint);

    const disabled = snapshotOf([{ key: "finance", label: "财经", enabled: false }]);
    expect(before.fingerprint).not.toBe(disabled.fingerprint);
  });
});

describe("enabled resolver output mapping", () => {
  const snapshot = snapshotOf([
    { key: "finance", label: "财经", aliases: ["经济数据", "Economic Data"] },
    { key: "other", label: "其他" },
    { key: "legacy", label: "旧类型", enabled: false },
  ]);
  const resolver = buildEnabledEventTypeResolver(snapshot);

  it("maps keys and aliases to canonical keys", () => {
    expect(resolveEventTypeOutput("finance", resolver)).toMatchObject({ key: "finance", matched: true, rawValue: null });
    expect(resolveEventTypeOutput(" 经济数据 ", resolver)).toMatchObject({ key: "finance", matched: true });
    expect(resolveEventTypeOutput("economic data", resolver)).toMatchObject({ key: "finance", matched: true });
  });

  it("maps unknown and disabled outputs to other while preserving raw value", () => {
    expect(resolveEventTypeOutput("funding_round", resolver)).toMatchObject({ key: "other", matched: false, rawValue: "funding_round" });
    expect(resolveEventTypeOutput("legacy", resolver)).toMatchObject({ key: "other", matched: false, rawValue: "legacy" });
  });

  it("keeps empty values null (no fabricated other)", () => {
    expect(resolveEventTypeOutput(null, resolver)).toBeNull();
    expect(resolveEventTypeOutput("   ", resolver)).toBeNull();
  });

  it("falls back to stored key for labels, including disabled types", () => {
    expect(resolveEventTypeLabel("finance", snapshot.types)).toBe("财经");
    expect(resolveEventTypeLabel("legacy", snapshot.types)).toBe("旧类型");
    expect(resolveEventTypeLabel("unknown_key", snapshot.types)).toBe("unknown_key");
    expect(resolveEventTypeLabel(null, snapshot.types)).toBeNull();
  });
});
