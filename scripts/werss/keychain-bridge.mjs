import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const security = promisify(execFile);
const upstream = new URL(process.env.WERSS_UPSTREAM_URL || 'http://127.0.0.1:8001');
if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== '/' || upstream.hostname !== '127.0.0.1') throw new Error('Invalid WeRSS upstream');
const base = upstream.origin;
const prefix = '/api/v1/wx/mps';
const port = Number(process.env.WERSS_BRIDGE_PORT || '18765');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid bridge port');
let searchInFlight = false;
let addInFlight = false;
let nextSearchAt = 0;
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
http.createServer(async (req, res) => {
  let writeClaimed = false;
  try {
    const host = String(req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost', 'host.docker.internal'].includes(host) || req.headers.origin || req.headers['sec-fetch-site'] || req.headers['x-werss-bridge'] !== '1') return send(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url || '/', 'http://localhost');
    let path;
    if (req.method === 'GET' && url.pathname === prefix) {
      const limit = url.searchParams.get('limit'); const offset = url.searchParams.get('offset');
      if (limit !== '100' || !/^(?:0|[1-9]\d{0,3})$/.test(offset || '') || [...url.searchParams.keys()].some((k) => !['limit', 'offset'].includes(k))) return send(res, 400, { error: 'Invalid request' });
      path = `${prefix}?limit=100&offset=${offset}`;
    } else if (req.method === 'GET' && url.pathname.startsWith(`${prefix}/search/`)) {
      const q = decodeURIComponent(url.pathname.slice(`${prefix}/search/`.length));
      if (!q || q.length > 50 || /[\x00-\x1f/]/.test(q) || url.searchParams.get('limit') !== '10' || url.searchParams.get('offset') !== '0' || [...url.searchParams.keys()].some((k) => !['limit', 'offset'].includes(k))) return send(res, 400, { error: 'Invalid request' });
      path = `${prefix}/search/${encodeURIComponent(q)}?limit=10&offset=0`;
    } else if (req.method === 'POST' && url.pathname === prefix && !url.search && req.headers['content-type'] === 'application/json') path = prefix;
    else return send(res, 404, { error: 'Not found' });
    let body;
    if (req.method === 'POST') {
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 4096) return send(res, 413, { error: 'Too large' }); }
      const data = JSON.parse(text);
      if (typeof data.mp_id !== 'string' || !/^[A-Za-z0-9+/]{4,180}={0,2}$/.test(data.mp_id) || typeof data.mp_name !== 'string' || !data.mp_name.trim() || data.mp_name.length > 100 || typeof data.mp_intro !== 'string' || data.mp_intro.length > 255 || data.avatar !== '' || data.mp_cover !== '') return send(res, 400, { error: 'Invalid request' });
      const decoded = Buffer.from(data.mp_id, 'base64').toString('utf8');
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(decoded) || Buffer.from(decoded).toString('base64').replace(/=+$/, '') !== data.mp_id.replace(/=+$/, '')) return send(res, 400, { error: 'Invalid request' });
      if (addInFlight) return send(res, 429, { error: 'Add in progress' });
      addInFlight = true; writeClaimed = true;
      body = JSON.stringify({ mp_id: data.mp_id, mp_name: data.mp_name, mp_intro: data.mp_intro, avatar: '', mp_cover: '' });
    }
    const isSearch = path.includes('/search/');
    if (isSearch && (searchInFlight || Date.now() < nextSearchAt)) return send(res, 429, { error: 'Search rate limited' });
    if (isSearch) { searchInFlight = true; nextSearchAt = Date.now() + 3000; }
    let key;
    try { key = (await security('security', ['find-generic-password', '-s', 'kb-model', '-a', 'werss-ak-sk', '-w'], { timeout: 5000, maxBuffer: 4096 })).stdout.trim(); }
    catch { if (isSearch) searchInFlight = false; return send(res, 401, { error: 'Keychain unavailable' }); }
    if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(key)) { if (isSearch) searchInFlight = false; return send(res, 401, { error: 'Keychain unavailable' }); }
    // Serialize writes and recheck the authoritative list inside the bridge,
    // including after a previous request whose result was unknown.
    if (body) {
      const wantedId = `MP_WXS_${Buffer.from(JSON.parse(body).mp_id, 'base64').toString('utf8')}`;
      let confirmed = false;
      for (let offset = 0; offset < 1000; offset += 100) {
        let check;
        try { check = await fetch(`${base}${prefix}?limit=100&offset=${offset}`, { headers: { 'Authorization': `AK-SK ${key}` }, redirect: 'error', signal: AbortSignal.timeout(18000) }); }
        catch { return send(res, 502, { error: 'Upstream unavailable' }); }
        if (check.status !== 200) return send(res, check.status === 401 || check.status === 403 ? 401 : 502, { error: 'Upstream failed' });
        const raw = await check.text();
        if (raw.length > 1_000_000) return send(res, 502, { error: 'Invalid upstream response' });
        const result = JSON.parse(raw);
        if (result?.code !== 0 || !Array.isArray(result.data?.list) || typeof result.data.total !== 'number') return send(res, 502, { error: 'Invalid upstream response' });
        if (result.data.list.some((item) => item?.id === wantedId)) return send(res, 200, { code: 0, data: { id: wantedId } });
        if (offset + result.data.list.length >= result.data.total) { confirmed = true; break; }
        if (!result.data.list.length) return send(res, 502, { error: 'Invalid upstream response' });
      }
      if (!confirmed) return send(res, 502, { error: 'Upstream list incomplete' });
    }
    let response;
    try { response = await fetch(`${base}${path}`, { method: req.method, headers: { 'Authorization': `AK-SK ${key}`,  ...(body ? { 'content-type': 'application/json' } : {}) }, body, redirect: 'error', signal: AbortSignal.timeout(18000) }); }
    catch { if (isSearch) searchInFlight = false; return send(res, 502, { error: 'Upstream unavailable' }); }
    if (isSearch) searchInFlight = false;
    if (response.status === 401 || response.status === 403) return send(res, 401, { error: 'Upstream unauthorized' });
    if (response.status !== 200) return send(res, 502, { error: 'Upstream failed' });
    const text = await response.text();
    if (text.length > 1_000_000) return send(res, 502, { error: 'Invalid upstream response' });
    const result = JSON.parse(text);
    if (result?.code !== 0 || !result.data || typeof result.data !== 'object') return send(res, 502, { error: 'Invalid upstream response' });
    if (path.includes('/search/')) {
      if (!Array.isArray(result.data.list)) return send(res, 502, { error: 'Invalid upstream response' });
      return send(res, 200, { code: 0, data: { list: result.data.list.slice(0, 10).map(({ fakeid, nickname, signature }) => ({ fakeid, nickname, signature })) } });
    }
    if (req.method === 'POST') return send(res, 200, { code: 0, data: { id: result.data.id } });
    if (!Array.isArray(result.data.list) || typeof result.data.total !== 'number') return send(res, 502, { error: 'Invalid upstream response' });
    return send(res, 200, { code: 0, data: { list: result.data.list.map(({ id }) => ({ id })), total: result.data.total } });
  } catch { return send(res, 400, { error: 'Invalid request' }); }
  finally { if (writeClaimed) addInFlight = false; }
}).listen(port, '127.0.0.1');
