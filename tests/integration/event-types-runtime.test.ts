import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { buildEventFingerprint } from "@/lib/clusters/identity";
import { normalizeStoredEventType } from "@/lib/clusters/normalization";
import {
  createEventType,
  getEventTypeRegistrySnapshot,
  invalidateEventTypeRegistryCache,
  updateEventType,
} from "@/lib/event-types/registry";
import { buildEnabledEventTypeResolver, resolveEventTypeOutput } from "@/lib/event-types/resolve";
import { buildDailyReportGenerationSignature } from "@/lib/daily-report/report-input";
import type { RuntimeConfig } from "@/config/runtime";

async function resetRegistry() {
  await prisma.eventType.deleteMany();
  invalidateEventTypeRegistryCache();
}

beforeEach(async () => {
  await resetRegistry();
});

afterEach(async () => {
  await resetRegistry();
});

describe("event type registry runtime", () => {
  it("keeps historical custom and disabled keys readable instead of nulling them", () => {
    expect(normalizeStoredEventType("economic_data")).toBe("economic_data");
    expect(normalizeStoredEventType("release")).toBe("release");
    expect(normalizeStoredEventType("  release ")).toBe("release");
    expect(normalizeStoredEventType(null)).toBeNull();
    expect(normalizeStoredEventType("   ")).toBeNull();
  });

  it("does not mutate fingerprints when registry definitions change", async () => {
    const finance = await createEventType({ key: "finance", label: "财经" });
    const signature = {
      eventType: "finance",
      eventSubject: "某公司",
      eventAction: "发布",
      eventObject: "产品X",
      eventDate: null,
    };
    const before = buildEventFingerprint(signature);

    await updateEventType(finance.id, { label: "财经（改）" });
    const after = buildEventFingerprint(signature);

    expect(before).toBe(after);
    // 历史指纹不被注册表变化自动改写。
    expect(before).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exposes a deterministic snapshot whose fingerprint changes with definitions", async () => {
    const finance = await createEventType({ key: "finance", label: "财经", aliases: ["经济数据"] });

    const first = await getEventTypeRegistrySnapshot();
    const second = await getEventTypeRegistrySnapshot();
    expect(first.fingerprint).toBe(second.fingerprint);

    await updateEventType(finance.id, { description: "财经与经济事件" });
    invalidateEventTypeRegistryCache();
    const changed = await getEventTypeRegistrySnapshot();
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("lets a configured finance type survive alias resolution while disabled types map to other", async () => {
    const finance = await createEventType({ key: "economic_data", label: "经济数据", aliases: ["经济数据"] });
    const snapshot = await getEventTypeRegistrySnapshot();
    const resolver = buildEnabledEventTypeResolver(snapshot);

    expect(resolveEventTypeOutput("经济数据", resolver)).toMatchObject({ key: "economic_data", matched: true });

    await updateEventType(finance.id, { enabled: false });
    invalidateEventTypeRegistryCache();
    const disabledResolver = buildEnabledEventTypeResolver(await getEventTypeRegistrySnapshot());
    expect(resolveEventTypeOutput("economic_data", disabledResolver))
      .toMatchObject({ key: "other", matched: false, rawValue: "economic_data" });

    // 历史 key 依然可读。
    expect(normalizeStoredEventType("economic_data")).toBe("economic_data");
  });

  it("folds the registry fingerprint into the daily report generation signature", async () => {
    const runtimeConfig = {
      modelApi: { apiKey: "k", baseURL: "https://api.test", model: "m" },
    } as RuntimeConfig;
    const base = {
      runtimeConfig,
      templateSignature: "tpl",
      planningBatchSize: null,
      recentTopicLookbackDays: 7,
    };

    await createEventType({ key: "finance", label: "财经" });
    invalidateEventTypeRegistryCache();
    const before = buildDailyReportGenerationSignature({ ...base, eventTypeRegistryFingerprint: (await getEventTypeRegistrySnapshot()).fingerprint });

    await prisma.eventType.update({ where: { key: "finance" }, data: { label: "财经金融" } });
    invalidateEventTypeRegistryCache();
    const after = buildDailyReportGenerationSignature({ ...base, eventTypeRegistryFingerprint: (await getEventTypeRegistrySnapshot()).fingerprint });

    expect(before).not.toBe(after);
  });

  it("does not overwrite runtime registry edits on re-seed", async () => {
    // 首次初始化播种默认。
    await getEventTypeRegistrySnapshot();
    const financeRow = await prisma.eventType.findUnique({ where: { key: "funding" } });
    expect(financeRow).not.toBeNull();

    await prisma.eventType.update({ where: { key: "funding" }, data: { label: "投融资", enabled: false } });
    invalidateEventTypeRegistryCache();

    // 再次 ensure（重启场景）：非空表不重播种。
    await getEventTypeRegistrySnapshot();
    const reloaded = await prisma.eventType.findUnique({ where: { key: "funding" } });
    expect(reloaded?.label).toBe("投融资");
    expect(reloaded?.enabled).toBe(false);
  });
});
