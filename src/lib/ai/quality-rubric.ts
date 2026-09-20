/**
 * 结构化文章质量评分规则（分值 + 档位制）。
 *
 * 规则以 JSON 形式持久化在 item_understanding 提示词配置的 templateJson 字段，
 * 运行时渲染成文字块追加进系统提示词；模型按维度输出 qualityBreakdown 子分，
 * 代码负责档位吸附与求和。前端编辑器与后端渲染共用本模块，保证预览与实际
 * 拼接一致。
 */

export type QualityRubricLevel = {
  /** 该档位分值；维度内严格降序，最高档必须等于维度满分。 */
  score: number;
  /** 档位判据（文本内在可判的观察标准）。 */
  description: string;
};

export type QualityRubricDimension = {
  name: string;
  /** 维度满分；全部维度满分之和必须为 100。 */
  points: number;
  /** 维度一句话定义，可选。 */
  description: string;
  levels: QualityRubricLevel[];
};

export type QualityRubric = {
  kind: "quality_rubric";
  dimensions: QualityRubricDimension[];
  notes: string[];
};

export const QUALITY_RUBRIC_KIND = "quality_rubric";

export const QUALITY_RUBRIC_LIMITS = {
  minDimensions: 1,
  maxDimensions: 8,
  maxDimensionNameLength: 20,
  maxDimensionDescriptionLength: 60,
  minLevels: 2,
  maxLevels: 4,
  maxLevelDescriptionLength: 100,
  maxNotes: 3,
  maxNoteLength: 80,
} as const;

export const DEFAULT_QUALITY_RUBRIC: QualityRubric = {
  kind: QUALITY_RUBRIC_KIND,
  dimensions: [
    {
      name: "事实密度",
      points: 30,
      description: "具体事实、数据、引语的数量与占比",
      levels: [
        { score: 30, description: "≥5 处具体事实、数据或引语" },
        { score: 20, description: "3-4 处具体事实或数据" },
        { score: 8, description: "1-2 处，以笼统表述为主" },
        { score: 0, description: "无具体事实，观点或模板文字" },
      ],
    },
    {
      name: "一手性",
      points: 25,
      description: "一手信息与转述摘编的构成",
      levels: [
        { score: 25, description: "一手信息：官方原文、独家数据、直接评测、现场细节" },
        { score: 15, description: "转述为主但含具体引用或细节" },
        { score: 5, description: "通稿改写、综述摘编，无一手信息" },
      ],
    },
    {
      name: "完整度",
      points: 20,
      description: "事件要素的覆盖程度",
      levels: [
        { score: 20, description: "主体、动作、结果、背景等要素齐全" },
        { score: 12, description: "缺次要要素，主要事实可辨" },
        { score: 4, description: "只有单一片段，要素严重缺失" },
      ],
    },
    {
      name: "可信度",
      points: 15,
      description: "信源与表述的克制程度",
      levels: [
        { score: 15, description: "信源明确，表述克制" },
        { score: 8, description: "信源模糊或部分夸大" },
        { score: 0, description: "明显夸大、无信源或标题党" },
      ],
    },
    {
      name: "信息聚焦",
      points: 10,
      description: "正文与标题的一致性、内容纯度",
      levels: [
        { score: 10, description: "聚焦主题，无模板、广告或无关内容" },
        { score: 5, description: "明显夹带推广、模板文字或跑题内容" },
      ],
    },
  ],
  notes: ["只评文章本身质量，题材是否属于 AI 领域不影响分数。"],
};

