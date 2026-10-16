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

beforeEach(async () => {
  await prisma.aiRequestReceipt.deleteMany();
  await prisma.aiRequestBudgetDay.deleteMany();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("返回有界分页回执与预算摘要（来源为环境变量），且不暴露原始响应/指纹", async () => {
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
    vi.stubEnv("AI_DAILY_CHAT_REQUEST_LIMIT", "42");

    const response = await listAiRequests("http://localhost/api/admin/ai-requests?limit=5");
    expect(response.status).toBe(200);
    const data = await response.json() as {
      requests: Array<Record<string, unknown>>;
      total: number;
      budget: { admitted: number; limit: number | null; state: string; sourceEnv: string };
    };
    expect(data.total).toBe(7);
    expect(data.requests).toHaveLength(5);
    expect(data.budget.admitted).toBe(7);
    expect(data.budget.limit).toBe(42);
    expect(data.budget.state).toBe("limited");
    expect(data.budget.sourceEnv).toBe("AI_DAILY_CHAT_REQUEST_LIMIT");
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
    const route = await import("@/app/api/admin/settings/ai-requests/route");
    const put = (route as { PUT?: (request: Request) => Promise<Response> }).PUT;
    if (method === "GET") return route.GET();
    if (!put) throw new Error("缺少 PUT 处理器");
    return put(new Request("http://localhost/api/admin/settings/ai-requests", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  it("未认证读写均被拒绝（认证保留）", async () => {
    requireAdmin.mockRejectedValue(new Error("Unauthorized"));
    expect((await call("GET")).status).toBe(401);
    expect((await call("PUT", { dailyChatRequestLimit: 5 })).status).toBe(401);
  });

  it("预算只读：GET 反映环境变量与生效状态，PUT 被 405 拒绝且不产生 DB 写", async () => {
    requireAdmin.mockResolvedValue(undefined);
    vi.stubEnv("AI_DAILY_CHAT_REQUEST_LIMIT", "42");

    const initial = await (await call("GET")).json() as {
      dailyChatRequestLimit: number | null;
      state: string;
      sourceEnv: string;
    };
    expect(initial.dailyChatRequestLimit).toBe(42);
    expect(initial.state).toBe("limited");
    expect(initial.sourceEnv).toBe("AI_DAILY_CHAT_REQUEST_LIMIT");
    expect(initial).not.toHaveProperty("updatedAt");

    // 即使 DB 存了正数配额，也不得作为生效来源或回显。
    const existing = await prisma.aiRequestsConfig.findFirst({ orderBy: { createdAt: "asc" } });
    if (existing) {
      await prisma.aiRequestsConfig.update({ where: { id: existing.id }, data: { dailyChatRequestLimit: 99 } });
    } else {
      await prisma.aiRequestsConfig.create({ data: { dailyChatRequestLimit: 99 } });
    }
    const afterDb = await (await call("GET")).json() as { dailyChatRequestLimit: number | null };
    expect(afterDb.dailyChatRequestLimit).toBe(42);

    const rejected = await call("PUT", { dailyChatRequestLimit: 5 });
    expect(rejected.status).toBe(405);
    const row = await prisma.aiRequestsConfig.findFirst({ orderBy: { createdAt: "asc" } });
    expect(row?.dailyChatRequestLimit).toBe(99);
  });

  it("环境变量未设置/空/空白 = GET 显示 unlimited；0 = paused", async () => {
    requireAdmin.mockResolvedValue(undefined);
    for (const [value, state] of [
      [undefined, "unlimited"],
      ["", "unlimited"],
      ["   ", "unlimited"],
      ["0", "paused"],
    ] as Array<[string | undefined, string]>) {
      if (value === undefined) {
        vi.unstubAllEnvs();
      } else {
        vi.stubEnv("AI_DAILY_CHAT_REQUEST_LIMIT", value);
      }
      const data = await (await call("GET")).json() as {
        dailyChatRequestLimit: number | null;
        state: string;
      };
      expect(data.state).toBe(state);
      expect(data.dailyChatRequestLimit).toBe(value === "0" ? 0 : null);
    }
  });

  it("非法环境值：GET/诊断快照标 invalid 且不回显原始值、不读 DB 配置", async () => {
    requireAdmin.mockResolvedValue(undefined);
    const secretLike = "sk-malformed-secret-xyz";
    vi.stubEnv("AI_DAILY_CHAT_REQUEST_LIMIT", secretLike);
    const existing = await prisma.aiRequestsConfig.findFirst({ orderBy: { createdAt: "asc" } });
    const dbLimitBefore = existing?.dailyChatRequestLimit ?? null;

    const data = await (await call("GET")).json() as {
      dailyChatRequestLimit: number | null;
      state: string;
    };
    expect(data.state).toBe("invalid");
    expect(data.dailyChatRequestLimit).toBeNull();
    expect(JSON.stringify(data)).not.toContain(secretLike);

    // 回执诊断预算摘要同样标 invalid 且不回显。
    const { listAdminAiRequests } = await import("@/lib/ai/request-audit");
    const summary = await listAdminAiRequests({});
    expect(summary.budget.state).toBe("invalid");
    expect(summary.budget.limit).toBeNull();
    expect(JSON.stringify(summary.budget)).not.toContain(secretLike);

    // 无 DB 配置回退、无写入。
    const dbLimitAfter = (await prisma.aiRequestsConfig.findFirst({ orderBy: { createdAt: "asc" } }))?.dailyChatRequestLimit ?? null;
    expect(dbLimitAfter).toBe(dbLimitBefore);
  });
});
