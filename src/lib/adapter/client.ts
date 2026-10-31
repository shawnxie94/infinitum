import { readFile } from "node:fs/promises";
import { z } from "zod";

export type AdapterAccount = { accountId: string; name: string; description?: string; avatarUrl?: string | null; siteUrl?: string | null };
export type AdapterProvider = { id: string; name: string; capabilities: { search: boolean; resolve: boolean; inputKinds: string[] } };
export type AdapterStatus = { state: "pending" | "ok" | "rate_limited" | "auth_required" | "error"; code?: string; retryAfterSeconds?: number; lastSuccessAt?: string | null };
export type AdapterSubscription = { id: string; providerId: string; accountId: string; account: AdapterAccount; status: AdapterStatus };
export type AdapterItem = { externalId: string; title: string; url: string; author?: string | null; publishedAt?: string | null; summary?: string | null; content: { text?: string | null; html?: string | null; status: "full" | "partial" | "unavailable" }; updatedAt?: string | null; metadata?: Record<string, unknown> };
export type AdapterItems = { items: AdapterItem[]; latestFetchedAt: string | null; upstreamStatus: AdapterStatus };
type Config = { baseUrl: string; token: string; instanceId: string };
const accountSchema = z.object({ accountId: z.string().min(1).max(1024), name: z.string().min(1).max(1024), description: z.string().optional(), avatarUrl: z.httpUrl().nullish(), siteUrl: z.httpUrl().nullish() });
const statusSchema = z.object({ state: z.enum(["pending", "ok", "rate_limited", "auth_required", "error"]), code: z.string().max(80).optional(), retryAfterSeconds: z.number().optional(), lastSuccessAt: z.string().nullish() });
const subscriptionSchema = z.object({ id: z.string().min(1), providerId: z.string().min(1), accountId: z.string().min(1), account: accountSchema, status: statusSchema });
const itemSchema = z.object({ externalId: z.string().min(1).max(1024), title: z.string().min(1).max(1024), url: z.httpUrl(), author: z.string().nullish(), publishedAt: z.string().nullish(), summary: z.string().nullish(), content: z.object({ text: z.string().nullish(), html: z.string().nullish(), status: z.enum(["full", "partial", "unavailable"]) }), updatedAt: z.string().nullish(), metadata: z.record(z.string(), z.unknown()).optional() });

export class AdapterError extends Error {
  constructor(public code: string, message: string, public retryable: boolean, public retryAfterSeconds?: number, public requestId?: string) { super(message); }
}

export async function readAdapterConfig(path = process.env.ADAPTER_CONFIG_FILE): Promise<Config> {
  if (!path) throw new AdapterError("CONFIG_ERROR", "未配置 Adapter 私有配置文件。", false);
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { throw new AdapterError("CONFIG_ERROR", "无法读取 Adapter 私有配置文件。", false); }
  if (!value || typeof value !== "object") throw new AdapterError("CONFIG_ERROR", "Adapter 配置无效。", false);
  const { baseUrl, token, instanceId } = value as Record<string, unknown>;
  if (typeof baseUrl !== "string" || typeof token !== "string" || !token.trim() || typeof instanceId !== "string" || !instanceId.trim()) throw new AdapterError("CONFIG_ERROR", "Adapter 配置无效。", false);
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new AdapterError("CONFIG_ERROR", "Adapter 地址无效。", false); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AdapterError("CONFIG_ERROR", "Adapter 地址无效。", false);
  return { baseUrl: url.toString().replace(/\/$/, ""), token, instanceId };
}

export class AdapterClient {
  constructor(private config: Config, private fetcher: typeof fetch = fetch) {}
  private async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
    let response: Response;
    try { response = await this.fetcher(`${this.config.baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${this.config.token}`, ...(init.body ? { "content-type": "application/json" } : {}) }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new AdapterError("UNAVAILABLE", "Adapter 服务不可用，操作结果请先查询后重试。", true); }
    const length = Number(response.headers.get("content-length"));
    if (length > 4_000_000) throw new AdapterError("INVALID_RESPONSE", "Adapter 响应过大。", false);
    const reader = response.body?.getReader();
    if (!reader) throw new AdapterError("INVALID_RESPONSE", "无法读取 Adapter 响应。", true);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4_000_000) { await reader.cancel(); throw new AdapterError("INVALID_RESPONSE", "Adapter 响应过大。", false); }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("INVALID_RESPONSE", "无法读取 Adapter 响应。", true);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new AdapterError("INVALID_RESPONSE", "Adapter 响应无效。", true); }
    if (!response.ok) {
      const error = (data as { error?: Record<string, unknown> })?.error;
      throw new AdapterError(typeof error?.code === "string" ? error.code : "UPSTREAM_ERROR", typeof error?.message === "string" ? error.message : "Adapter 请求失败。", error?.retryable === true, typeof error?.retryAfterSeconds === "number" ? error.retryAfterSeconds : undefined, typeof error?.requestId === "string" ? error.requestId : undefined);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AdapterError("INVALID_RESPONSE", "Adapter 响应格式无效。", true);
    return parsed.data;
  }
  providers() { return this.request("/v1/providers", z.object({ providers: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), capabilities: z.object({ search: z.boolean(), resolve: z.boolean(), inputKinds: z.array(z.string()) }) })) })); }
  search(providerId: string, query: string) { return this.request(`/v1/providers/${encodeURIComponent(providerId)}/search?q=${encodeURIComponent(query)}`, z.object({ candidates: z.array(accountSchema).max(100) })); }
  resolve(providerId: string, input: string) { return this.request(`/v1/providers/${encodeURIComponent(providerId)}/resolve`, z.object({ account: accountSchema }), { method: "POST", body: JSON.stringify({ input }) }); }
  ensure(providerId: string, account: AdapterAccount) { return this.request("/v1/subscriptions/ensure", z.object({ subscription: subscriptionSchema }), { method: "POST", body: JSON.stringify({ providerId, account }) }); }
  lookup(providerId: string, accountId: string) { return this.request(`/v1/subscriptions?providerId=${encodeURIComponent(providerId)}&accountId=${encodeURIComponent(accountId)}`, z.object({ subscription: subscriptionSchema.nullable() })); }
  subscription(id: string) { return this.request(`/v1/subscriptions/${encodeURIComponent(id)}`, z.object({ subscription: subscriptionSchema }), {}, 5_000); }
  items(id: string, limit = 100) { return this.request(`/v1/subscriptions/${encodeURIComponent(id)}/items?limit=${Math.min(100, Math.max(1, Math.trunc(limit)))}`, z.object({ items: z.array(itemSchema).max(100), latestFetchedAt: z.string().nullable(), upstreamStatus: statusSchema })); }
}

export async function createAdapterClient() { return new AdapterClient(await readAdapterConfig()); }
