import { beforeEach, describe, expect, it } from "vitest";

import {
  acceptBriefingPreferenceSuggestion,
  generateBriefingPreferenceSuggestions,
  recordCuratorBehavior,
} from "@/lib/curator-behavior/service";
import { prisma } from "@/lib/db";
import { getEventBriefing } from "@/lib/events/service";
import { updateBriefingPreferenceConfig, updateEventBriefingConfig } from "@/lib/settings/service";

describe("event briefing service", () => {
  beforeEach(async () => {
    await prisma.briefingPreferenceSuggestion.deleteMany();
    await prisma.curatorBehaviorDimension.deleteMany();
    await prisma.curatorBehaviorEvent.deleteMany();
    await prisma.itemEntity.deleteMany();
    await prisma.entity.deleteMany();
    await prisma.item.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();
    await prisma.eventBriefingConfig.deleteMany();
    await prisma.briefingPreferenceConfig.deleteMany();
  });

  it("turns curator behavior snapshots into accepted briefing preference rules", async () => {
    const group = await prisma.sourceGroup.create({
      data: { id: "group-ai-behavior", name: "AI", sortOrder: 0 },
    });
    const source = await prisma.source.create({
      data: {
        id: "source-ai-behavior",
        name: "AI Blog",
        rssUrl: "https://behavior.example.com/feed.xml",
        siteUrl: "https://behavior.example.com",
        groupId: group.id,
      },
    });
    const entity = await prisma.entity.create({
      data: { id: "entity-ai-behavior", name: "AI Coding", normalized: "ai-coding" },
    });
    await prisma.item.create({
      data: {
        id: "item-ai-behavior",
        sourceId: source.id,
        originalUrl: "https://behavior.example.com/openai-agent",
        canonicalUrl: "https://behavior.example.com/openai-agent",
        urlHash: "hash-ai-behavior",
        originalTitle: "OpenAI Agent tools",
        translatedTitle: "OpenAI 发布 Agent 工具",
        publishedAt: new Date("2026-06-30T07:30:00.000Z"),
        summaryText: "OpenAI 发布面向开发者的 Agent 工具。",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 88,
        eventType: "launch",
        eventSubject: "OpenAI",
        eventObject: "Agent tools",
        createdAt: new Date("2026-06-30T08:00:00.000Z"),
      },
    });
    await prisma.itemEntity.create({
      data: { itemId: "item-ai-behavior", entityId: entity.id },
    });

    await recordCuratorBehavior({
      eventType: "feed_item_opened",
      targetType: "item",
      targetId: "item-ai-behavior",
      occurredAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    await recordCuratorBehavior({
      eventType: "event_source_clicked",
      targetType: "item",
      targetId: "item-ai-behavior",
      occurredAt: new Date("2026-07-01T01:00:00.000Z"),
    });
    await recordCuratorBehavior({
      eventType: "manual_boost",
      targetType: "item",
      targetId: "item-ai-behavior",
      occurredAt: new Date("2026-07-01T02:00:00.000Z"),
    });

    const suggestions = await generateBriefingPreferenceSuggestions({
      now: new Date("2026-07-02T00:00:00.000Z"),
    });
    const entitySuggestion = suggestions.find((suggestion) => (
      suggestion.ruleType === "entity" && suggestion.value === "ai-coding"
    ));

    expect(entitySuggestion).toMatchObject({
      suggestedWeight: 3,
      positiveScore: 8,
      negativeScore: 0,
      sampleCount: 3,
    });

    const result = await acceptBriefingPreferenceSuggestion(entitySuggestion!.id);

    expect(result.preference.weightedRules).toContainEqual({
      type: "entity",
      value: "ai-coding",
      weight: 3,
    });
    expect(await prisma.briefingPreferenceSuggestion.count({ where: { status: "pending" } })).toBeGreaterThan(0);
    expect(await prisma.briefingPreferenceSuggestion.count({ where: { status: "accepted" } })).toBe(1);
  });

  it("ranks public daily clusters and singles with curator preferences", async () => {
    const group = await prisma.sourceGroup.create({
      data: { id: "group-ai", name: "AI", sortOrder: 0 },
    });
    const sourceA = await prisma.source.create({
      data: {
        id: "source-a",
        name: "OpenAI Blog",
        rssUrl: "https://openai.example.com/feed.xml",
        siteUrl: "https://openai.example.com",
        groupId: group.id,
      },
    });
    const sourceB = await prisma.source.create({
      data: {
        id: "source-b",
        name: "Tech Media",
        rssUrl: "https://media.example.com/feed.xml",
        siteUrl: "https://media.example.com",
      },
    });
    const entity = await prisma.entity.create({
      data: { id: "entity-ai-coding", name: "AI Coding", normalized: "ai-coding" },
    });

    await prisma.contentCluster.create({
      data: {
        id: "cluster-openai",
        title: "OpenAI 发布 Agent 工具链能力",
        summary: "OpenAI 更新了面向开发者的 Agent 工具链。",
        score: 82,
        itemCount: 2,
        latestPublishedAt: new Date("2026-06-30T07:30:00.000Z"),
        fingerprint: "cluster-openai",
        eventType: "launch",
        displayItemCount: 2,
        displaySourceCount: 2,
        displayAverageScore: 84,
        earliestCreatedAt: new Date("2026-06-29T08:00:00.000Z"),
        latestCreatedAt: new Date("2026-06-30T08:20:00.000Z"),
        feedEntitiesJson: JSON.stringify([{ name: "AI Coding", normalized: "ai-coding" }]),
      },
    });

    await prisma.item.createMany({
      data: [
        {
          id: "item-openai-old",
          sourceId: sourceA.id,
          clusterId: "cluster-openai",
          originalUrl: "https://openai.example.com/old",
          canonicalUrl: "https://openai.example.com/old",
          urlHash: "hash-openai-old",
          originalTitle: "Old OpenAI Agent news",
          translatedTitle: "OpenAI Agent 旧进展",
          publishedAt: new Date("2026-06-29T07:00:00.000Z"),
          summaryText: "旧进展摘要",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 80,
          createdAt: new Date("2026-06-29T08:00:00.000Z"),
        },
        {
          id: "item-openai-new-a",
          sourceId: sourceA.id,
          clusterId: "cluster-openai",
          originalUrl: "https://openai.example.com/new",
          canonicalUrl: "https://openai.example.com/new",
          urlHash: "hash-openai-new-a",
          originalTitle: "OpenAI Agent tools",
          translatedTitle: "OpenAI 发布 Agent 工具链能力",
          publishedAt: new Date("2026-06-30T07:30:00.000Z"),
          summaryText: "OpenAI 更新了 Agent 工具链。",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 88,
          eventType: "launch",
          createdAt: new Date("2026-06-30T08:00:00.000Z"),
        },
        {
          id: "item-openai-new-b",
          sourceId: sourceB.id,
          clusterId: "cluster-openai",
          originalUrl: "https://media.example.com/openai",
          canonicalUrl: "https://media.example.com/openai",
          urlHash: "hash-openai-new-b",
          originalTitle: "Media covers OpenAI tools",
          translatedTitle: "媒体报道 OpenAI 工具链",
          publishedAt: new Date("2026-06-30T07:40:00.000Z"),
          summaryText: "媒体报道 OpenAI 工具链更新。",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 82,
          eventType: "launch",
          createdAt: new Date("2026-06-30T08:20:00.000Z"),
        },
        {
          id: "item-single",
          sourceId: sourceB.id,
          originalUrl: "https://media.example.com/single",
          canonicalUrl: "https://media.example.com/single",
          urlHash: "hash-single",
          originalTitle: "Independent high quality story",
          translatedTitle: "单源高质量内容",
          publishedAt: new Date("2026-06-30T09:00:00.000Z"),
          summaryText: "一条单源但质量较高的内容。",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 91,
          createdAt: new Date("2026-06-30T09:05:00.000Z"),
        },
        {
          id: "item-filtered",
          sourceId: sourceB.id,
          originalUrl: "https://media.example.com/filtered",
          canonicalUrl: "https://media.example.com/filtered",
          urlHash: "hash-filtered",
          originalTitle: "Filtered",
          publishedAt: new Date("2026-06-30T09:00:00.000Z"),
          status: "filtered",
          moderationStatus: "filtered",
          qualityScore: 99,
          createdAt: new Date("2026-06-30T09:10:00.000Z"),
        },
      ],
    });
    await prisma.itemEntity.create({
      data: { itemId: "item-openai-new-a", entityId: entity.id },
    });

    await updateEventBriefingConfig({
      minRankScore: 0,
      channels: [
        {
          id: "important",
          name: "重点事件",
          sourceGroupIds: [],
          enabled: true,
          sortOrder: 0,
        },
        {
          id: "ai-channel",
          name: "AI 频道",
          sourceGroupIds: [group.id],
          enabled: true,
          sortOrder: 1,
        },
      ],
    });
    await updateBriefingPreferenceConfig({
      weightedRules: [
        { type: "entity", value: "AI Coding", weight: 6 },
        { type: "source_group", value: group.id, weight: 5 },
        { type: "keyword", value: "OpenAI", weight: 5 },
        { type: "event_type", value: "launch", weight: 4 },
      ],
      maxCuratorBoost: 15,
      maxCuratorPenalty: 20,
    });

    const firstPage = await getEventBriefing({ date: "2026-06-30", page: 1, pageSize: 1 });

    expect(firstPage.summary.eventCount).toBe(2);
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.entries[0]).toMatchObject({
      id: "cluster-openai",
      type: "cluster",
      sourceCount: 2,
      itemCount: 3,
      newItemCountOnDate: 2,
      detailHref: "/?entryKeys=cluster%3Acluster-openai",
    });
    expect(firstPage.entries[0]?.sourceCount).toBe(2);
    expect(firstPage.entries[0]?.isFollowUp).toBe(true);
    expect(firstPage.entries[0]?.curatorBoost).toBeGreaterThan(0);

    const secondPage = await getEventBriefing({ date: "2026-06-30", page: 2, pageSize: 1 });

    expect(secondPage.entries[0]?.id).toBe("item-single");
    expect(secondPage.entries[0]?.detailHref).toBe("/?entryKeys=single%3Aitem-single");
    expect(secondPage.pagination.totalPages).toBe(2);

    const aiChannel = await getEventBriefing({ date: "2026-06-30", channelId: "ai-channel" });

    expect(aiChannel.channel).toMatchObject({ id: "ai-channel", name: "AI 频道" });
    expect(aiChannel.channels.map((channel) => [channel.id, channel.count])).toEqual([
      ["important", 2],
      ["ai-channel", 1],
    ]);
    expect(aiChannel.entries.map((entry) => entry.id)).toEqual(["cluster-openai"]);
  });

  it("degrades singleton clusters to single entries in event briefing", async () => {
    const source = await prisma.source.create({
      data: {
        id: "source-singleton",
        name: "Singleton Source",
        rssUrl: "https://singleton.example.com/feed.xml",
        siteUrl: "https://singleton.example.com",
      },
    });

    await prisma.contentCluster.create({
      data: {
        id: "cluster-singleton",
        title: "Cluster level title should not be used",
        summary: "Cluster level summary should not be used.",
        score: 88,
        itemCount: 1,
        latestPublishedAt: new Date("2026-06-30T07:30:00.000Z"),
        fingerprint: "cluster-singleton",
        displayItemCount: 1,
        displaySourceCount: 1,
        displayAverageScore: 88,
        latestCreatedAt: new Date("2026-06-30T08:10:00.000Z"),
      },
    });

    await prisma.item.create({
      data: {
        id: "item-singleton-cluster",
        sourceId: source.id,
        clusterId: "cluster-singleton",
        originalUrl: "https://singleton.example.com/item",
        canonicalUrl: "https://singleton.example.com/item",
        urlHash: "hash-singleton-cluster",
        originalTitle: "Original singleton title",
        translatedTitle: "单条聚合应退化为单篇",
        publishedAt: new Date("2026-06-30T07:30:00.000Z"),
        summaryText: "单条聚合事件应使用单篇摘要并跳转到 single entry。",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 88,
        createdAt: new Date("2026-06-30T08:10:00.000Z"),
      },
    });

    const briefing = await getEventBriefing({ date: "2026-06-30" });

    expect(briefing.summary.eventCount).toBe(1);
    expect(briefing.entries[0]).toMatchObject({
      id: "item-singleton-cluster",
      type: "single",
      title: "单条聚合应退化为单篇",
      sourceCount: 1,
      itemCount: 1,
      detailHref: "/?entryKeys=single%3Aitem-singleton-cluster",
    });
    expect(briefing.entries[0]?.summary).toBe("单条聚合事件应使用单篇摘要并跳转到 single entry。");
  });

  it("hides aggregation child singles when their parent cluster is already shown", async () => {
    const source = await prisma.source.create({
      data: {
        id: "source-aggregation",
        name: "Aggregation Source",
        rssUrl: "https://aggregation.example.com/feed.xml",
        siteUrl: "https://aggregation.example.com",
      },
    });

    await prisma.contentCluster.create({
      data: {
        id: "cluster-aggregation",
        title: "Anthropic 发布 Claude 新模型",
        summary: "Anthropic 发布 Claude 新模型并更新代理能力。",
        score: 88,
        itemCount: 2,
        latestPublishedAt: new Date("2026-06-30T07:30:00.000Z"),
        fingerprint: "cluster-aggregation",
        displayItemCount: 2,
        displaySourceCount: 1,
        displayAverageScore: 88,
        earliestCreatedAt: new Date("2026-06-30T07:50:00.000Z"),
        latestCreatedAt: new Date("2026-06-30T08:10:00.000Z"),
      },
    });

    await prisma.item.create({
      data: {
        id: "aggregation-parent",
        sourceId: source.id,
        clusterId: "cluster-aggregation",
        originalUrl: "https://aggregation.example.com/parent",
        canonicalUrl: "https://aggregation.example.com/parent",
        urlHash: "hash-aggregation-parent",
        originalTitle: "Anthropic 发布多项 Claude 更新",
        publishedAt: new Date("2026-06-30T07:30:00.000Z"),
        summaryText: "聚合父条目。",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 88,
        isAggregation: true,
        createdAt: new Date("2026-06-30T07:40:00.000Z"),
      },
    });

    await prisma.item.createMany({
      data: [
        {
          id: "clustered-child-a",
          sourceId: source.id,
          clusterId: "cluster-aggregation",
          originalUrl: "https://aggregation.example.com/clustered-a",
          canonicalUrl: "https://aggregation.example.com/clustered-a",
          urlHash: "hash-clustered-a",
          originalTitle: "Claude Sonnet 5 发布",
          translatedTitle: "Anthropic 发布 Claude Sonnet 5",
          publishedAt: new Date("2026-06-30T07:50:00.000Z"),
          summaryText: "Claude Sonnet 5 发布。",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 88,
          createdAt: new Date("2026-06-30T07:55:00.000Z"),
        },
        {
          id: "clustered-child-b",
          sourceId: source.id,
          clusterId: "cluster-aggregation",
          originalUrl: "https://aggregation.example.com/clustered-b",
          canonicalUrl: "https://aggregation.example.com/clustered-b",
          urlHash: "hash-clustered-b",
          originalTitle: "Claude 代理能力更新",
          translatedTitle: "Anthropic 更新 Claude 代理能力",
          publishedAt: new Date("2026-06-30T08:00:00.000Z"),
          summaryText: "Claude 代理能力更新。",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 86,
          createdAt: new Date("2026-06-30T08:10:00.000Z"),
        },
        {
          id: "split-child-single",
          sourceId: source.id,
          parentItemId: "aggregation-parent",
          originalUrl: "https://aggregation.example.com/split-child",
          canonicalUrl: "https://aggregation.example.com/split-child",
          urlHash: "hash-split-child",
          originalTitle: "Claude Science 同步发布",
          translatedTitle: "Anthropic 发布 Claude Science",
          publishedAt: new Date("2026-06-30T08:05:00.000Z"),
          summaryText: "这条聚合子条目不应在聚合事件之外重复展示。",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 90,
          createdAt: new Date("2026-06-30T08:15:00.000Z"),
        },
      ],
    });

    const briefing = await getEventBriefing({ date: "2026-06-30" });

    expect(briefing.summary.eventCount).toBe(1);
    expect(briefing.entries.map((entry) => `${entry.type}:${entry.id}`)).toEqual(["cluster:cluster-aggregation"]);
    expect(briefing.entries[0]?.items.map((item) => item.id)).not.toContain("split-child-single");
  });
});
