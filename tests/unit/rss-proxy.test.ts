import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRssParser } from "@/lib/ingestion/parser";

const servers: Server[] = [];
const oldUrl = process.env.RSS_PROXY_URL;
const oldHosts = process.env.RSS_PROXY_HOSTS;
async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
afterEach(async () => {
  if (oldUrl === undefined) delete process.env.RSS_PROXY_URL; else process.env.RSS_PROXY_URL = oldUrl;
  if (oldHosts === undefined) delete process.env.RSS_PROXY_HOSTS; else process.env.RSS_PROXY_HOSTS = oldHosts;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("targeted RSS proxy", () => {
  it("uses a real proxy only for an exact hostname and preserves conditional headers", async () => {
    let tunnels = 0;
    let conditional = "";
    const feedPort = await listen(createServer((req, res) => {
      conditional = String(req.headers["if-none-match"] ?? "");
      res.writeHead(304, { etag: '"v1"' }).end();
    }));
    const proxy = createServer();
    proxy.on("connect", (_req, client, head) => {
      tunnels += 1;
      const upstream = connect(feedPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    process.env.RSS_PROXY_URL = "http://127.0.0.1:" + await listen(proxy);
    process.env.RSS_PROXY_HOSTS = "127.0.0.1";
    const url = "http://127.0.0.1:" + feedPort + "/feed";
    const result = await createRssParser().parseURL(url, { headers: { "If-None-Match": '"v1"' } });
    expect(result.notModified).toBe(true);
    expect(conditional).toBe('"v1"');
    expect(tunnels).toBe(1);
    process.env.RSS_PROXY_HOSTS = "other.example";
    await createRssParser().parseURL(url);
    expect(tunnels).toBe(1);
  });
  it("rejects unsafe proxy configuration without exposing credentials", async () => {
    process.env.RSS_PROXY_HOSTS = "example.com";
    for (const url of ["http://user:secret@localhost:1234", "https://localhost:1234", "bad-secret"]) {
      process.env.RSS_PROXY_URL = url;
      await expect(createRssParser().parseURL("http://example.com/feed")).rejects.toThrow("Invalid RSS proxy configuration");
    }
    delete process.env.RSS_PROXY_URL;
    await expect(createRssParser().parseURL("http://example.com/feed")).rejects.toThrow("RSS proxy is required");
  });
  it("does not fall back to direct access if the proxy is unavailable", async () => {
    let requests = 0;
    const feedPort = await listen(createServer((_req, res) => { requests += 1; res.end("direct"); }));
    const proxy = createServer((_req, res) => res.writeHead(503).end());
    proxy.on("connect", (_req, socket) => socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"));
    process.env.RSS_PROXY_URL = "http://127.0.0.1:" + await listen(proxy);
    process.env.RSS_PROXY_HOSTS = "127.0.0.1";
    await expect(createRssParser().parseURL("http://127.0.0.1:" + feedPort + "/feed")).rejects.toThrow("RSS proxy request failed");
    expect(requests).toBe(0);
  });
  it("rejects redirects to another host before forwarding them", async () => {
    let tunnels = 0;
    const feedPort = await listen(createServer((_req, res) => res.writeHead(302, { location: "http://localhost/other" }).end()));
    const proxy = createServer();
    proxy.on("connect", (_req, client, head) => {
      tunnels += 1;
      const upstream = connect(feedPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    process.env.RSS_PROXY_URL = "http://127.0.0.1:" + await listen(proxy);
    process.env.RSS_PROXY_HOSTS = "127.0.0.1";
    await expect(createRssParser().parseURL("http://127.0.0.1:" + feedPort + "/feed")).rejects.toThrow("RSS proxy redirect rejected");
    expect(tunnels).toBeGreaterThan(0);
  });
});
