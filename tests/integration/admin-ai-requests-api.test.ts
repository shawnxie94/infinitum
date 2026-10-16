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
});

async function seedReceipt(overrides: Partial<{
  requestId: string;
  operation: string;
  status: string;
  taskRunId: string | null;
  errorMessage: string | null;
  responseRaw: string | null;
  createdAt: Date;
}>) {
  return prisma.aiRequestReceipt.create({
    data: {
      requestId: overrides.requestId ?? crypto.randomUUID(),
      operation: overrides.operation ?? "cluster_summary",
      attemptType: "initial",
      model: "test-model",
      configFingerprint: "f".repeat(64),
      promptFingerprint: "e".repeat(64),
      status: overrides.status ?? "failed",
      taskRunId: overrides.taskRunId ?? null,
      errorMessage: overrides.errorMessage ?? null,
      responseRaw: overrides.responseRaw ?? null,
      createdAt: overrides.createdAt ?? new Date(),
      updatedAt: overrides.createdAt ?? new Date(),
    },
  });
}

beforeEach(async () => {
  await prisma.aiRequestReceipt.deleteMany();
  await prisma.aiRequestBudgetDay.deleteMany();
  const existing = await prisma.aiRequestsConfig.findFirst({ orderBy: { createdAt: "asc" } });
  if (existing) {
    await prisma.aiRequestsConfig.update({ where: { id: existing.id }, data: { dailyChatRequestLimit: null } });
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("/api/admin/ai-requests", () => {
  async function listAiRequests(url: string) {
    const { GET } = await import("@/app/api/admin/ai-requests/route");
    return GET(new Request(url));
  }

  it("未认证访问被拒绝", async () => {
    requireAdmin.mockRejectedValue(new Error("Unauthorized"));
    const response = await listAiRequests("http://localhost/api/admin/ai-requests");
    expect(response.status).toBe(401);
  });

  it("返回有界分页回执与预算摘要，且不暴露原始响应/指纹", async () => {
    requireAdmin.mockResolvedValue(undefined);
    for (let index = 0; index < 7; index += 1) {
      await seedReceipt({
        requestId: `req-${index}`,
        createdAt: new Date(Date.now() + index * 1000),
        errorMessage: index === 0 ? "429 Too Many Requests" : null,
        responseRaw: index === 0 ? "机密原始输出" : null,
      });
    }
    await prisma.aiRequestBudgetDay.create({
      data: { day: new Date().toISOString().slice(0, 10), admitted: 7, updatedAt: new Date() },
    });

    const response = await listAiRequests("http://localhost/api/admin/ai-requests?limit=5");
    expect(response.status).toBe(200);
    const data = await response.json() as {
      requests: Array<Record<string, unknown>>;
      total: number;
      budget: { admitted: number; limit: number | null };
    };
    expect(data.total).toBe(7);
    expect(data.requests).toHaveLength(5);
    expect(data.budget.admitted).toBe(7);
    expect(data.budget.limit).toBeNull();
    for (const item of data.requests) {
      expect(item).not.toHaveProperty("responseRaw");
      expect(item).not.toHaveProperty("promptFingerprint");
      expect(item).not.toHaveProperty("configFingerprint");
    }
    // 最新在前。
    expect(data.requests[0].requestId).toBe("req-6");
  });

  it("支持按 taskRunId 过滤", async () => {
    requireAdmin.mockResolvedValue(undefined);
    await seedReceipt({ requestId: "a", taskRunId: "task-1" });
    await seedReceipt({ requestId: "b", taskRunId: "task-2" });

    const response = await listAiRequests("http://localhost/api/admin/ai-requests?taskRunId=task-1");
    const data = await response.json() as { requests: Array<{ requestId: string }>; total: number };
    expect(data.total).toBe(1);
    expect(data.requests[0].requestId).toBe("a");
  });
});

describe("/api/admin/settings/ai-requests", () => {
  async function call(method: string, body?: unknown) {
    const { GET, PUT } = await import("@/app/api/admin/settings/ai-requests/route");
    if (method === "GET") return GET();
    return PUT(new Request("http://localhost/api/admin/settings/ai-requests", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  it("未认证读写均被拒绝", async () => {
    requireAdmin.mockRejectedValue(new Error("Unauthorized"));
    expect((await call("GET")).status).toBe(401);
    expect((await call("PUT", { dailyChatRequestLimit: 5 })).status).toBe(401);
  });

  it("读取默认不限，写入上限与暂停", async () => {
    requireAdmin.mockResolvedValue(undefined);
    const initial = await (await call("GET")).json() as { dailyChatRequestLimit: number | null };
    expect(initial.dailyChatRequestLimit).toBeNull();

    const paused = await call("PUT", { dailyChatRequestLimit: 0 });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { dailyChatRequestLimit: number }).dailyChatRequestLimit).toBe(0);

    const capped = await call("PUT", { dailyChatRequestLimit: 42 });
    expect(((await capped.json()) as { dailyChatRequestLimit: number }).dailyChatRequestLimit).toBe(42);

    const unlimited = await call("PUT", { dailyChatRequestLimit: null });
    expect(((await unlimited.json()) as { dailyChatRequestLimit: null }).dailyChatRequestLimit).toBeNull();
  });

  it("非法值被拒绝（负数、小数、未知字段）", async () => {
    requireAdmin.mockResolvedValue(undefined);
    for (const body of [
      { dailyChatRequestLimit: -1 },
      { dailyChatRequestLimit: 1.5 },
      { dailyChatRequestLimit: "5" },
      { dailyChatRequestLimit: 5, extra: true },
    ]) {
      const response = await call("PUT", body);
      expect(response.status).toBe(400);
    }
  });
});
