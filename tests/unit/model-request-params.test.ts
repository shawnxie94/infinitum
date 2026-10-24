import { describe, expect, it } from "vitest";
import { canonicalizeCustomRequestParams } from "../../packages/ai/src/provider/custom-request-params";

describe("custom request params", () => {
  it("accepts extensions and recursively canonicalizes key order", () => {
    expect(canonicalizeCustomRequestParams('{"z":1,"vendor":{"beta":2,"alpha":1}}')).toEqual({ vendor: { alpha: 1, beta: 2 }, z: 1 });
  });
  it.each(["[]", "null", "{", '{"apiKey":"hidden"}', '{"nested":{"authorization":"hidden"}}', '{"maxOutputTokens":9}', '{"vendor":{"max_tokens":9}}', '{"n":2}', '{"__proto__":{"x":1}}'])("rejects unsafe input %s without echoing it", raw => {
    try { canonicalizeCustomRequestParams(raw); throw new Error("expected rejection"); }
    catch (error) { expect((error as Error).message).not.toContain("hidden"); }
  });
  it("clears blank and empty object and rejects excess depth/size", () => {
    expect(canonicalizeCustomRequestParams("")).toEqual({});
    expect(canonicalizeCustomRequestParams("{}")).toEqual({});
    expect(() => canonicalizeCustomRequestParams(JSON.stringify({ x: "x".repeat(9000) }))).toThrow();
    expect(() => canonicalizeCustomRequestParams(JSON.stringify({ a:{b:{c:{d:{e:{f:{g:{h:{i:1}}}}}}}}}))).toThrow();
  });
});
