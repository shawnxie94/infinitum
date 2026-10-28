import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";

const requireAdmin = vi.fn();

vi.mock("@/lib/admin/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin/session")>();

  return {
    ...actual,
    requireAdmin,
  };
});

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureEventTypesRegistrySeeded, invalidateEventTypeRegistryCache } from "@/lib/event-types/registry";

async function routeModules() {
  const list = await import("@/app/api/admin/event-types/route");
  const item = await import("@/app/api/admin/event-types/[id]/route");
  const publicRoute = await import("@/app/api/event-types/route");
  return {
    listEventTypesRoute: list.GET,
    createEventTypeRoute: list.POST,
    reorderEventTypesRoute: list.PUT,
    patchEventTypeRoute: item.PATCH,
    deleteEventTypeRoute: item.DELETE,
    publicEventTypesRoute: publicRoute.GET,
  };
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, { method, body: JSON.stringify(body) });
}

async function createViaApi(create: (request: Request) => Promise<Response>, body: Record<string, unknown>) {
  const response = await create(jsonRequest("http://localhost.test/admin/event-types", "POST", body));
  return { response, payload: await response.json().catch(() => ({})) as Record<string, unknown> };
}

beforeEach(async () => {
  requireAdmin.mockResolvedValue(undefined);
  await prisma.item.deleteMany();
  await prisma.contentCluster.deleteMany();
  await prisma.source.deleteMany();
  await prisma.eventType.deleteMany();
  invalidateEventTypeRegistryCache();
});

afterEach(async () => {
  await prisma.item.deleteMany();
  await prisma.contentCluster.deleteMany();
  await prisma.source.deleteMany();
  await prisma.eventType.deleteMany();
  invalidateEventTypeRegistryCache();
  vi.clearAllMocks();
});

