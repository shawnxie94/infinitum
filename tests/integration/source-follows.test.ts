import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";
import { followXueqiuUser } from "@/lib/sources/xueqiu";
import { listDailyReportGenerationCandidates } from "@/lib/daily-report/candidates";
import { listDailyReportCandidates } from "@/lib/daily-report/repository";
import { listEventBriefingEntriesForDailyReport } from "@/lib/events/service";
import {
  followSource,
  listSourceCatalog,
  listSourceCatalogChannels,
  SOURCE_CHANNEL_OTHER,
  unfollowSource,
} from "@/lib/sources/follows";

const DATE = "2026-06-30";

async function seedFollowScenario() {
  const sourceA = await prisma.source.create({
    data: {
      id: "source-follow-a",
      name: "Follow A",
      rssUrl: "https://follow-a.example.com/feed.xml",
      siteUrl: "https://follow-a.example.com",
      channel: "雪球",
    },
  });
  const sourceB = await prisma.source.create({
    data: {
      id: "source-follow-b",
      name: "Follow B",
      rssUrl: "https://follow-b.example.com/feed.xml",
      siteUrl: "https://follow-b.example.com",
    },
  });
  const sourceC = await prisma.source.create({
    data: {
      id: "source-follow-c",
      name: "Unfollow C",
      rssUrl: "https://follow-c.example.com/feed.xml",
      siteUrl: "https://follow-c.example.com",
    },
  });

  await prisma.contentCluster.create({
    data: {
      id: "cluster-follow",
      title: "全局聚类标题含未关注源独有信息",
      summary: "未关注源 C 独有的全局摘要信息不应进入日报。",
      score: 99,
      itemCount: 3,
      latestPublishedAt: new Date(`${DATE}T07:30:00.000Z`),
      fingerprint: "cluster-follow",
      displayItemCount: 3,
      displaySourceCount: 3,
      displayAverageScore: 99,
      eventType: "launch",
      latestCreatedAt: new Date(`${DATE}T08:00:00.000Z`),
    },
  });

  await prisma.item.createMany({
    data: [
      {
        id: "item-follow-source-follow-a",
        sourceId: sourceA.id,
        clusterId: "cluster-follow",
        originalUrl: `https://${sourceA.id}.example.com/story`,
        canonicalUrl: `https://${sourceA.id}.example.com/story`,
        urlHash: `hash-follow-${sourceA.id}`,
        originalTitle: "Follow A 的报道",
        publishedAt: new Date(`${DATE}T07:00:00.000Z`),
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 82,
        createdAt: new Date(`${DATE}T07:50:00.000Z`),
        // 代表条目无事件字段：followScoped 不得回退到聚类全局事件（可能来自未关注源）。
        eventType: null,
      },
      {
        id: "item-follow-source-follow-b",
        sourceId: sourceB.id,
        clusterId: "cluster-follow",
        originalUrl: `https://${sourceB.id}.example.com/story`,
        canonicalUrl: `https://${sourceB.id}.example.com/story`,
        urlHash: `hash-follow-${sourceB.id}`,
        originalTitle: "Follow B 的报道",
        publishedAt: new Date(`${DATE}T07:01:00.000Z`),
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 80,
        createdAt: new Date(`${DATE}T07:51:00.000Z`),
        eventType: "release",
      },
      {
        id: "item-follow-source-follow-c",
        sourceId: sourceC.id,
        clusterId: "cluster-follow",
        originalUrl: `https://${sourceC.id}.example.com/story`,
        canonicalUrl: `https://${sourceC.id}.example.com/story`,
        urlHash: `hash-follow-${sourceC.id}`,
        originalTitle: "Unfollow C 独家爆料",
        publishedAt: new Date(`${DATE}T07:02:00.000Z`),
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 98,
        createdAt: new Date(`${DATE}T07:52:00.000Z`),
        eventType: "rumor",
      },
    ],
  });

  return { sourceA, sourceB, sourceC };
}