function clampInt(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 结构化校验；返回第一条错误的可读描述，通过时返回 null。 */
export function validateQualityRubric(rubric: QualityRubric): string | null {
  if (!rubric || rubric.kind !== QUALITY_RUBRIC_KIND) {
    return "评分规则格式无效。";
  }
  const { dimensions, notes } = rubric;
  if (!Array.isArray(dimensions) || dimensions.length < QUALITY_RUBRIC_LIMITS.minDimensions) {
    return "评分规则至少需要一个评分维度。";
  }
  if (dimensions.length > QUALITY_RUBRIC_LIMITS.maxDimensions) {
    return `评分维度不能超过 ${QUALITY_RUBRIC_LIMITS.maxDimensions} 个。`;
  }

  const seenNames = new Set<string>();
  let pointsTotal = 0;
  for (const dimension of dimensions) {
    const name = normalizeText(dimension?.name);
    if (!name) {
      return "评分维度名称不能为空。";
    }
    if (name.length > QUALITY_RUBRIC_LIMITS.maxDimensionNameLength) {
      return `评分维度名称「${name}」超过 ${QUALITY_RUBRIC_LIMITS.maxDimensionNameLength} 字。`;
    }
    if (seenNames.has(name)) {
      return `评分维度名称重复：「${name}」。`;
    }
    seenNames.add(name);

    if (!isFiniteNumber(dimension?.points) || !Number.isInteger(dimension.points) || dimension.points <= 0) {
      return `评分维度「${name}」的分值必须是正整数。`;
    }
    pointsTotal += dimension.points;

    if (normalizeText(dimension?.description).length > QUALITY_RUBRIC_LIMITS.maxDimensionDescriptionLength) {
      return `评分维度「${name}」的说明超过 ${QUALITY_RUBRIC_LIMITS.maxDimensionDescriptionLength} 字。`;
    }

    const levels = dimension?.levels;
    if (!Array.isArray(levels) || levels.length < QUALITY_RUBRIC_LIMITS.minLevels) {
      return `评分维度「${name}」至少需要 ${QUALITY_RUBRIC_LIMITS.minLevels} 个档位。`;
    }
    if (levels.length > QUALITY_RUBRIC_LIMITS.maxLevels) {
      return `评分维度「${name}」的档位不能超过 ${QUALITY_RUBRIC_LIMITS.maxLevels} 个。`;
    }

    let previousScore = Number.POSITIVE_INFINITY;
    for (const level of levels) {
      if (!isFiniteNumber(level?.score) || !Number.isInteger(level.score) || level.score < 0) {
        return `评分维度「${name}」的档位分值必须是非负整数。`;
      }
      if (level.score > dimension.points) {
        return `评分维度「${name}」的档位分值不能超过维度满分 ${dimension.points}。`;
      }
      if (level.score >= previousScore) {
        return `评分维度「${name}」的档位分值必须从高到低排列且不重复。`;
      }
      previousScore = level.score;
      if (!normalizeText(level?.description)) {
        return `评分维度「${name}」存在没有判据的档位。`;
      }
      if (normalizeText(level?.description).length > QUALITY_RUBRIC_LIMITS.maxLevelDescriptionLength) {
        return `评分维度「${name}」的档位判据超过 ${QUALITY_RUBRIC_LIMITS.maxLevelDescriptionLength} 字。`;
      }
    }
    if (levels[0].score !== dimension.points) {
      return `评分维度「${name}」的最高档分值必须等于维度满分 ${dimension.points}。`;
    }
  }

  if (pointsTotal !== 100) {
    return `全部分维度的分值合计必须为 100，当前为 ${pointsTotal}。`;
  }

  if (!Array.isArray(notes) || notes.length > QUALITY_RUBRIC_LIMITS.maxNotes) {
    return `总体说明不能超过 ${QUALITY_RUBRIC_LIMITS.maxNotes} 条。`;
  }
  for (const note of notes) {
    if (!normalizeText(note)) {
      return "总体说明存在空条目。";
    }
    if (normalizeText(note).length > QUALITY_RUBRIC_LIMITS.maxNoteLength) {
      return `总体说明条目超过 ${QUALITY_RUBRIC_LIMITS.maxNoteLength} 字。`;
    }
  }

  return null;
}

/** 编辑态归一化：修剪文本、拷贝结构、档位按分值降序。不改变语义内容。 */
export function normalizeQualityRubric(rubric: QualityRubric): QualityRubric {
  return {
    kind: QUALITY_RUBRIC_KIND,
    dimensions: rubric.dimensions.map((dimension) => ({
      name: normalizeText(dimension?.name),
      points: isFiniteNumber(dimension?.points) ? clampInt(dimension.points) : 0,
      description: normalizeText(dimension?.description),
      levels: [...(dimension?.levels ?? [])]
        .map((level) => ({
          score: isFiniteNumber(level?.score) ? clampInt(level.score) : 0,
          description: normalizeText(level?.description),
        }))
        .sort((left, right) => right.score - left.score),
    })),
    notes: (rubric.notes ?? []).map((note) => normalizeText(note)).filter(Boolean),
  };
}

/** 供保存路径与运行时共用；解析失败返回 null，由调用方决定回退或报错。 */
export function parseQualityRubricJson(value: string | null | undefined): QualityRubric | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const raw = parsed as Partial<QualityRubric>;
  if (raw.kind !== QUALITY_RUBRIC_KIND || !Array.isArray(raw.dimensions)) {
    return null;
  }

  const rubric = normalizeQualityRubric({
    kind: QUALITY_RUBRIC_KIND,
    dimensions: raw.dimensions.map((dimension) => ({
      name: normalizeText(dimension?.name),
      points: isFiniteNumber(dimension?.points) ? dimension.points : Number.NaN,
      description: normalizeText(dimension?.description),
      levels: Array.isArray(dimension?.levels)
        ? dimension.levels.map((level) => ({
            score: isFiniteNumber(level?.score) ? level.score : Number.NaN,
            description: normalizeText(level?.description),
          }))
        : [],
    })),
    notes: Array.isArray(raw.notes) ? raw.notes.map((note) => normalizeText(note)) : [],
  });

  return validateQualityRubric(rubric) === null ? rubric : null;
}