describe("event types admin API", () => {
  it("requires an admin session", async () => {
    const { listEventTypesRoute } = await routeModules();
    requireAdmin.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));

    const response = await listEventTypesRoute();

    expect(response.status).toBe(401);
  });

  it("seeds the legacy ten defaults when the registry is empty", async () => {
    const { listEventTypesRoute } = await routeModules();
    const response = await listEventTypesRoute();
    const { eventTypes } = (await response.json()) as { eventTypes: Array<{ key: string }> };

    expect(eventTypes.map((type) => type.key)).toEqual([
      "release", "launch", "update", "funding", "acquisition",
      "partnership", "policy", "research", "security", "other",
    ]);
  });

  it("creates a type with a derived machine key and exposes it publicly", async () => {
    const { createEventTypeRoute, publicEventTypesRoute } = await routeModules();
    const { response, payload } = await createViaApi(createEventTypeRoute, { label: "Economic Data", aliases: ["经济数据"] });
    expect(response.status).toBe(201);
    expect(payload.eventType).toMatchObject({ key: "economic-data", label: "Economic Data" });

    const publicResponse = await publicEventTypesRoute();
    const publicPayload = await publicResponse.json() as { eventTypes: Array<{ key: string }> };
    expect(publicPayload.eventTypes.map((type) => type.key)).toContain("economic-data");
  });

  it("rejects duplicate keys and alias collisions with clear errors", async () => {
    const { createEventTypeRoute } = await routeModules();
    await createViaApi(createEventTypeRoute, { label: "财经", key: "finance", aliases: ["经济数据"] });

    const duplicate = await createViaApi(createEventTypeRoute, { label: "另一个财经", key: "finance" });
    expect(duplicate.response.status).toBe(400);
    expect(String(duplicate.payload.code)).toBe("duplicate_key");

    const aliasConflict = await createViaApi(createEventTypeRoute, { label: "宏观", key: "macro", aliases: ["经济数据"] });
    expect(aliasConflict.response.status).toBe(400);
    expect(String(aliasConflict.payload.code)).toBe("alias_conflict");
  });

  it("protects the other type from disable and delete", async () => {
    const { listEventTypesRoute, patchEventTypeRoute, deleteEventTypeRoute } = await routeModules();
    const list = await (await listEventTypesRoute()).json() as { eventTypes: Array<{ id: string; key: string }> };
    const other = list.eventTypes.find((type) => type.key === "other")!;

    const disable = await patchEventTypeRoute(
      jsonRequest("http://localhost.test/admin/event-types/x", "PATCH", { enabled: false }),
      routeContext(other.id),
    );
    expect(disable.status).toBe(409);

    const remove = await deleteEventTypeRoute(
      new Request("http://localhost.test/admin/event-types/x", { method: "DELETE" }),
      routeContext(other.id),
    );
    expect(remove.status).toBe(409);

    // other 兑底不可被任何直接更新修改（label/description/aliases/sortOrder）。
    const relabel = await patchEventTypeRoute(
      jsonRequest("http://localhost.test/admin/event-types/x", "PATCH", { label: "新其他", description: "x", aliases: ["a"], sortOrder: 99 }),
      routeContext(other.id),
    );
    expect(relabel.status).toBe(409);

    const after = await (await listEventTypesRoute()).json() as { eventTypes: Array<{ key: string; label: string; description: string | null; aliases: string[]; sortOrder: number }> };
    const otherAfter = after.eventTypes.find((type) => type.key === "other")!;
    expect(otherAfter.label).toBe("其他");
    expect(otherAfter.description).toBeNull();
    expect(otherAfter.aliases).toEqual([]);
  });

  it("keeps keys immutable on update", async () => {
    const { createEventTypeRoute, patchEventTypeRoute } = await routeModules();
    const { payload } = await createViaApi(createEventTypeRoute, { label: "财经", key: "finance" });
    const created = payload.eventType as { id: string };

    const response = await patchEventTypeRoute(
      jsonRequest("http://localhost.test/admin/event-types/x", "PATCH", { key: "macro" }),
      routeContext(created.id),
    );
    expect(response.status).toBe(409);
    expect(String((await response.json()).code)).toBe("immutable_key");
  });

  it("deactivates instead of deleting referenced types", async () => {
    const { createEventTypeRoute, patchEventTypeRoute, deleteEventTypeRoute } = await routeModules();
    const { payload } = await createViaApi(createEventTypeRoute, { label: "财经", key: "finance" });
    const created = payload.eventType as { id: string; key: string };

    const source = await prisma.source.create({
      data: { name: "源", rssUrl: "https://example.com/feed.xml", siteUrl: "https://example.com", enabled: true },
    });
    await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://example.com/a",
        canonicalUrl: "https://example.com/a",
        urlHash: "hash-finance-ref",
        originalTitle: "标题",
        publishedAt: new Date(),
        eventType: created.key,
      },
    });

    const remove = await deleteEventTypeRoute(
      new Request("http://localhost.test/admin/event-types/x", { method: "DELETE" }),
      routeContext(created.id),
    );
    expect(remove.status).toBe(409);
    expect(String((await remove.json()).code)).toBe("type_in_use");

    const disable = await patchEventTypeRoute(
      jsonRequest("http://localhost.test/admin/event-types/x", "PATCH", { enabled: false }),
      routeContext(created.id),
    );
    expect(disable.status).toBe(200);
  });

  it("initializes the registry on first POST before any GET and guarantees other", async () => {
    const { createEventTypeRoute, listEventTypesRoute } = await routeModules();
    // 故意先 POST：CRUD 必须在首次读之前完成初始化并兜底 other。
    const { response, payload } = await createViaApi(createEventTypeRoute, { label: "财经", key: "finance" });
    expect(response.status).toBe(201);

    const list = await (await listEventTypesRoute()).json() as { eventTypes: Array<{ key: string; enabled: boolean }> };
    const keys = list.eventTypes.map((type) => type.key);
    expect(keys).toContain("finance");
    expect(list.eventTypes.find((type) => type.key === "other")).toMatchObject({ enabled: true });
    expect(payload.eventType).toMatchObject({ key: "finance" });
  });

  it("seeds a custom bootstrap with only economic_data and still guarantees other enabled", async () => {
    const { listEventTypesRoute } = await routeModules();
    const dir = mkdtempSync(join(tmpdir(), "et-bootstrap-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ eventTypes: [{ key: "economic_data", label: "经济数据" }] }));
    const previous = process.env.INFINITUM_CONFIG_PATH;
    process.env.INFINITUM_CONFIG_PATH = configPath;

    try {
      await ensureEventTypesRegistrySeeded();
      const list = await (await listEventTypesRoute()).json() as { eventTypes: Array<{ key: string; enabled: boolean; label: string }> };
      const keys = list.eventTypes.map((type) => type.key);
      expect(keys).toEqual(["economic_data", "other"]);
      expect(list.eventTypes.find((type) => type.key === "other")).toMatchObject({ enabled: true });
      expect(list.eventTypes.find((type) => type.key === "economic_data")).toMatchObject({ label: "经济数据" });
    } finally {
      if (previous === undefined) delete process.env.INFINITUM_CONFIG_PATH;
      else process.env.INFINITUM_CONFIG_PATH = previous;
      invalidateEventTypeRegistryCache();
    }
  });

  it("rejects an explicit invalid bootstrap (disabled other) instead of falling back to defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "et-bootstrap-bad-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ eventTypes: [{ key: "other", label: "其他", enabled: false }] }));
    const previous = process.env.INFINITUM_CONFIG_PATH;
    process.env.INFINITUM_CONFIG_PATH = configPath;

    try {
      await expect(ensureEventTypesRegistrySeeded()).rejects.toThrow(/other/);
      expect(await prisma.eventType.count()).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.INFINITUM_CONFIG_PATH;
      else process.env.INFINITUM_CONFIG_PATH = previous;
      invalidateEventTypeRegistryCache();
    }
  });

  it("preserves custom rows across two initialization starts", async () => {
    const { createEventTypeRoute } = await routeModules();
    await createViaApi(createEventTypeRoute, { label: "财经", key: "finance" });
    await ensureEventTypesRegistrySeeded();
    await ensureEventTypesRegistrySeeded();

    const finance = await prisma.eventType.findUnique({ where: { key: "finance" } });
    expect(finance?.label).toBe("财经");
    expect(await prisma.eventType.count()).toBe(11);
  });

  it("re-enables a disabled other on the next initialization path without rewriting its label", async () => {
    await prisma.eventType.create({
      data: { key: "other", label: "自定义其他", enabled: false, sortOrder: 0 },
    });
    invalidateEventTypeRegistryCache();

    await ensureEventTypesRegistrySeeded();
    const other = await prisma.eventType.findUnique({ where: { key: "other" } });
    expect(other).toMatchObject({ enabled: true, label: "自定义其他" });
  });

  it("seeds safely under concurrent initialization", async () => {
    await Promise.all(Array.from({ length: 5 }, () => ensureEventTypesRegistrySeeded()));
    expect(await prisma.eventType.count()).toBe(10);
    const other = await prisma.eventType.findUnique({ where: { key: "other" } });
    expect(other).toMatchObject({ enabled: true });
  });

  it("maps concurrent duplicate creates to a single success plus a duplicate_key error", async () => {
    const { createEventTypeRoute } = await routeModules();
    // 路由层把校验错误映射为 4xx 响应，因此并发结果以状态码区分。
    const responses = await Promise.all([
      createEventTypeRoute(jsonRequest("http://localhost.test/admin/event-types", "POST", { label: "财经", key: "finance" })),
      createEventTypeRoute(jsonRequest("http://localhost.test/admin/event-types", "POST", { label: "财经二", key: "finance" })),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 400]);
    expect(await prisma.eventType.count({ where: { key: "finance" } })).toBe(1);
  });

  it("rejects reorder payloads with unknown, duplicate or missing keys", async () => {
    const { listEventTypesRoute, reorderEventTypesRoute } = await routeModules();
    const list = await (await listEventTypesRoute()).json() as { eventTypes: Array<{ key: string }> };
    const keys = list.eventTypes.map((type) => type.key);

    const withUnknown = [...keys, "ghost_key"];
    const unknownResponse = await reorderEventTypesRoute(
      jsonRequest("http://localhost.test/admin/event-types", "PUT", { keys: withUnknown }),
    );
    expect(unknownResponse.status).toBe(400);

    const withDuplicate = [...keys, keys[0]!];
    const duplicateResponse = await reorderEventTypesRoute(
      jsonRequest("http://localhost.test/admin/event-types", "PUT", { keys: withDuplicate }),
    );
    expect(duplicateResponse.status).toBe(400);

    const incomplete = keys.slice(1);
    const incompleteResponse = await reorderEventTypesRoute(
      jsonRequest("http://localhost.test/admin/event-types", "PUT", { keys: incomplete }),
    );
    expect(incompleteResponse.status).toBe(400);
  });

  it("exposes disabled types on the public endpoint so historical labels stay configured", async () => {
    const { createEventTypeRoute, patchEventTypeRoute, publicEventTypesRoute } = await routeModules();
    const { payload } = await createViaApi(createEventTypeRoute, { label: "经济数据", key: "economic_data" });
    const created = payload.eventType as { id: string };

    await patchEventTypeRoute(
      jsonRequest("http://localhost.test/admin/event-types/x", "PATCH", { enabled: false }),
      routeContext(created.id),
    );

    const publicPayload = await (await publicEventTypesRoute()).json() as {
      eventTypes: Array<{ key: string; label: string; enabled: boolean }>;
    };
    const disabled = publicPayload.eventTypes.find((type) => type.key === "economic_data");
    expect(disabled).toMatchObject({ key: "economic_data", label: "经济数据", enabled: false });
  });

  it("reorders types and persists the custom registry across restarts", async () => {
    const { createEventTypeRoute, listEventTypesRoute, reorderEventTypesRoute } = await routeModules();
    await createViaApi(createEventTypeRoute, { label: "财经", key: "finance", sortOrder: 100 });
    const list = await (await listEventTypesRoute()).json() as { eventTypes: Array<{ key: string }> };
    const keys = list.eventTypes.map((type) => type.key);
    keys.reverse();

    const reordered = await reorderEventTypesRoute(
      jsonRequest("http://localhost.test/admin/event-types", "PUT", { keys }),
    );
    expect(reordered.status).toBe(200);

    // Simulate restart: clear the in-memory cache and read the snapshot again.
    invalidateEventTypeRegistryCache();
    const reloaded = await (await listEventTypesRoute()).json() as { eventTypes: Array<{ key: string }> };
    expect(reloaded.eventTypes.map((type) => type.key)).toEqual(keys);
  });
});
