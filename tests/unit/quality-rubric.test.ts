import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUALITY_RUBRIC,
  normalizeQualityRubric,
  parseQualityRubricDraft,
  parseQualityRubricJson,
  renderQualityRubricPrompt,
  resolveRubricQualityScore,
  stringifyQualityRubric,
  validateQualityRubric,
  type QualityRubric,
} from "@/lib/ai/quality-rubric";

function buildRubric(overrides: Partial<QualityRubric["dimensions"][number]> = {}): QualityRubric {
  return {
    kind: "quality_rubric",
    dimensions: [
      {
        name: "事实密度",
        points: 60,
        description: "事实数量",
        levels: [
          { score: 60, description: "很多事实" },
          { score: 30, description: "一些事实" },
          { score: 0, description: "没有事实" },
        ],
        ...overrides,
      },
      {
        name: "完整度",
        points: 40,
        description: "",
        levels: [
          { score: 40, description: "要素齐全" },
          { score: 10, description: "要素缺失" },
        ],
      },
    ],
  };
}

describe("quality rubric validation", () => {
  it("accepts the built-in default rubric whose points sum to 100", () => {
    expect(validateQualityRubric(DEFAULT_QUALITY_RUBRIC)).toBeNull();
    const total = DEFAULT_QUALITY_RUBRIC.dimensions.reduce((sum, dimension) => sum + dimension.points, 0);
    expect(total).toBe(100);
  });

  it("rejects dimension points that do not sum to 100", () => {
    const rubric = buildRubric({
      points: 70,
      levels: [
        { score: 70, description: "很多事实" },
        { score: 30, description: "一些事实" },
        { score: 0, description: "没有事实" },
      ],
    });
    expect(validateQualityRubric(rubric)).toContain("合计必须为 100");
  });

  it("rejects a top level that does not equal the dimension points", () => {
    const rubric = buildRubric();
    rubric.dimensions[0].levels[0].score = 50;
    expect(validateQualityRubric(rubric)).toContain("最高档分值必须等于维度满分");
  });

  it("rejects unordered or duplicated level scores", () => {
    const rubric = buildRubric();
    rubric.dimensions[0].levels = [
      { score: 30, description: "a" },
      { score: 30, description: "b" },
      { score: 0, description: "c" },
    ];
    expect(validateQualityRubric(rubric)).toContain("从高到低排列且不重复");
  });

  it("rejects duplicate dimension names and empty names", () => {
    const rubric = buildRubric();
    rubric.dimensions[1].name = "事实密度";
    expect(validateQualityRubric(rubric)).toContain("名称重复");
  });

  it("round-trips through stringify and parse", () => {
    const json = stringifyQualityRubric(buildRubric());
    const parsed = parseQualityRubricJson(json);
    expect(parsed).not.toBeNull();
    expect(parsed?.dimensions).toHaveLength(2);
    expect(validateQualityRubric(parsed ?? DEFAULT_QUALITY_RUBRIC)).toBeNull();
  });

  it("returns null for malformed or wrong-kind JSON", () => {
    expect(parseQualityRubricJson("not json")).toBeNull();
    expect(parseQualityRubricJson("{}")).toBeNull();
    expect(parseQualityRubricJson(JSON.stringify({ kind: "other", dimensions: [] }))).toBeNull();
    expect(parseQualityRubricJson("")).toBeNull();
    expect(parseQualityRubricJson(undefined)).toBeNull();
  });

  it("normalizes level order to descending", () => {
    const rubric = buildRubric();
    rubric.dimensions[0].levels = [
      { score: 0, description: "a" },
      { score: 30, description: "b" },
      { score: 60, description: "c" },
    ];
    const normalized = normalizeQualityRubric(rubric);
    expect(normalized.dimensions[0].levels.map((level) => level.score)).toEqual([60, 30, 0]);
  });
});