export function stringifyQualityRubric(rubric: QualityRubric): string {
  return JSON.stringify(rubric, null, 2);
}

/**
 * 渲染为追加进系统提示词的评分标准块。前端“拼接预览”与后端运行时
 * 共用本函数，保证所见即所得。
 */
export function renderQualityRubricPrompt(rubric: QualityRubric): string {
  const lines: string[] = [
    "qualityScore 评分标准（系统固定要求，满分 100，逐维度对照档位给分后求和）：",
  ];
  rubric.dimensions.forEach((dimension, index) => {
    const definition = dimension.description ? `：${dimension.description}` : "";
    const levelText = dimension.levels
      .map((level) => `${level.score}=${level.description}`)
      .join("；");
    lines.push(`${index + 1}. ${dimension.name}（满分 ${dimension.points} 分${definition}）——档位：${levelText}。`);
  });
  lines.push(
    "qualityScore 为全部分维度选中档位分之和；qualityRationale 用一句中文说明主要维度的档位选择理由。",
  );
  for (const note of rubric.notes) {
    lines.push(note);
  }
  return lines.join("\n");
}

function snapToLevelScore(levels: QualityRubricLevel[], score: number): number {
  let nearest = levels[0].score;
  let smallestDistance = Number.POSITIVE_INFINITY;
  // 档位已按分值降序；距离相同（档位中点）时取更低档，保证结果保守且确定。
  for (const level of [...levels].sort((left, right) => left.score - right.score)) {
    const distance = Math.abs(level.score - score);
    if (distance < smallestDistance) {
      smallestDistance = distance;
      nearest = level.score;
    }
  }
  return nearest;
}

/**
 * 由 qualityBreakdown 计算总分：逐维度匹配名称并做档位吸附后求和。
 * 任一维度缺失、名称不匹配或分值越界时返回 matched=false，由调用方走
 * 单字段 qualityScore 的回退路径。
 */
export function resolveRubricQualityScore(
  rubric: QualityRubric | null | undefined,
  breakdown: unknown,
): { score: number; matched: boolean } {
  if (!rubric || !Array.isArray(breakdown)) {
    return { score: 0, matched: false };
  }

  const entries = new Map<string, number>();
  for (const item of breakdown) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { score: 0, matched: false };
    }
    const name = normalizeText((item as { name?: unknown }).name);
    const rawScore = (item as { score?: unknown }).score;
    const score = typeof rawScore === "number"
      ? rawScore
      : typeof rawScore === "string" && rawScore.trim()
        ? Number(rawScore)
        : Number.NaN;
    if (!name || !Number.isFinite(score)) {
      return { score: 0, matched: false };
    }
    entries.set(name, score);
  }

  let total = 0;
  for (const dimension of rubric.dimensions) {
    const rawScore = entries.get(dimension.name);
    if (rawScore === undefined) {
      return { score: 0, matched: false };
    }
    entries.delete(dimension.name);
    if (!Number.isInteger(rawScore) || rawScore < 0 || rawScore > dimension.points) {
      return { score: 0, matched: false };
    }
    total += snapToLevelScore(dimension.levels, rawScore);
  }
  if (entries.size > 0) {
    return { score: 0, matched: false };
  }

  return { score: clampInt(total), matched: true };
}
