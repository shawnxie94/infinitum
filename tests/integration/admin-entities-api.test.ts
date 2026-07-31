import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";
import { executePrecomputeTask } from "@/lib/precompute/service";
import { precomputeEntitySuggestionCandidates } from "@/lib/entities/service";

const requireAdmin = vi.fn();

vi.mock("@/lib/admin/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin/session")>();

  return {
    ...actual,
    requireAdmin,
  };
});

async function createSourceAndItems() {
  const source = await prisma.source.create({
    data: {
      name: "Admin Tags",
      rssUrl: "https://admin-entities.example.com/feed.xml",
      siteUrl: "https://admin-entities.example.com",
      enabled: true,
      aiParsingEnabled: true,
    },
  });
  await prisma.item.createMany({
    data: [
      {
        id: "admin-entity-a",
        sourceId: source.id,
        originalUrl: "https://admin-entities.example.com/a",
        canonicalUrl: "https://admin-entities.example.com/a",
        urlHash: "admin-entity-a",
        originalTitle: "Admin Entity A",
        publishedAt: new Date("2026-04-10T10:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 80,
        qualityRationale: "ok",
        language: "en",
      },
      {
        id: "admin-entity-b",
        sourceId: source.id,
        originalUrl: "https://admin-entities.example.com/b",
        canonicalUrl: "https://admin-entities.example.com/b",
        urlHash: "admin-entity-b",
        originalTitle: "Admin Entity B",
        publishedAt: new Date("2026-04-10T10:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 80,
        qualityRationale: "ok",
        language: "en",
      },
    ],
  });

  return source;
}

async function createAdminEntityItem(sourceId: string, id: string) {
  await prisma.item.create({
    data: {
      id,
      sourceId,
      originalUrl: `https://admin-entities.example.com/${id}`,
      canonicalUrl: `https://admin-entities.example.com/${id}`,
      urlHash: id,
      originalTitle: id,
      publishedAt: new Date("2026-04-10T10:00:00.000Z"),
      status: "processed",
      moderationStatus: "allowed",
      qualityScore: 80,
      qualityRationale: "ok",
      language: "en",
    },
  });
}

describe("/api/admin/settings/entities", () => {
  beforeEach(async () => {
    requireAdmin.mockResolvedValue(undefined);
    await prisma.item.deleteMany();
    await prisma.backgroundTaskRun.deleteMany();
    await prisma.entitySuggestionCandidate.deleteMany();
    await prisma.entitySuggestionDecision.deleteMany();
    await prisma.entity.deleteMany();
    await prisma.source.deleteMany();
  });

  it("lists entities with usage and aliases for admins", async () => {
    await createSourceAndItems();
    const entity = await prisma.entity.create({
      data: {
        name: "AI Agent",
        normalized: "ai agent",
      },
    });
    await prisma.itemEntity.create({
      data: {
        itemId: "admin-entity-a",
        entityId: entity.id,
      },
    });
    await prisma.entityAlias.create({
      data: {
        entityId: entity.id,
        aliasName: "智能体",
        aliasNormalized: "智能体",
      },
    });

    const { GET } = await import("@/app/api/admin/settings/entities/route");
    const response = await GET(new Request("http://localhost/api/admin/settings/entities?search=智能体"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.totalCount).toBe(1);
    expect(json.entities[0]).toMatchObject({
      name: "AI Agent",
      normalized: "ai agent",
      itemCount: 1,
      aliasCount: 1,
    });
    expect(json.entities[0].aliases[0].aliasName).toBe("智能体");
  });

  it("sorts admin entities by the requested list order", async () => {
    await createSourceAndItems();
    const beta = await prisma.entity.create({
      data: {
        name: "Beta Entity",
        normalized: "beta entity",
      },
    });
    await prisma.entity.create({
      data: {
        name: "Alpha Entity",
        normalized: "alpha entity",
      },
    });
    await prisma.itemEntity.createMany({
      data: [
        {
          itemId: "admin-entity-a",
          entityId: beta.id,
        },
        {
          itemId: "admin-entity-b",
          entityId: beta.id,
        },
      ],
    });

    const { GET } = await import("@/app/api/admin/settings/entities/route");
    const response = await GET(new Request("http://localhost/api/admin/settings/entities?sort=name_asc&page=1&pageSize=10"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.entities.map((entity: { name: string }) => entity.name)).toEqual(["Alpha Entity", "Beta Entity"]);
  });

  it("adds aliases through the admin endpoint", async () => {
    const entity = await prisma.entity.create({
      data: {
        name: "AI Agent",
        normalized: "ai agent",
      },
    });

    const { POST } = await import("@/app/api/admin/settings/entities/aliases/route");
    const response = await POST(new Request("http://localhost/api/admin/settings/entities/aliases", {
      method: "POST",
      body: JSON.stringify({
        entityId: entity.id,
        aliasName: "智能体",
      }),
    }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.alias.aliasNormalized).toBe("智能体");
  });

  it("lists and suppresses entity governance suggestions for admins", async () => {
    await createSourceAndItems();
    const canonical = await prisma.entity.create({
      data: {
        name: "OpenAI",
        normalized: "openai",
      },
    });
    const variant = await prisma.entity.create({
      data: {
        name: "Open AI",
        normalized: "open ai",
      },
    });
    await prisma.itemEntity.createMany({
      data: [
        {
          itemId: "admin-entity-a",
          entityId: canonical.id,
        },
        {
          itemId: "admin-entity-b",
          entityId: variant.id,
        },
      ],
    });
    await precomputeEntitySuggestionCandidates();

    const { GET, POST } = await import("@/app/api/admin/settings/entities/suggestions/route");
    const response = await GET(new Request("http://localhost/api/admin/settings/entities/suggestions?search=open&page=1&pageSize=10"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.totalCount).toBe(1);
    expect(json.page).toBe(1);
    expect(json.pageSize).toBe(10);
    expect(json.suggestions[0]).toMatchObject({
      sourceEntity: {
        id: variant.id,
        name: "Open AI",
      },
      targetEntity: {
        id: canonical.id,
        name: "OpenAI",
      },
      affectedItemCount: 1,
    });
    expect(json.suggestions[0].confidence).toBeGreaterThanOrEqual(0.95);

    const dismissResponse = await POST(new Request("http://localhost/api/admin/settings/entities/suggestions", {
      method: "POST",
      body: JSON.stringify({
        sourceEntityId: variant.id,
        targetEntityId: canonical.id,
        decision: "kept",
      }),
    }));

    expect(dismissResponse.status).toBe(200);
    await expect(prisma.entitySuggestionDecision.findUnique({
      where: {
        sourceEntityNormalized_targetEntityNormalized: {
          sourceEntityNormalized: "open ai",
          targetEntityNormalized: "openai",
        },
      },
    })).resolves.toMatchObject({ decision: "kept" });

    const suppressedResponse = await GET(new Request("http://localhost/api/admin/settings/entities/suggestions?search=open&page=1&pageSize=10"));
    const suppressedJson = await suppressedResponse.json();
    expect(suppressedJson.totalCount).toBe(0);
  });

  it("sorts entity governance suggestions by affected item count before pagination", async () => {
    const source = await createSourceAndItems();
    await Promise.all([
      createAdminEntityItem(source.id, "admin-entity-c"),
      createAdminEntityItem(source.id, "admin-entity-d"),
      createAdminEntityItem(source.id, "admin-entity-e"),
      createAdminEntityItem(source.id, "admin-entity-f"),
      createAdminEntityItem(source.id, "admin-entity-g"),
      createAdminEntityItem(source.id, "admin-entity-h"),
    ]);
    const openAi = await prisma.entity.create({
      data: {
        name: "OpenAI",
        normalized: "openai",
      },
    });
    const openAiVariant = await prisma.entity.create({
      data: {
        name: "Open AI",
        normalized: "open ai",
      },
    });
    const aiAgent = await prisma.entity.create({
      data: {
        name: "AI Agent",
        normalized: "ai agent",
      },
    });
    const aiAgents = await prisma.entity.create({
      data: {
        name: "AI Agents",
        normalized: "ai agents",
      },
    });
    await prisma.itemEntity.createMany({
      data: [
        { itemId: "admin-entity-a", entityId: openAi.id },
        { itemId: "admin-entity-c", entityId: openAi.id },
        { itemId: "admin-entity-d", entityId: openAi.id },
        { itemId: "admin-entity-e", entityId: openAi.id },
        { itemId: "admin-entity-b", entityId: openAiVariant.id },
        { itemId: "admin-entity-f", entityId: openAiVariant.id },
        { itemId: "admin-entity-g", entityId: openAiVariant.id },
        { itemId: "admin-entity-a", entityId: aiAgent.id },
        { itemId: "admin-entity-c", entityId: aiAgent.id },
        { itemId: "admin-entity-d", entityId: aiAgent.id },
        { itemId: "admin-entity-e", entityId: aiAgent.id },
        { itemId: "admin-entity-h", entityId: aiAgent.id },
        { itemId: "admin-entity-b", entityId: aiAgents.id },
        { itemId: "admin-entity-f", entityId: aiAgents.id },
        { itemId: "admin-entity-g", entityId: aiAgents.id },
        { itemId: "admin-entity-h", entityId: aiAgents.id },
      ],
    });
    await precomputeEntitySuggestionCandidates();

    const { GET } = await import("@/app/api/admin/settings/entities/suggestions/route");
    const response = await GET(new Request("http://localhost/api/admin/settings/entities/suggestions?sort=affected_desc&page=1&pageSize=1"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.totalCount).toBe(2);
    expect(json.suggestions).toHaveLength(1);
    expect(json.suggestions[0]).toMatchObject({
      sourceEntity: {
        id: aiAgents.id,
        name: "AI Agents",
      },
      targetEntity: {
        id: aiAgent.id,
        name: "AI Agent",
      },
      affectedItemCount: 4,
    });
  });

  it("auto-merges high-confidence existing entity suggestions for admins", async () => {
    await createSourceAndItems();
    const canonical = await prisma.entity.create({
      data: {
        name: "OpenAI",
        normalized: "openai",
      },
    });
    const variant = await prisma.entity.create({
      data: {
        name: "Open AI",
        normalized: "open ai",
      },
    });
    await prisma.itemEntity.createMany({
      data: [
        {
          itemId: "admin-entity-a",
          entityId: canonical.id,
        },
        {
          itemId: "admin-entity-b",
          entityId: variant.id,
        },
      ],
    });

    const { POST } = await import("@/app/api/admin/settings/entities/suggestions/route");
    const response = await POST(new Request("http://localhost/api/admin/settings/entities/suggestions", {
      method: "POST",
      body: JSON.stringify({
        action: "auto_merge_high_confidence",
      }),
    }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      scannedCount: 1,
      mergedCount: 1,
      failedCount: 0,
    });
    await expect(prisma.entity.findMany({
      include: {
        aliases: true,
        items: true,
      },
    })).resolves.toEqual([
      expect.objectContaining({
        id: canonical.id,
        normalized: "openai",
        aliases: [
          expect.objectContaining({
            aliasNormalized: "open ai",
            createdBy: "system:auto-merge",
          }),
        ],
        items: expect.arrayContaining([
          expect.objectContaining({ itemId: "admin-entity-a" }),
          expect.objectContaining({ itemId: "admin-entity-b" }),
        ]),
      }),
    ]);
  });

  it("runs generic precompute tasks and stores entity governance candidates", async () => {
    await createSourceAndItems();
    const canonical = await prisma.entity.create({
      data: {
        name: "OpenAI",
        normalized: "openai",
      },
    });
    const variant = await prisma.entity.create({
      data: {
        name: "Open AI",
        normalized: "open ai",
      },
    });
    await prisma.itemEntity.createMany({
      data: [
        {
          itemId: "admin-entity-a",
          entityId: canonical.id,
        },
        {
          itemId: "admin-entity-b",
          entityId: variant.id,
        },
      ],
    });
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "precompute",
        triggerType: "manual",
        status: "queued",
        label: "预计算",
      },
    });

    await executePrecomputeTask(taskRun);

    await expect(prisma.entitySuggestionCandidate.findMany()).resolves.toEqual([
      expect.objectContaining({
        sourceEntityId: variant.id,
        targetEntityId: canonical.id,
        confidence: expect.any(Number),
        affectedItemCount: 1,
      }),
    ]);
    await expect(prisma.backgroundTaskRun.findUnique({
      where: { id: taskRun.id },
    })).resolves.toMatchObject({
      status: "succeeded",
      progressCurrent: 2,
      progressTotal: 2,
    });
  });

  it("keeps entity governance suggestion scans bounded for large entity sets", async () => {
    await prisma.entity.createMany({
      data: [
        ...Array.from({ length: 600 }, (_, index) => ({
          name: `Unrelated Topic ${index}`,
          normalized: `unrelated topic ${index}`,
        })),
        {
          name: "AI Agent",
          normalized: "ai agent",
        },
        {
          name: "AI Agents",
          normalized: "ai agents",
        },
      ],
    });

    const precomputeStartedAt = performance.now();
    const precomputeResult = await precomputeEntitySuggestionCandidates();
    const precomputeElapsedMs = performance.now() - precomputeStartedAt;
    expect(precomputeElapsedMs).toBeLessThan(1_500);
    expect(precomputeResult.storedCandidates).toBeGreaterThanOrEqual(1);

    const { GET } = await import("@/app/api/admin/settings/entities/suggestions/route");
    const startedAt = performance.now();
    const response = await GET(new Request("http://localhost/api/admin/settings/entities/suggestions?search=Agent&sort=confidence_desc&page=1&pageSize=10"));
    const elapsedMs = performance.now() - startedAt;
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(elapsedMs).toBeLessThan(1_500);
    expect(json.totalCount).toBeGreaterThanOrEqual(1);
    expect(json.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceEntity: expect.objectContaining({ name: "AI Agents" }),
          targetEntity: expect.objectContaining({ name: "AI Agent" }),
        }),
      ]),
    );
  });
});
