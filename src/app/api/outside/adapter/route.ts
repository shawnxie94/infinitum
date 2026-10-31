import { z } from "zod";
import { requireAdmin } from "@/lib/admin/session";
import { adminErrorResponse } from "@/lib/admin/http";
import { AdapterClient, AdapterError, readAdapterConfig } from "@/lib/adapter/client";
import { followAdapterAccount } from "@/lib/adapter/subscriptions";
import { prisma } from "@/lib/db";

const requestSchema = z.object({
  action: z.enum(["search", "resolve", "follow"]), providerId: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  query: z.string().max(200).optional(),
  account: z.object({ accountId: z.string().min(1).max(180), name: z.string().min(1).max(100), description: z.string().max(300).optional(), siteUrl: z.string().nullish(), avatarUrl: z.string().nullish() }).optional(),
});

function errorResponse(error: unknown) {
  if (error instanceof AdapterError) return Response.json({ error: error.message, code: error.code, retryable: error.retryable, retryAfterSeconds: error.retryAfterSeconds }, { status: error.code === "RATE_LIMITED" ? 429 : error.retryable ? 503 : 400 });
  return adminErrorResponse(error);
}

export async function GET() {
  try { await requireAdmin(); return Response.json(await new AdapterClient(await readAdapterConfig()).providers()); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "请求无效。" }, { status: 400 });
    const { action, providerId, query, account } = parsed.data;
    if (action === "follow") {
      if (!account) return Response.json({ error: "请选择账号。" }, { status: 400 });
      return Response.json({ source: await followAdapterAccount(providerId, account) });
    }
    if (!query?.trim()) return Response.json({ error: "请输入账号。" }, { status: 400 });
    const config = await readAdapterConfig();
    const client = new AdapterClient(config);
    const candidates = action === "search" ? (await client.search(providerId, query.trim())).candidates : [(await client.resolve(providerId, query.trim())).account];
    const bindings = await prisma.adapterSourceBinding.findMany({ where: { adapterInstanceId: config.instanceId, providerId, accountId: { in: candidates.map((candidate) => candidate.accountId) } }, include: { source: { include: { follow: true } } } });
    return Response.json({ candidates: candidates.map((candidate) => ({ ...candidate, followed: bindings.some((binding) => binding.accountId === candidate.accountId && Boolean(binding.source.follow)) })) });
  } catch (error) { return errorResponse(error); }
}
