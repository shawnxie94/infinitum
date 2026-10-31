import { prisma } from "@/lib/db";

type Candidate = { uid: string; name: string; description: string; expires: number };
const candidates = new Map<string, Candidate>();
const inFlight = new Set<string>();
const API = "/api/v1/wx";
function baseUrl() {
  if (!process.env.WERSS_BASE_URL) throw new Error("未配置 WeRSS 服务。");
  const url = new URL(process.env.WERSS_BASE_URL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("WeRSS 地址配置无效。");
  return url.toString().replace(/\/$/, "");
}
function bridgeUrl() {
  if (!process.env.WERSS_BRIDGE_URL) throw new Error("未配置 WeRSS Keychain 代理。");
  const url = new URL(process.env.WERSS_BRIDGE_URL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("WeRSS 代理地址配置无效。");
  return url.toString().replace(/\/$/, "");
}
function feedId(fakeid: string) {
  if (!/^[A-Za-z0-9+/]{4,180}={0,2}$/.test(fakeid)) throw new Error("公众号标识无效。");
  const decoded = Buffer.from(fakeid, "base64").toString("utf8");
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(decoded) || Buffer.from(decoded).toString("base64").replace(/=+$/, "") !== fakeid.replace(/=+$/, "")) throw new Error("公众号标识无效。");
  return `MP_WXS_${decoded}`;
}
async function request(path: string, init: RequestInit = {}) {
  let response: Response;
  try { response = await fetch(`${bridgeUrl()}${API}${path}`, { ...init, headers: { "x-werss-bridge": "1", ...(init.headers ?? {}) }, redirect: "error", signal: AbortSignal.timeout(20000) }); }
  catch { throw new Error("WeRSS 服务不可用，操作结果请先查询后重试。"); }
  if (response.status === 429) throw new Error("公众号搜索过于频繁，请稍后重试。");
  if (response.status === 401 || response.status === 403) throw new Error("WeRSS API 未授权，请检查 Keychain 中的 AK/SK。");
  if (response.status !== 200) throw new Error("WeRSS 请求失败，请检查微信授权与服务状态。");
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error("WeRSS 返回格式无效。"); }
  if (!data || typeof data !== "object" || !("code" in data) || data.code !== 0 || !("data" in data)) throw new Error("WeRSS 请求失败，请检查微信授权与服务状态。");
  return data.data as Record<string, unknown>;
}
export async function searchWechat(input: string) {
  const q = input.trim();
  if (!q || q.length > 50 || /[\x00-\x1f/]/.test(q)) throw new Error("请输入有效的公众号名称。");
  const result = await request(`/mps/search/${encodeURIComponent(q)}?limit=10&offset=0`);
  if (!Array.isArray(result?.list)) throw new Error("WeRSS 搜索响应无效。");
  const now = Date.now();
  for (const [id, candidate] of candidates) if (candidate.expires < now) candidates.delete(id);
  const seen = new Set<string>();
  const found = result.list.slice(0, 10).flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("fakeid" in item) || typeof item.fakeid !== "string" || !("nickname" in item) || typeof item.nickname !== "string" || !item.nickname.trim()) return [];
    try { feedId(item.fakeid); } catch { return []; }
    if (seen.has(item.fakeid)) return [];
    seen.add(item.fakeid);
    const c = { uid: item.fakeid, name: item.nickname.trim().slice(0, 100), description: "signature" in item && typeof item.signature === "string" ? item.signature.trim().slice(0, 255) : "", expires: now + 5 * 60_000 };
    candidates.set(c.uid, c);
    return [{ uid: c.uid, name: c.name, description: c.description }];
  });
  if (result.list.length && !found.length) throw new Error("WeRSS 搜索响应无效。");
  while (candidates.size > 200) candidates.delete(candidates.keys().next().value!);
  const sources = found.length ? await prisma.source.findMany({ where: { OR: found.map((user) => ({ rssUrl: { endsWith: `/feed/${feedId(user.uid)}.xml` } })) }, select: { rssUrl: true, follow: { select: { sourceId: true } } } }) : [];
  const bindings = found.length ? await prisma.adapterSourceBinding.findMany({ where: { providerId: "wechat", accountId: { in: found.map((user) => user.uid) } }, include: { source: { include: { follow: true } } } }) : [];
  const marked = found.map((user) => ({ ...user, followed: sources.some((source) => source.rssUrl?.endsWith(`/feed/${feedId(user.uid)}.xml`) && Boolean(source.follow)) || bindings.some((binding) => binding.accountId === user.uid && Boolean(binding.source.follow)) }));
  return { candidates: marked, warning: found.length ? undefined : "没有可确认的结果；WeRSS 未授权或受限时也可能返回空结果。" };
}
async function alreadySubscribed(id: string) {
  for (let offset = 0; offset < 1000; offset += 100) {
    const result = await request(`/mps?limit=100&offset=${offset}`);
    if (!Array.isArray(result?.list) || typeof result.total !== "number" || result.total < 0) throw new Error("WeRSS 订阅列表响应无效。");
    if (result.list.some((row: unknown) => row && typeof row === "object" && "id" in row && row.id === id)) return true;
    if (offset + result.list.length >= result.total) return false;
    if (!result.list.length) throw new Error("WeRSS 订阅列表不完整。");
  }
  throw new Error("WeRSS 订阅数量过多，无法确认是否重复。");
}
export async function followWechat(uid: string) {
  const id = feedId(uid);
  const candidate = candidates.get(uid);
  if (!candidate || candidate.expires < Date.now()) throw new Error("搜索结果已过期，请重新搜索并选择。");
  const binding = await prisma.adapterSourceBinding.findFirst({ where: { providerId: "wechat", accountId: uid }, include: { source: true } });
  if (binding) {
    await prisma.sourceFollow.upsert({ where: { sourceId: binding.sourceId }, update: {}, create: { sourceId: binding.sourceId } });
    return binding.source;
  }
  if (inFlight.has(uid)) throw new Error("该公众号正在添加，请稍后查询。");
  inFlight.add(uid);
  try {
    const url = `${baseUrl()}/feed/${id}.xml`;
    if (!await alreadySubscribed(id)) {
      const result = await request("/mps", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mp_id: uid, mp_name: candidate.name, mp_intro: candidate.description, avatar: "", mp_cover: "" }) });
      if (result?.id !== id) throw new Error("WeRSS 添加结果无法确认，请先查询订阅列表。");
    }
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.source.findFirst({ where: { OR: [{ rssUrl: url }, { rssUrl: { endsWith: `/feed/${id}.xml` } }] } });
      const source = existing ?? await tx.source.upsert({ where: { rssUrl: url }, update: {}, create: { name: candidate.name, rssUrl: url, siteUrl: url, channel: "公众号", originKind: "account" } });
      await tx.sourceFollow.upsert({ where: { sourceId: source.id }, update: {}, create: { sourceId: source.id } });
      return source;
    });
  } finally { inFlight.delete(uid); }
}
