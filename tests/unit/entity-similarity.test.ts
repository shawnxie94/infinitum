import { describe, expect, it } from "vitest";

import { calculateEntitySimilarity } from "@/lib/entities/similarity";

describe("entity similarity", () => {
  it("keeps reordered bilingual aliases as a singular match", () => {
    expect(calculateEntitySimilarity("DeepSeek（深度求索）", "深度求索（DeepSeek）")).toEqual({
      confidence: 0.96,
      reason: "singular_match",
    });
  });

  it("rejects relationship phrases even when their tokens are reordered", () => {
    expect(calculateEntitySimilarity("ChatGPT 与 Gemini", "Gemini 与 ChatGPT")).toBeNull();
    expect(calculateEntitySimilarity("Mark Zuckerberg / Meta", "Meta / Mark Zuckerberg")).toBeNull();
  });

  it("does not treat a strict token subset as an entity alias", () => {
    expect(calculateEntitySimilarity("Apple Watch", "Apple")).toBeNull();
    expect(calculateEntitySimilarity("Anthropic IPO", "Anthropic")).toBeNull();
  });

  it("keeps bounded spelling variants available for manual review", () => {
    expect(calculateEntitySimilarity("Anthropic CEO达里奥·阿莫代伊", "Anthropic CEO 达里奥·阿莫迪")).toMatchObject({
      reason: "edit_distance",
    });
  });
});
