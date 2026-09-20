"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { IconTrash } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { TextInput } from "@/components/ui/text-input";
import {
  DEFAULT_QUALITY_RUBRIC,
  QUALITY_RUBRIC_LIMITS,
  normalizeQualityRubric,
  parseQualityRubricDraft,
  stringifyQualityRubric,
  type QualityRubric,
} from "@/lib/ai/quality-rubric";
import { cx } from "@/lib/ui/cx";

type QualityRubricEditorProps = {
  value: string;
  onChange: (next: { templateJson: string }) => void;
  onError: (message: string) => void;
};

const labelClassName = "block text-sm text-[var(--text-2)]";

/** 新增维度时按满分比例预填档位骨架，用户只需要改判据描述。 */
function buildPrefillLevels(points: number) {
  const ratios = [1, 0.65, 0.3, 0];
  const scores: number[] = [];
  for (const ratio of ratios) {
    const score = Math.round(points * ratio);
    if (!scores.includes(score)) {
      scores.push(score);
    }
  }
  return scores.map((score) => ({ score, description: "" }));
}

export function QualityRubricEditor({ value, onChange, onError }: QualityRubricEditorProps) {
  const [expandedDimensionIndexes, setExpandedDimensionIndexes] = useState<Set<number>>(() => new Set([0]));

  // 编辑态用宽松解析：过渡态（合计≠100、档位未排好）原样回显，
  // 语义校验只发生在保存时，否则每次编辑都会被打回默认规则。
  const rubric = useMemo(() => parseQualityRubricDraft(value), [value]);
  const pointsTotal = rubric.dimensions.reduce((total, dimension) => total + (dimension.points || 0), 0);
  const pointsValid = pointsTotal === 100;

  const updateRubric = (mutator: (draft: QualityRubric) => void) => {
    const draft = structuredClone(parseQualityRubricDraft(value));
    mutator(draft);
    const normalized = normalizeQualityRubric(draft);
    onChange({ templateJson: stringifyQualityRubric(normalized) });
  };

  const toggleDimensionExpanded = (index: number) => {
    setExpandedDimensionIndexes((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const addDimension = () => {
    if (rubric.dimensions.length >= QUALITY_RUBRIC_LIMITS.maxDimensions) {
      onError(`评分维度不能超过 ${QUALITY_RUBRIC_LIMITS.maxDimensions} 个。`);
      return;
    }
    updateRubric((draft) => {
      draft.dimensions.push({
        name: "新维度",
        points: 10,
        description: "",
        levels: buildPrefillLevels(10),
      });
    });
    setExpandedDimensionIndexes((current) => new Set([...current, rubric.dimensions.length]));
  };

  const removeDimension = (index: number) => {
    if (rubric.dimensions.length <= QUALITY_RUBRIC_LIMITS.minDimensions) {
      onError("评分规则至少保留一个维度。");
      return;
    }
    updateRubric((draft) => {
      draft.dimensions.splice(index, 1);
    });
  };

  return (
    <div className="space-y-4 rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--text-1)]">
          <span>评分维度</span>
          <span className={cx("text-xs font-normal", pointsValid ? "text-[var(--text-3)]" : "text-[var(--danger-ink,var(--danger))]")}>
            合计 {pointsTotal}/100{pointsValid ? "" : "，需调整为 100"}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange({ templateJson: stringifyQualityRubric(structuredClone(DEFAULT_QUALITY_RUBRIC)) });
              setExpandedDimensionIndexes(new Set([0]));
            }}
          >
            恢复默认
          </Button>
          <Button size="sm" variant="secondary" onClick={addDimension}>
            + 添加维度
          </Button>
        </div>
      </div>

      {rubric.dimensions.map((dimension, dimensionIndex) => {
        const expanded = expandedDimensionIndexes.has(dimensionIndex);
        return (
          <div key={`${dimension.name}-${dimensionIndex}`} className="rounded-lg border border-[color:var(--line)]">
            <div className="flex items-center gap-2 rounded-t-lg bg-[var(--bg-muted)] px-3 py-2">
              <button
                type="button"
                onClick={() => toggleDimensionExpanded(dimensionIndex)}
                className="flex min-w-0 flex-1 items-center justify-between gap-3 px-2 py-1.5 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/35"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-[var(--text-1)]">{dimension.name || `维度 ${dimensionIndex + 1}`}</span>
                  <span className="text-xs text-[var(--text-3)]">
                    {dimension.points || 0} 分 · {dimension.levels.length} 档
                  </span>
                </span>
                <span className="shrink-0 text-[var(--text-3)]">{expanded ? "收起" : "展开"}</span>
              </button>
              <IconButton
                size="sm"
                variant="secondary"
                title="删除维度"
                className="self-center"
                onClick={() => removeDimension(dimensionIndex)}
              >
                <IconTrash className="h-4 w-4" />
              </IconButton>
            </div>

            {expanded ? (
              <div className="space-y-3 border-t border-[color:var(--line)] p-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block space-y-2">
                    <span className={labelClassName}>名称</span>
                    <TextInput
                      aria-label="维度名称"
                      value={dimension.name}
                      onChange={(event) =>
                        updateRubric((draft) => {
                          const target = draft.dimensions[dimensionIndex];
                          if (target) target.name = event.target.value;
                        })
                      }
                    />
                  </label>
                  <label className="block space-y-2">
                    <span className={labelClassName}>分值</span>
                    <TextInput
                      aria-label="维度分值"
                      type="number"
                      min={1}
                      value={dimension.points || ""}
                      onChange={(event) =>
                        updateRubric((draft) => {
                          const target = draft.dimensions[dimensionIndex];
                          const parsed = Number.parseInt(event.target.value, 10);
                          if (target) target.points = Number.isFinite(parsed) ? parsed : 0;
                        })
                      }
                    />
                  </label>
                </div>
                <label className="block space-y-2">
                  <span className={labelClassName}>维度说明（可选）</span>
                  <TextInput
                    aria-label="维度说明"
                    value={dimension.description}
                    onChange={(event) =>
                      updateRubric((draft) => {
                        const target = draft.dimensions[dimensionIndex];
                        if (target) target.description = event.target.value;
                      })
                    }
                  />
                </label>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className={labelClassName}>档位（分值从高到低，最高档等于维度分值）</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={dimension.levels.length >= QUALITY_RUBRIC_LIMITS.maxLevels}
                      onClick={() =>
                        updateRubric((draft) => {
                          const target = draft.dimensions[dimensionIndex];
                          if (!target) return;
                          const lowest = target.levels.length > 0
                            ? target.levels[target.levels.length - 1].score
                            : 0;
                          target.levels.push({ score: Math.max(0, Math.min(lowest, Math.round(target.points * 0.2))), description: "" });
                        })
                      }
                    >
                      + 添加档位
                    </Button>
                  </div>
                  {dimension.levels.map((level, levelIndex) => (
                    <div key={`${level.score}-${levelIndex}`} className="grid grid-cols-1 gap-2 rounded-sm bg-[var(--bg-muted)] p-2 sm:grid-cols-[6rem_1fr_auto]">
                      <TextInput
                        aria-label="档位分值"
                        type="number"
                        min={0}
                        value={level.score}
                        onChange={(event) =>
                          updateRubric((draft) => {
                            const target = draft.dimensions[dimensionIndex];
                            const parsed = Number.parseInt(event.target.value, 10);
                            const targetLevel = target?.levels[levelIndex];
                            if (targetLevel) targetLevel.score = Number.isFinite(parsed) ? parsed : 0;
                          })
                        }
                      />
                      <TextInput
                        aria-label="档位判据"
                        placeholder="该档位对应的可观察判据"
                        value={level.description}
                        onChange={(event) =>
                          updateRubric((draft) => {
                            const target = draft.dimensions[dimensionIndex];
                            const targetLevel = target?.levels[levelIndex];
                            if (targetLevel) targetLevel.description = event.target.value;
                          })
                        }
                      />
                      <IconButton
                        size="sm"
                        variant="secondary"
                        title="删除档位"
                        disabled={dimension.levels.length <= QUALITY_RUBRIC_LIMITS.minLevels}
                        className="self-center"
                        onClick={() =>
                          updateRubric((draft) => {
                            const target = draft.dimensions[dimensionIndex];
                            if (target && target.levels.length > QUALITY_RUBRIC_LIMITS.minLevels) {
                              target.levels.splice(levelIndex, 1);
                            }
                          })
                        }
                      >
                        <IconTrash className="h-4 w-4" />
                      </IconButton>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
