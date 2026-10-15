import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../../scripts/prepare-cluster-relation-source-replay";
import { FROZEN_PACKET, FROZEN_SHA, loadScoringContext, makeSimulationReceipt } from "../../scripts/score-cluster-relation-source-replay";
import { authorizationSchema, expectedWire, sendReplay, verifyAuthorization, verifyReplay, scoreReceipt, type Authorization } from "../../scripts/replay-cluster-relation-source-v2";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dirs: string[] = [];
const connection = { id: "cmqv0x84p0004qn01bnsbii66", modelName: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1", apiKey: "TEST_ONLY_NOT_A_CREDENTIAL", customHeaders: {} };
function fixture(overrides: Partial<Authorization> = {}) {
  const root = mkdtempSync(join(tmpdir(), "infinitum-v2-test-")); dirs.push(root);
  const wires = Object.fromEntries((["baseline", "candidate"] as const).map((a) => [a, expectedWire(repo, a)]));
  for (const a of ["baseline", "candidate"] as const) writeFileSync(join(root, `${a}.wire.json`), JSON.stringify(wires[a], null, 2) + "\n");
  const auth = authorizationSchema.parse({ schemaVersion: 2, taskRunId: "2026-10-14-cluster-relation-real-replay-v2", userGrant: "可以",
    grantScope: "two arms once each; zero retries; symmetric 8192 token cap; separate reasoning output; same model/input/prompts",
    createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), manifestSha256: FROZEN_SHA,
    dockerContext: "desktop-linux", container: "infinitum", databasePath: "/app/data/dev.db", modelConfigId: connection.id, promptConfigId: "cmqq311w50006o101uaje7asd",
    providerBaseUrl: connection.baseUrl, model: connection.modelName, maxRequests: 2, maxRetries: 0, temperature: 0, maxTokens: 8192, reasoningSplit: true, timeoutMs: 180000,
    priorExecutionManifestSha256: "739685c4fad3292fe951bfa04140acd7d6afa018935765a835c86f7146e79021",
    senderSha256: digest(readFileSync(resolve(repo, "scripts/replay-cluster-relation-source-v2.ts"))),
    v1SenderSha256: digest(readFileSync(resolve(repo, "scripts/replay-cluster-relation-source.ts"))),
    scorerSha256: digest(readFileSync(resolve(repo, "scripts/score-cluster-relation-source-replay.ts"))),
    inputPreparerSha256: digest(readFileSync(resolve(repo, "scripts/prepare-cluster-relation-source-replay.ts"))),
    wireFileHashes: Object.fromEntries((["baseline", "candidate"] as const).map((a) => [a, digest(readFileSync(join(root, `${a}.wire.json`)))])),
    wireBodyHashes: Object.fromEntries((["baseline", "candidate"] as const).map((a) => [a, digest(JSON.stringify(wires[a]))])), ...overrides });
  const text = JSON.stringify(auth, null, 2) + "\n"; writeFileSync(join(root, "authorization.json"), text);
  return { root, auth, anchor: digest(text) };
}
function response(mode = "good", model = "MiniMax-M3") {
  const c = loadScoringContext(repo, resolve(repo, FROZEN_PACKET), FROZEN_SHA);
  const raw = makeSimulationReceipt(c, "baseline", c.pairs.map((p) => p.gold)).rawResponse;
  const b = JSON.stringify({ model, choices: [{ finish_reason: mode === "length" ? "length" : "stop", message: {
    content: mode === "empty" ? "" : mode === "think-inline" ? `<think>test</think>${raw}` : raw,
    reasoning_content: "测试推理，不能进入判定解析。", } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
  return { status: 200, text: async () => b };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("v2 frozen symmetric transport", () => {
  it("only overrides cap and reasoning channel, never prompt/user/source or thinking mode", () => {
    const base = expectedWire(repo, "baseline"), candidate = expectedWire(repo, "candidate");
    expect(base.messages[1]).toEqual(candidate.messages[1]); expect(base.messages[0]).not.toEqual(candidate.messages[0]);
    expect(base).toMatchObject({ max_tokens: 8192, reasoning_split: true, temperature: 0, model: "MiniMax-M3", stream: false });
    expect(base).not.toHaveProperty("thinking"); expect(base).not.toHaveProperty("response_format");
  });
  it("freezes/sends exactly two wires and uses only content for strict scoring; test transport stays synthetic", async () => {
    const f = fixture(); const transport = vi.fn(async () => response());
    const result = await sendReplay(repo, f.root, f.anchor, () => connection, transport);
    expect(result).toMatchObject({ status: "scored", attempts: 2, retries: 0, qualityPassed: false }); expect(transport).toHaveBeenCalledTimes(2);
    const calls = transport.mock.calls as unknown as [string, RequestInit][];
    for (const [i, call] of calls.entries()) {
      expect(call[1].body).toBe(JSON.stringify(expectedWire(repo, i === 0 ? "baseline" : "candidate"))); expect(call[1].redirect).toBe("error");
    }
    expect(verifyReplay(repo, f.root, result.executionSha256).status).toBe("scored");
    const report = JSON.parse(readFileSync(join(f.root, "real.report.json"), "utf8")); expect(report.interpretation.simulated).toBe(true); expect(report.interpretation.modelOutputObserved).toBe(false);
    expect(report.baseline.metrics.pairs).toBe(6); expect(report.baseline.byProvenance.assisted_human_confirmation.pairs).toBe(1);
    expect(readFileSync(join(f.root, "baseline.model-receipt.json"), "utf8")).not.toContain(connection.apiKey);
    await expect(sendReplay(repo, f.root, f.anchor, () => connection, transport)).rejects.toThrow("consumed"); expect(transport).toHaveBeenCalledTimes(2);
  });
  it("rejects a wire changed after freezing before credential lookup", async () => {
    const f = fixture(); writeFileSync(join(f.root, "baseline.wire.json"), "{}"); const get = vi.fn(() => connection);
    await expect(sendReplay(repo, f.root, f.anchor, get)).rejects.toThrow("wire drift"); expect(get).not.toHaveBeenCalled();
  });
  it("rejects malicious resealed extra gold and asymmetric parameters by rebuilding expected wires", () => {
    const f = fixture(); const wire = { ...expectedWire(repo, "candidate"), max_tokens: 4096, gold: ["same_event"] };
    const text = JSON.stringify(wire, null, 2) + "\n"; writeFileSync(join(f.root, "candidate.wire.json"), text);
    f.auth.wireFileHashes.candidate = digest(text); f.auth.wireBodyHashes.candidate = digest(JSON.stringify(wire));
    const auth = JSON.stringify(f.auth); writeFileSync(join(f.root, "authorization.json"), auth);
    expect(() => verifyAuthorization(repo, f.root, digest(auth))).toThrow("message mismatch");
  });
  it("rejects old grant identity/budget before network", () => {
    const f = fixture(); const old = { ...f.auth, schemaVersion: 1, maxTokens: 2000 };
    const text = JSON.stringify(old); writeFileSync(join(f.root, "authorization.json"), text);
    expect(() => verifyAuthorization(repo, f.root, digest(text))).toThrow();
  });
  it.each(["length", "empty", "think-inline"])("does not retry or rescue %s responses and preserves reported usage", async (mode) => {
    const f = fixture(); const transport = vi.fn(async () => response(mode));
    await sendReplay(repo, f.root, f.anchor, () => connection, transport); expect(transport).toHaveBeenCalledTimes(2);
    const r = JSON.parse(readFileSync(join(f.root, "real.report.json"), "utf8")); expect(r.baseline.metrics).toBeNull(); expect(r.paired).toBeNull(); expect(r.baseline.usage.total_tokens).toBe(30);
  });
  it("stops ambiguous network failure once, suppresses secret errors, spends the grant", async () => {
    const f = fixture(); const transport = vi.fn(async () => { throw new Error(connection.apiKey); });
    await sendReplay(repo, f.root, f.anchor, () => connection, transport); expect(transport).toHaveBeenCalledTimes(1);
    expect(existsSync(join(f.root, "candidate.dispatch-started.json"))).toBe(false);
    expect(readFileSync(join(f.root, "baseline.model-receipt.json"), "utf8")).not.toContain(connection.apiKey);
    await expect(sendReplay(repo, f.root, f.anchor, () => connection, transport)).rejects.toThrow("consumed");
  });
  it("blocks credential echo instead of writing it and does not send a second call", async () => {
    const f = fixture(); const transport = vi.fn(async () => ({ status: 200, text: async () => connection.apiKey }));
    await sendReplay(repo, f.root, f.anchor, () => connection, transport); expect(transport).toHaveBeenCalledTimes(1);
    const r = JSON.parse(readFileSync(join(f.root, "baseline.model-receipt.json"), "utf8")); expect(r.responseBody).toBeNull(); expect(r.transportStatus).toBe("secret_echo_blocked");
  });
  it("rejects wrong response arm/binding instead of giving it a missing/negative verdict", async () => {
    const f = fixture(); await sendReplay(repo, f.root, f.anchor, () => connection, async () => response());
    const r = JSON.parse(readFileSync(join(f.root, "baseline.model-receipt.json"), "utf8")); r.arm = "candidate";
    const c = loadScoringContext(repo, resolve(repo, FROZEN_PACKET), FROZEN_SHA);
    expect(scoreReceipt(c, f.auth, f.anchor, "baseline", r).metrics).toBeNull();
  });
  it("requires both complete arms and the same reported model", async () => {
    const f = fixture(); let i = 0;
    await sendReplay(repo, f.root, f.anchor, () => connection, async () => response("good", i++ === 0 ? "model-a" : "model-b"));
    expect(JSON.parse(readFileSync(join(f.root, "real.report.json"), "utf8")).paired).toBeNull();
  });
  it("rejects expired authorization and changed sender without credential access", async () => {
    const f = fixture({ createdAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() }); const get = vi.fn(() => connection);
    await expect(sendReplay(repo, f.root, f.anchor, get)).rejects.toThrow("expired"); expect(get).not.toHaveBeenCalled();
    const changed = fixture({ senderSha256: "0".repeat(64) }); expect(() => verifyAuthorization(repo, changed.root, changed.anchor)).toThrow("Code reference drift");
  });
  it("rejects altered report and external execution SHA", async () => {
    const f = fixture(); const result = await sendReplay(repo, f.root, f.anchor, () => connection, async () => response());
    expect(() => verifyReplay(repo, f.root, "0".repeat(64))).toThrow("anchor mismatch"); writeFileSync(join(f.root, "real.report.json"), "{}");
    expect(() => verifyReplay(repo, f.root, result.executionSha256)).toThrow("file drift");
  });
});
