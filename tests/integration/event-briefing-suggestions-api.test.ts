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

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("/api/admin/settings/event-briefing/suggestions", () => {
  beforeEach(async () => {
    await prisma.briefingPreferenceSuggestion.deleteMany();
    await prisma.curatorBehaviorDimension.deleteMany();
    await prisma.briefingPreferenceConfig.deleteMany();
  });

  it("dismisses only the provided suggestions via the dismiss_ids action", async () => {
    requireAdmin.mockResolvedValue(undefined);
    await prisma.briefingPreferenceSuggestion.createMany({
      data: [
        {
          id: "suggestion-first",
          suggestionKey: "keyword:code",
          ruleType: "keyword",
          value: "code",
          label: "code",
          suggestedWeight: 3,
          confidence: 0.8,
          reason: "关键词「code」偏好更强。",
          status: "pending",
        },
        {
          id: "suggestion-second",
          suggestionKey: "keyword:security",
          ruleType: "keyword",
          value: "security",
          label: "security",
          suggestedWeight: -3,
          confidence: 0.7,
          reason: "关键词「security」降权信号更强。",
          status: "pending",
        },
        {
          id: "suggestion-outside",
          suggestionKey: "keyword:outside",
          ruleType: "keyword",
          value: "outside",
          label: "outside",
          suggestedWeight: 1,
          confidence: 0.5,
          reason: "不在本次忽略范围内的建议。",
          status: "pending",
        },
        {
          id: "suggestion-accepted",
          suggestionKey: "keyword:accepted",
          ruleType: "keyword",
          value: "accepted",
          label: "accepted",
          suggestedWeight: 2,
          confidence: 0.6,
          reason: "已接受。",
          status: "accepted",
          acceptedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
    });

    const { POST } = await import("@/app/api/admin/settings/event-briefing/suggestions/route");
    const response = await POST(
      new Request("http://localhost/api/admin/settings/event-briefing/suggestions", {
        method: "POST",
        body: JSON.stringify({
          action: "dismiss_ids",
          suggestionIds: ["suggestion-first", "suggestion-second"],
        }),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.dismissedCount).toBe(2);
    expect(await prisma.briefingPreferenceSuggestion.count({ where: { status: "pending" } })).toBe(1);
    expect(await prisma.briefingPreferenceSuggestion.count({ where: { status: "dismissed" } })).toBe(2);
    expect(await prisma.briefingPreferenceSuggestion.count({ where: { status: "accepted" } })).toBe(1);
    expect(
      await prisma.briefingPreferenceSuggestion.findUniqueOrThrow({
        where: { id: "suggestion-outside" },
      }),
    ).toMatchObject({ status: "pending" });
  });

  it("keeps generating suggestions when the action body is absent", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/settings/event-briefing/suggestions/route");
    const response = await POST(
      new Request("http://localhost/api/admin/settings/event-briefing/suggestions", {
        method: "POST",
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(json.suggestions)).toBe(true);
  });

  it("requires admin authentication", async () => {
    const authError = new Error("未登录") as Error & { status: number };
    authError.status = 401;
    requireAdmin.mockRejectedValue(authError);

    const { GET } = await import("@/app/api/admin/settings/event-briefing/suggestions/route");
    const response = await GET();

    expect(response.status).toBe(401);
  });
});
