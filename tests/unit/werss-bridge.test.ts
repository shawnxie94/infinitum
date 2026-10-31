// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let child: ChildProcess | undefined;
let upstream: http.Server | undefined;
afterEach(() => { child?.kill(); upstream?.close(); });
async function unusedPort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
describe("WeRSS Keychain 代理", () => {
  it("拒绝浏览器跨站和非白名单请求，凭据只发往本地上游", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "werss-bridge-test-"));
    const fakeSecurity = path.join(dir, "security");
    writeFileSync(fakeSecurity, "#!/bin/sh\nprintf '%s\\n' testak:testsk\n"); chmodSync(fakeSecurity, 0o700);
    let receivedKey = "";
    let writes = 0;
    upstream = http.createServer((req, res) => {
      receivedKey = String(req.headers.authorization || "");
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") { writes++; return res.end(JSON.stringify({ code: 0, data: { id: "MP_WXS_abc123" } })); }
      return res.end(JSON.stringify(req.url?.includes("/search/") ? { code: 0, data: { list: [{ fakeid: "YWJjMTIz", nickname: "甲", token: "must-not-return" }] } } : { code: 0, data: { total: 1, list: [{ id: "MP_WXS_abc123" }] } }));
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const port = await unusedPort();
    child = spawn(process.execPath, ["scripts/werss/keychain-bridge.mjs"], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, WERSS_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`, WERSS_BRIDGE_PORT: String(port) }, stdio: "ignore" });
    const url = `http://127.0.0.1:${port}/api/v1/wx/mps/search/%E7%94%B2?limit=10&offset=0`;
    let result: Response | undefined;
    for (let i = 0; i < 30; i++) { try { result = await fetch(url, { headers: { "x-werss-bridge": "1", origin: "https://evil.example" } }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); } }
    expect(result?.status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/not-allowed`, { headers: { "x-werss-bridge": "1" } })).status).toBe(404);
    const response = await fetch(url, { headers: { "x-werss-bridge": "1" } });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(receivedKey).toBe("AK-SK testak:testsk");
    expect(text).toContain("YWJjMTIz");
    expect(text).not.toContain("testak:testsk");
    expect(text).not.toContain("must-not-return");
    expect((await fetch(url, { headers: { "x-werss-bridge": "1" } })).status).toBe(429);
    const post = await fetch(`http://127.0.0.1:${port}/api/v1/wx/mps`, { method: "POST", headers: { "x-werss-bridge": "1", "content-type": "application/json" }, body: JSON.stringify({ mp_id: "YWJjMTIz", mp_name: "甲", mp_intro: "", avatar: "", mp_cover: "" }) });
    expect((await post.json()).data.id).toBe("MP_WXS_abc123");
    expect(writes).toBe(0);
  }, 15000);
});
