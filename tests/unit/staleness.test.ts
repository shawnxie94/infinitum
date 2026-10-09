import { describe, expect, it } from "vitest";

import {
  evaluateStaleContent,
  STALE_CONTENT_FILTER_REASON,
  STALE_EVENT_MAX_AGE_DAYS,
} from "@/lib/ingestion/staleness";

describe("evaluateStaleContent", () => {
  const now = new Date("2026-10-04T00:00:00.000Z");

  it("事件时间早于基准超过阈值且年份有佐证时判为过时内容", () => {
    const result = evaluateStaleContent({
      eventDate: "2026-09-01",
      publishedAt: now,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: now,
      contentText: "该项目于 2026 年 9 月 1 日开源，本文跟进。",
    });

    expect(result.stale).toBe(true);
    expect(result.reason).toBe(STALE_CONTENT_FILTER_REASON);
    expect(result.detail).toContain("2026-09-01");
    expect(result.ageDays).toBe(33);
  });

  it("阈值当前为 14 天，10~14 天的内容不过滤", () => {
    expect(STALE_EVENT_MAX_AGE_DAYS).toBe(14);

    const tenDaysAgo = new Date("2026-10-04T00:00:00.000Z");
    const result = evaluateStaleContent({
      eventDate: "2026-09-24",
      publishedAt: tenDaysAgo,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: tenDaysAgo,
      contentText: "该项目于 2026 年 9 月 24 日开源。",
    });

    expect(result.ageDays).toBe(10);
    expect(result.stale).toBe(false);
    expect(result.skipReason).toBe("within_threshold");
  });

  it("事件时间超阈值但正文无年份佐证时不过滤", () => {
    const result = evaluateStaleContent({
      eventDate: "2026-09-01",
      publishedAt: now,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: now,
      contentText: "10 月 1 日，某公司发布了新模型。",
    });

    expect(result.stale).toBe(false);
    expect(result.skipReason).toBe("year_unverified");
  });

  it("事件时间在阈值内不过滤", () => {
    const result = evaluateStaleContent({
      eventDate: "2026-10-01",
      publishedAt: now,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: now,
    });

    expect(result.stale).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("事件时间恰好等于阈值天数时不过滤", () => {
    // 从常量推导基准日，避免阈值调整后用例日期与阈值脱节
    const eventDay = "2026-09-20";
    const publishedAt = new Date(
      `${eventDay}T00:00:00.000Z`,
    );
    publishedAt.setUTCDate(publishedAt.getUTCDate() + STALE_EVENT_MAX_AGE_DAYS);

    const result = evaluateStaleContent({
      eventDate: eventDay,
      publishedAt,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: publishedAt,
    });

    expect(result.ageDays).toBe(STALE_EVENT_MAX_AGE_DAYS);
    expect(result.stale).toBe(false);
    expect(result.skipReason).toBe("within_threshold");
  });

  it("超过阈值一天即判定为过时（年份有佐证）", () => {
    const eventDay = "2026-09-20";
    const publishedAt = new Date(`${eventDay}T00:00:00.000Z`);
    publishedAt.setUTCDate(publishedAt.getUTCDate() + STALE_EVENT_MAX_AGE_DAYS + 1);

    const result = evaluateStaleContent({
      eventDate: eventDay,
      publishedAt,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: publishedAt,
      contentText: `该项目于 ${eventDay.slice(0, 4)} 年 9 月 20 日开源。`,
    });

    expect(result.ageDays).toBe(STALE_EVENT_MAX_AGE_DAYS + 1);
    expect(result.stale).toBe(true);
  });

  it("动态截止日期独立筛选事件时间并放行截止日及缺失证据", () => {
    const common = {
      publishedAt: now,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: now,
      eventDateCutoff: new Date("2026-09-20T00:00:00.000Z"),
      contentText: "2026 年 9 月 19 日发生的事件。",
    };
    expect(evaluateStaleContent({ ...common, eventDate: "2026-09-19" }).stale).toBe(true);
    expect(evaluateStaleContent({ ...common, eventDate: "2026-09-20" }).stale).toBe(false);
    expect(evaluateStaleContent({ ...common, eventDate: "2026-09-01", contentText: "旧事件" }).skipReason).toBe("year_unverified");
    expect(evaluateStaleContent({ ...common, eventDate: null }).skipReason).toBe("no_event_date");
  });

  it("事件时间为空时不过滤", () => {
    const result = evaluateStaleContent({
      eventDate: null,
      publishedAt: now,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: now,
    });

    expect(result.stale).toBe(false);
    expect(result.ageDays).toBeNull();
  });

  it("事件时间为空串或非法格式时不过滤", () => {
    for (const eventDate of ["", "   ", "2026/09/01", "2026-9-1", "not-a-date", undefined]) {
      const result = evaluateStaleContent({
        eventDate,
        publishedAt: now,
        publishedAtKnown: true,
        restoredByAdminAt: null,
        referenceAt: now,
      });

      expect(result.stale).toBe(false);
    }
  });

  it("管理员已恢复的条目不再被判定为过时", () => {
    const result = evaluateStaleContent({
      eventDate: "2026-01-01",
      publishedAt: now,
      publishedAtKnown: true,
      restoredByAdminAt: now,
      referenceAt: now,
    });

    expect(result.stale).toBe(false);
  });

  it("publishedAt 未知时用入库时间兜底", () => {
    const result = evaluateStaleContent({
      eventDate: "2026-09-01",
      publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      publishedAtKnown: false,
      restoredByAdminAt: null,
      referenceAt: now,
      contentText: "该项目于 2026 年 9 月 1 日开源。",
    });

    expect(result.stale).toBe(true);
    expect(result.baseline).toBe("入库时间");
  });

  it("publishedAt 已知时以发布时间为基准，历史补抓不会误判", () => {
    const publishedAt = new Date("2026-09-02T00:00:00.000Z");
    const result = evaluateStaleContent({
      eventDate: "2026-09-01",
      publishedAt,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: now,
    });

    expect(result.stale).toBe(false);
    expect(result.baseline).toBe("发布时间");
  });

  it("事件时间晚于基准时不过滤", () => {
    const result = evaluateStaleContent({
      eventDate: "2026-12-01",
      publishedAt: now,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: now,
    });

    expect(result.stale).toBe(false);
  });

  it("基准时间缺失时不过滤", () => {
    const result = evaluateStaleContent({
      eventDate: "2020-01-01",
      publishedAt: null,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: null,
    });

    expect(result.stale).toBe(false);
    expect(result.baseline).toBeNull();
  });
});

/**
 * 线上真实回归：2026-10-04 部署后，极客公园 4 条当天新文章被误判为 stale_content。
 * 根因是模型把正文里的裸月日（如正文开头的「北京时间 10 月 3 日」报道日期）当成事件时间，
 * 并凭空补了 2025 年（实测 4 条正文均不含 "2025"），导致偏差整年。
 * 以下正文节选取自真实库数据。
 */
describe("evaluateStaleContent 线上误杀回归", () => {
  const realFalsePositives: Array<{
    id: string;
    eventDate: string;
    publishedAt: string;
    fragment: string;
    correctGapDays: number;
  }> = [
    {
      id: "cmutunfcp00dhlg01okulak8y",
      eventDate: "2025-10-01",
      publishedAt: "2026-10-04T05:27:14.000Z",
      fragment:
        "10 月 1 日，美国 AI 视频公司 Tavus 发布了一个名为 Griffin 的模型，并把它定义为全球第一个「人类交互模型」。",
      correctGapDays: 3,
    },
    {
      id: "cmutunosh00dllg01gsfru1ap",
      eventDate: "2025-10-01",
      publishedAt: "2026-10-04T05:16:11.000Z",
      fragment:
        "这一切的源头，是 Claude Code 负责人 Boris Cherny 9 月中旬在 GitHub 上放出的一套机制，名字就叫 Mods。当地时间 10 月 1 日，它正式写进更新日志，默认开启。",
      correctGapDays: 3,
    },
    {
      id: "cmutuntgc00dnlg01c7h82t26",
      eventDate: "2025-09-30",
      publishedAt: "2026-10-04T11:41:48.000Z",
      fragment:
        "9 月 15 日，前 OpenAI 研究员 Diogo Almeida 创办的 TypeSafe AI 发布了 Jev。这款模型不写一个字，只做判断。",
      correctGapDays: 19,
    },
    {
      id: "cmutuo2qg00dplg01gcin02hy",
      eventDate: "2025-10-03",
      publishedAt: "2026-10-04T00:33:38.000Z",
      fragment:
        "北京时间 10 月 3 日，彭博社报道称，苹果公司表示，AT&T 的问题已导致部分 iPhone 18 Pro Max 用户无法拨打电话。",
      correctGapDays: 1,
    },
  ];

  for (const item of realFalsePositives) {
    it(`不误杀 ${item.id}：模型补的年份在正文中无佐证`, () => {
      const result = evaluateStaleContent({
        eventDate: item.eventDate,
        publishedAt: new Date(item.publishedAt),
        publishedAtKnown: true,
        restoredByAdminAt: null,
        referenceAt: new Date(item.publishedAt),
        contentText: item.fragment,
      });

      expect(result.stale).toBe(false);
      expect(result.skipReason).toBe("year_unverified");
    });
  }

  it("正文含该年份的带年份日期时仍然判定为过时", () => {
    const result = evaluateStaleContent({
      eventDate: "2024-03-15",
      publishedAt: new Date("2026-10-04T00:00:00.000Z"),
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: new Date("2026-10-04T00:00:00.000Z"),
      // 正文明确写了 2024 年 3 月，年份有佐证
      contentText: "该产品于 2024 年 3 月 15 日首次发布，本文回顾其演进。",
    });

    expect(result.stale).toBe(true);
    expect(result.reason).toBe("stale_event_content");
  });

  it("正文佐证年份但只有报道日期时按报道日期放行", () => {
    const result = evaluateStaleContent({
      eventDate: "2024-03-15",
      publishedAt: new Date("2026-10-04T00:00:00.000Z"),
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: new Date("2026-10-04T00:00:00.000Z"),
      // 年份有佐证，但事件日期线索是报道日期
      contentText: "2024 年行业回顾。北京时间 10 月 3 日消息，公司今日宣布调整。",
    });

    expect(result.stale).toBe(false);
    expect(result.skipReason).toBe("dateline_only");
  });
});
