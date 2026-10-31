import http from 'node:http';
import { readdir } from 'node:fs/promises';

// RSSHub owns the browser configuration and obtains an anonymous session.
const files = await readdir('/app/dist');
const modulePath = (prefix) => {
  const matches = files.filter((name) => name.startsWith(prefix) && name.endsWith('.mjs'));
  if (matches.length !== 1) throw new Error(`RSSHub module unavailable: ${prefix}`);
  return `/app/dist/${matches[0]}`;
};
const { t: getCookies } = await import(modulePath('xueqiu-cookies-'));
const { t: request } = await import(modulePath('ofetch-'));
let inFlight = false;
let nextRequestAt = 0;
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/search') return send(res, 404, { error: 'Not found' });
  let body = '';
  try {
    for await (const chunk of req) { body += chunk; if (body.length > 1024) return send(res, 413, { error: 'Request too large' }); }
    const { query } = JSON.parse(body);
    if (typeof query !== 'string' || query.trim().length < 1 || query.trim().length > 50 || /[\x00-\x1f]/.test(query)) return send(res, 400, { error: 'Invalid query' });
    if (inFlight || Date.now() < nextRequestAt) return send(res, 429, { error: 'Search rate limited' });
    inFlight = true;
    nextRequestAt = Date.now() + 3000;
    try {
      const upstream = (async () => {
          const cookie = await getCookies('https://xueqiu.com/');
          return request('https://api.xueqiu.com/users/search.json', { query: { q: query.trim(), count: 10, page: 1 }, retry: 0, timeout: 12000, headers: { Cookie: cookie, Referer: 'https://xueqiu.com/' } });
        })().finally(() => { inFlight = false; });
      const result = await Promise.race([
        upstream,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 25000)),
      ]);
      if (!Array.isArray(result?.users)) return send(res, 502, { error: 'Invalid upstream response' });
      const users = result.users.flatMap((user) => {
        const id = typeof user.id === 'number' && Number.isSafeInteger(user.id) ? String(user.id) : typeof user.id === 'string' ? user.id : '';
        if (!/^[1-9]\d{0,19}$/.test(id) || typeof user.screen_name !== 'string' || !user.screen_name.trim()) return [];
        const photoDomain = typeof user.photo_domain === 'string' ? user.photo_domain.replace(/^https?:/, '').replace(/\/$/, '') : '';
        const photoPath = typeof user.profile_image_url === 'string' ? user.profile_image_url.split(',').find((part) => /!180x180\.png$/.test(part)) || user.profile_image_url.split(',')[0] : '';
        const avatarUrl = photoDomain === '//xavatar.imedao.com' && /^[a-zA-Z0-9_./!\-]+$/.test(photoPath) && !photoPath.includes('..') ? `https://xavatar.imedao.com/${photoPath}` : null;
        const description = typeof user.description === 'string' ? user.description.trim().slice(0, 300) : '';
        return [{ uid: id, name: user.screen_name.trim().slice(0, 100), description, avatarUrl }];
      });
      if (result.users.length && !users.length) return send(res, 502, { error: 'Invalid upstream response' });
      return send(res, 200, { candidates: users.slice(0, 10) });
    } catch { return send(res, 502, { error: 'Search upstream unavailable' }); }

  } catch { return send(res, 400, { error: 'Invalid request' }); }
}).listen(3100, '0.0.0.0');