describe("quality rubric prompt rendering", () => {
  it("renders dimensions, level anchors and the fixed guardrail note", () => {
    const text = renderQualityRubricPrompt(DEFAULT_QUALITY_RUBRIC);
    expect(text).toContain("满分 100");
    expect(text).toContain("事实密度（满分 30 分");
    expect(text).toContain("30=≥5 处具体事实、数据或引语");
    expect(text).toContain("一手性");
    expect(text).toContain("只评文章本身质量，题材是否属于 AI 领域不影响分数。");
    expect(text).toContain("qualityScore 为全部分维度选中档位分之和");
  });
});

describe("quality rubric draft parsing (editor lenient mode)", () => {
  it("preserves in-progress invalid states instead of falling back to the default", () => {
    const draft = buildRubric({ points: 70 });
    // 合计 110 ≠ 100 的编辑过渡态必须原样回显，否则编辑器每次改动都被打回默认。
    const parsed = parseQualityRubricDraft(stringifyQualityRubric(draft));
    expect(parsed.dimensions).toHaveLength(2);
    expect(parsed.dimensions[0].points).toBe(70);
    expect(validateQualityRubric(parsed)).not.toBeNull();
  });

  it("falls back to the default rubric on malformed JSON", () => {
    const parsed = parseQualityRubricDraft("not json");
    expect(parsed.dimensions).toEqual(DEFAULT_QUALITY_RUBRIC.dimensions);
    expect(parseQualityRubricDraft("").dimensions).toEqual(DEFAULT_QUALITY_RUBRIC.dimensions);
  });

  it("normalizes level order in drafts without validating", () => {
    const rubric = buildRubric();
    rubric.dimensions[0].levels = [
      { score: 0, description: "a" },
      { score: 60, description: "c" },
      { score: 30, description: "b" },
    ];
    const parsed = parseQualityRubricDraft(stringifyQualityRubric(rubric));
    expect(parsed.dimensions[0].levels.map((level) => level.score)).toEqual([60, 30, 0]);
  });
});

describe("quality rubric score resolution", () => {
  const rubric = buildRubric();

  it("sums exact level scores", () => {
    const result = resolveRubricQualityScore(rubric, [
      { name: "事实密度", score: 60 },
      { name: "完整度", score: 40 },
    ]);
    expect(result).toEqual({ score: 100, matched: true });
  });

  it("snaps between-level scores to the nearest level, ties to the lower level", () => {
    // 25 到 60/30 等距，取更低档 30；45 更接近 30？不——45 距 60 为 15、距 30 为 15，同样取低档。
    const snapped = resolveRubricQualityScore(rubric, [
      { name: "事实密度", score: 25 },
      { name: "完整度", score: 40 },
    ]);
    expect(snapped).toEqual({ score: 70, matched: true });

    const between = resolveRubricQualityScore(rubric, [
      { name: "事实密度", score: 50 },
      { name: "完整度", score: 10 },
    ]);
    expect(between).toEqual({ score: 70, matched: true });
  });

  it("accepts numeric strings from the model", () => {
    const result = resolveRubricQualityScore(rubric, [
      { name: "事实密度", score: "30" },
      { name: "完整度", score: "10" },
    ]);
    expect(result).toEqual({ score: 40, matched: true });
  });

  it("rejects a missing dimension, unknown names, out-of-range and non-integer scores", () => {
    expect(resolveRubricQualityScore(rubric, [{ name: "事实密度", score: 30 }]).matched).toBe(false);
    expect(resolveRubricQualityScore(rubric, [
      { name: "事实密度", score: 30 },
      { name: "不存在的维度", score: 10 },
    ]).matched).toBe(false);
    expect(resolveRubricQualityScore(rubric, [
      { name: "事实密度", score: 61 },
      { name: "完整度", score: 10 },
    ]).matched).toBe(false);
    expect(resolveRubricQualityScore(rubric, [
      { name: "事实密度", score: 12.5 },
      { name: "完整度", score: 10 },
    ]).matched).toBe(false);
    expect(resolveRubricQualityScore(null, [{ name: "事实密度", score: 30 }]).matched).toBe(false);
  });
});
