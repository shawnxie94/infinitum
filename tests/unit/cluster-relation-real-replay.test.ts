import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../../scripts/prepare-cluster-relation-source-replay";
import { FROZEN_PACKET, FROZEN_SHA, loadScoringContext, makeSimulationReceipt } from "../../scripts/score-cluster-relation-source-replay";
import { authorizationSchema, sendReplay, verifyAuthorization, verifyReplay, type Authorization, type Connection } from "../../scripts/replay-cluster-relation-source";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dirs: string[] = [];
const fakeConnection: Connection = { id: "cmqv0x84p0004qn01bnsbii66", baseUrl: "https://api.minimaxi.com/v1", modelName: "MiniMax-M3", apiKey: "TEST_ONLY_NOT_A_CREDENTIAL", customHeaders: {} };
function fixture(overrides: Partial<Authorization> = {}) {
  const root = mkdtempSync(join(tmpdir(), "infinitum-replay-test-")); dirs.push(root);
  const auth = authorizationSchema.parse({ schemaVersion: 1, taskRunId: "2026-10-14-cluster-relation-real-replay",
    userGrant: "真实回放吧，可以使用本地Docker库里api配置数据", createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
    manifestSha256: FROZEN_SHA, dockerContext: "desktop-linux", container: "infinitum", databasePath: "/app/data/dev.db",
    modelConfigId: fakeConnection.id, promptConfigId: "cmqq311w50006o101uaje7asd", providerBaseUrl: fakeConnection.baseUrl, model: fakeConnection.modelName,
    maxRequests: 2, maxRetries: 0, temperature: 0, maxTokens: 2000, timeoutMs: 180000,
    senderSha256: digest(readFileSync(resolve(repo, "scripts/replay-cluster-relation-source.ts"))),
    scorerSha256: digest(readFileSync(resolve(repo, "scripts/score-cluster-relation-source-replay.ts"))), ...overrides });
  const text = JSON.stringify(auth, null, 2) + "\n"; writeFileSync(join(root, "authorization.json"), text);
  return { root, authSha: digest(text), auth };
}
function mockBody(model = "MiniMax-M3", finish = "stop", missing = false) {
  const c = loadScoringContext(repo, resolve(repo, FROZEN_PACKET), FROZEN_SHA);
  const raw = JSON.parse(makeSimulationReceipt(c, "baseline", c.pairs.map((p) => p.gold)).rawResponse);
  if (missing) raw.decisions.pop();
  return JSON.stringify({ id: "test_only_provider_id", model, choices: [{ finish_reason: finish, message: { content: JSON.stringify(raw) } }],
    usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } });
}
const response = (body: string, status = 200) => ({ status, text: async () => body });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("authorized real-replay adapter (unit transport is visibly synthetic)", () => {
  it("sends exactly two symmetric requests, archives and verifies receipts, never stores the credential", async () => {
    const f = fixture(); const transport = vi.fn(async () => response(mockBody()));
    const result = await sendReplay(repo, f.root, f.authSha, () => fakeConnection, transport);
    expect(result).toMatchObject({ status: "scored", attempts: 2, retries: 0, qualityPassed: false }); expect(transport).toHaveBeenCalledTimes(2);
    for (const call of transport.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[0]).toBe("https://api.minimaxi.com/v1/chat/completions"); expect(call[1].redirect).toBe("error");
      expect(JSON.parse(call[1].body as string)).toMatchObject({ model: "MiniMax-M3", temperature: 0, max_tokens: 2000, stream: false });
    }
    expect(verifyReplay(repo, f.root, result.executionSha256).status).toBe("scored");
    const report = JSON.parse(readFileSync(join(f.root, "real.report.json"), "utf8"));
    expect(report.interpretation.simulated).toBe(true); expect(report.interpretation.modelOutputObserved).toBe(false); expect(report.maximumPossibleBillableCalls).toBe(0);
    expect(readFileSync(join(f.root, "baseline.model-receipt.json"), "utf8")).not.toContain(fakeConnection.apiKey);
    await expect(sendReplay(repo, f.root, f.authSha, () => fakeConnection, transport)).rejects.toThrow("already consumed"); expect(transport).toHaveBeenCalledTimes(2);
  });
  it("rejects wrong authorization anchor or expired grant before any connection or transport", async () => {
    const f = fixture(); const connection = vi.fn(() => fakeConnection); const transport = vi.fn(async () => response(mockBody()));
    await expect(sendReplay(repo, f.root, "0".repeat(64), connection, transport)).rejects.toThrow("trust anchor"); expect(connection).not.toHaveBeenCalled();
    const past = fixture({ createdAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expect(sendReplay(repo, past.root, past.authSha, connection, transport)).rejects.toThrow("expired"); expect(transport).not.toHaveBeenCalled();
  });
  it("rejects sender drift before network", () => {
    const f = fixture({ senderSha256: "0".repeat(64) }); expect(() => verifyAuthorization(repo, f.root, f.authSha, true)).toThrow("code drift");
  });
  it.each(["model", "endpoint", "id", "headers", "empty-key"])("rejects %s connection drift without dispatch", async (what) => {
    const f = fixture(); const c = { ...fakeConnection };
    if (what === "model") c.modelName = "other";
    if (what === "endpoint") c.baseUrl = "https://other.example/v1";
    if (what === "id") c.id = "other";
    if (what === "headers") c.customHeaders = { authorization: "unreviewed" };
    if (what === "empty-key") c.apiKey = "";
    const transport = vi.fn(async () => response(mockBody())); await expect(sendReplay(repo, f.root, f.authSha, () => c, transport)).rejects.toThrow("connection drift"); expect(transport).not.toHaveBeenCalled();
  });
  it("consumes authorization on ambiguous network failure, suppresses secret errors and does not retry", async () => {
    const f = fixture(); const transport = vi.fn(async () => { throw new Error(fakeConnection.apiKey); });
    const result = await sendReplay(repo, f.root, f.authSha, () => fakeConnection, transport);
    expect(result.attempts).toBe(1); expect(transport).toHaveBeenCalledTimes(1); expect(result.status).toBe("incomplete_or_protocol_failed");
    const receipt = readFileSync(join(f.root, "baseline.model-receipt.json"), "utf8"); expect(receipt).not.toContain(fakeConnection.apiKey);
    expect(existsSync(join(f.root, "candidate.dispatch-started.json"))).toBe(false);
    await expect(sendReplay(repo, f.root, f.authSha, () => fakeConnection, transport)).rejects.toThrow("consumed");
  });
  it("stops after an HTTP error without logging secret-echoing provider content", async () => {
    const f = fixture(); const transport = vi.fn(async () => response(fakeConnection.apiKey, 401));
    await sendReplay(repo, f.root, f.authSha, () => fakeConnection, transport); expect(transport).toHaveBeenCalledTimes(1);
    const r = JSON.parse(readFileSync(join(f.root, "baseline.model-receipt.json"), "utf8")); expect(r.transportStatus).toBe("secret_echo_blocked"); expect(r.responseBody).toBeNull();
  });
  it("does not retry a truncated response; preserves usage without inventing metrics", async () => {
    const f = fixture(); const transport = vi.fn(async () => response(mockBody("MiniMax-M3", "length")));
    await sendReplay(repo, f.root, f.authSha, () => fakeConnection, transport); expect(transport).toHaveBeenCalledTimes(2);
    const r = JSON.parse(readFileSync(join(f.root, "real.report.json"), "utf8")); expect(r.baseline.metrics).toBeNull(); expect(r.paired).toBeNull(); expect(r.baseline.usage.total_tokens).toBe(50);
  });
  it("does not salvage missing pairs, keeps provider usage, and requires both arms complete", async () => {
    const f = fixture(); let i = 0; const transport = vi.fn(async () => response(mockBody("MiniMax-M3", "stop", i++ === 0)));
    await sendReplay(repo, f.root, f.authSha, () => fakeConnection, transport);
    const r = JSON.parse(readFileSync(join(f.root, "real.report.json"), "utf8")); expect(r.baseline.metrics).toBeNull(); expect(r.baseline.usage.total_tokens).toBe(50); expect(r.candidate.metrics.pairs).toBe(6); expect(r.paired).toBeNull();
  });
  it("does not compare arms with inconsistent reported model identity", async () => {
    const f = fixture(); let i = 0; const transport = vi.fn(async () => response(mockBody(i++ === 0 ? "M3-alias-a" : "M3-alias-b")));
    await sendReplay(repo, f.root, f.authSha, () => fakeConnection, transport);
    const r = JSON.parse(readFileSync(join(f.root, "real.report.json"), "utf8")); expect(r.baseline.metrics.pairs).toBe(6); expect(r.paired).toBeNull();
  });
  it("rejects modified receipts/reports and wrong external execution anchor", async () => {
    const f = fixture(); const result = await sendReplay(repo, f.root, f.authSha, () => fakeConnection, async () => response(mockBody()));
    expect(() => verifyReplay(repo, f.root, "0".repeat(64))).toThrow("External execution trust anchor");
    writeFileSync(join(f.root, "real.report.json"), "{}"); expect(() => verifyReplay(repo, f.root, result.executionSha256)).toThrow("drift");
  });
});
