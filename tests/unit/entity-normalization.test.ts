import { describe, expect, it } from "vitest";

import {
  extractEventEntityNames,
  normalizeItemEntities,
  normalizeEntityName,
} from "@/lib/entities/normalization";

describe("entity normalization", () => {
  it("normalizes display names and keys", () => {
    expect(normalizeEntityName("  #OpenAI  ")).toEqual({
      name: "OpenAI",
      normalized: "openai",
    });
    expect(normalizeEntityName("“AI 编程”")).toEqual({
      name: "AI 编程",
      normalized: "ai 编程",
    });
  });

  it("filters invalid, duplicate, generic, and excessive entities", () => {
    expect(normalizeItemEntities([
      "新闻",
      "OpenAI",
      " openai ",
      "",
      "AI Agent",
      "x".repeat(41),
      "Codex",
      "开发者工具",
      "模型发布",
      "安全",
    ])).toEqual([
      { name: "OpenAI", normalized: "openai" },
      { name: "AI Agent", normalized: "ai agent" },
      { name: "Codex", normalized: "codex" },
      { name: "开发者工具", normalized: "开发者工具" },
      { name: "模型发布", normalized: "模型发布" },
    ]);
  });

  it("returns an empty array for non-array model output", () => {
    expect(normalizeItemEntities("OpenAI")).toEqual([]);
    expect(normalizeItemEntities(null)).toEqual([]);
  });

  it("derives bounded entity candidates from event subject and object", () => {
    expect(extractEventEntityNames({
      eventSubject: "OpenAI",
      eventObject: "产品能力",
    })).toEqual([{ name: "OpenAI", normalized: "openai" }]);
    expect(normalizeItemEntities(["OpenAI", "openai", "公司", "Codex"])).toEqual([
      { name: "OpenAI", normalized: "openai" },
      { name: "Codex", normalized: "codex" },
    ]);
  });
});