describe("source follows and daily report follow snapshot", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.sourceFollow.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();
    await prisma.eventBriefingConfig.deleteMany();
  });

  afterEach(() => { vi.restoreAllMocks(); delete process.env.RSSHUB_BASE_URL; });

  it("账号新建与预置复用保留分类，目录和关注统一", async () => {
    process.env.RSSHUB_BASE_URL = "http://rsshub:1200";
    const preset = await prisma.source.create({ data: { name: "已有预置", rssUrl: "http://rsshub:1200/xueqiu/user/123", siteUrl: "https://xueqiu.com/u/123", enabled: false } });
    await followXueqiuUser("123");
    const reused = await prisma.source.findUniqueOrThrow({ where: { id: preset.id } });
    expect(reused.originKind).toBe("preset");
    expect(reused.enabled).toBe(false);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('<rss version="2.0"><channel><title>新账号 的雪球全部动态</title><link>https://xueqiu.com/u/456</link><description>动态</description></channel></rss>'));
    const account = await followXueqiuUser("456");
    await followXueqiuUser("456");
    expect(account.originKind).toBe("account");
    expect((await listSourceCatalog({ originKind: "preset" })).map((source) => source.id)).toEqual([preset.id]);
    const all = await listSourceCatalog();
    expect(all.filter((source) => source.followed).map((source) => source.id).sort()).toEqual([preset.id, account.id].sort());
    expect(await prisma.sourceFollow.count()).toBe(2);
    await unfollowSource(account.id);
    expect(await prisma.source.count()).toBe(2);
    expect((await prisma.source.findUniqueOrThrow({ where: { id: account.id } })).originKind).toBe("account");
  });

  it("filters cluster candidates and evidence to the followed snapshot only", async () => {
    const { sourceA } = await seedFollowScenario();

    const both = await listEventBriefingEntriesForDailyReport({
      date: DATE,
      followedSourceIds: [sourceA.id, "source-follow-b"],
    });
    expect(both).toHaveLength(1);
    expect(both[0].sourceCount).toBe(2);

    const onlyA = await listEventBriefingEntriesForDailyReport({
      date: DATE,
      followedSourceIds: [sourceA.id],
    });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].sourceCount).toBe(1);
    expect(onlyA[0].itemCount).toBe(1);
    for (const item of onlyA[0].items) {
      expect(item.sourceName).toBe("Follow A");
    }
  });

  it("returns no candidates for an empty follow snapshot and never falls back to all sources", async () => {
    await seedFollowScenario();

    const result = await listDailyReportGenerationCandidates(DATE, 20, [], [], []);
    expect(result.source).toBe("follow_empty");
    expect(result.candidates).toHaveLength(0);
  });

  it("keeps candidates limited to followed sources via the generation entrypoint", async () => {
    const { sourceA } = await seedFollowScenario();

    const result = await listDailyReportGenerationCandidates(DATE, 20, [], [], [sourceA.id]);
    expect(result.source).toBe("event_briefing");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].sourceName).toBe("Follow A");
    for (const evidence of result.candidates[0].evidenceItems ?? []) {
      expect(evidence.sourceName).toBe("Follow A");
    }
  });

  it("keeps cluster candidates scoped to followed members for title, summary, counts, events and search text", async () => {
    const { sourceA } = await seedFollowScenario();

    const entries = await listEventBriefingEntriesForDailyReport({
      date: DATE,
      followedSourceIds: [sourceA.id, "source-follow-b"],
    });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    // 标题/摘要来自关注成员，不使用含未关注源独有信息的全局聚类字段。
    expect(entry.title).not.toContain("未关注源 C");
    expect(entry.summary).not.toContain("独有");
    expect(entry.sourceCount).toBe(2);
    expect(entry.itemCount).toBe(2);
    // 评分按关注成员，不被未关注源的高分（98）抬高。
    expect(entry.qualityScore).toBeLessThanOrEqual(82);
    // 事件字段来自关注成员，不继承全局聚类的未关注事件信息。
    expect(entry.eventType).not.toBe("rumor");
    expect(entry.items.every((item) => item.sourceName !== "Unfollow C")).toBe(true);
    expect(JSON.stringify(entry)).not.toContain("Unfollow C");
  });

  it("filters legacy daily report candidates in the database before aggregation and truncation", async () => {
    const { sourceA } = await seedFollowScenario();

    const candidates = await listDailyReportCandidates(DATE, 20, [], {
      returnPool: true,
      followedSourceIds: [sourceA.id, "source-follow-b"],
    });
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    expect(candidate.sourceCount).toBe(2);
    expect(candidate.itemCount).toBe(2);
    expect(candidate.title).not.toContain("未关注源 C");
    expect(candidate.summary).not.toContain("独有");
    expect(JSON.stringify(candidate)).not.toContain("Unfollow C");
    expect(JSON.stringify(candidate)).not.toContain("rumor");
    // 代表条目 eventType 为空时不得回退聚类全局事件字段（rumor 来自未关注源侧聚合）。
    expect(candidate.eventType).toBeNull();
    expect(candidate.eventSubject).toBeNull();

    // 空关注快照：无输入而非全量。
    const empty = await listDailyReportCandidates(DATE, 20, [], {
      returnPool: true,
      followedSourceIds: [],
    });
    expect(empty).toHaveLength(0);
  });

  it("tracks follow state, normalizes unknown channels and never touches source enabled state", async () => {
    const { sourceA, sourceB, sourceC } = await seedFollowScenario();

    await followSource(sourceA.id);
    await followSource(sourceA.id);

    let catalog = await listSourceCatalog();
    expect(catalog.find((source) => source.id === sourceA.id)?.followed).toBe(true);
    expect(catalog.find((source) => source.id === sourceB.id)?.followed).toBe(false);

    catalog = await listSourceCatalog({ channel: "雪球" });
    expect(catalog.map((source) => source.id)).toEqual([sourceA.id]);
    catalog = await listSourceCatalog({ channel: SOURCE_CHANNEL_OTHER });
    expect(catalog.map((source) => source.id)).toEqual([sourceB.id, sourceC.id]);
    expect(listSourceCatalogChannels(await listSourceCatalog())).toEqual(["雪球", SOURCE_CHANNEL_OTHER]);

    const sourceAfterFollow = await prisma.source.findUniqueOrThrow({ where: { id: sourceA.id } });
    expect(sourceAfterFollow.enabled).toBe(true);

    await unfollowSource(sourceA.id);
    expect(await prisma.sourceFollow.count()).toBe(0);
    expect(await prisma.source.count()).toBe(3);
  });
});
