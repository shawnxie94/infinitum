"use client";

import type { DragEvent, ReactNode } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { IconGrip, IconTrash } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { ModalShell } from "@/components/ui/modal-shell";
import { TextArea } from "@/components/ui/text-area";
import { TextInput } from "@/components/ui/text-input";
import {
  compileDailyReportTemplatePrompt,
  classifyDailyReportTemplateMigration,
  DEFAULT_DAILY_REPORT_TEMPLATE,
  migrateLegacyDailyReportTemplate,
  normalizeDailyReportTemplateConfig,
  parseDailyReportTemplateJson,
  stringifyDailyReportTemplate,
  type DailyReportTemplateConfig,
} from "@/lib/daily-report/template";
import { cx } from "@/lib/ui/cx";

type DailyReportTemplateEditorProps = {
  value: string;
  systemPrompt?: string | null;
  onChange: (next: { templateJson: string; systemPrompt: string }) => void;
  onError: (message: string) => void;
};

const labelClassName = "block text-sm text-[var(--text-2)]";
const checkboxInputClassName =
  "h-4 w-4 rounded border-[color:var(--line)] text-[var(--accent)] focus:ring-[rgba(59,130,246,0.35)]";

function cloneDailyReportTemplate(template: DailyReportTemplateConfig): DailyReportTemplateConfig {
  return JSON.parse(JSON.stringify(template)) as DailyReportTemplateConfig;
}

function resolveDailyReportTemplateFromJson(templateJson: string): DailyReportTemplateConfig {
  if (!templateJson.trim()) {
    return cloneDailyReportTemplate(DEFAULT_DAILY_REPORT_TEMPLATE);
  }

  return parseDailyReportTemplateJson(templateJson) ?? cloneDailyReportTemplate(DEFAULT_DAILY_REPORT_TEMPLATE);
}

function formatDailyReportGlobalRulesForEditor(rules: string[]) {
  return rules.map((rule) => `- ${rule}`).join("\n");
}

function parseDailyReportGlobalRulesFromEditor(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim().replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
    .filter(Boolean);
}

function FormBlock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className={labelClassName}>{label}</span>
      {children}
    </label>
  );
}

export function DailyReportTemplateEditor({ value, systemPrompt, onChange, onError }: DailyReportTemplateEditorProps) {
  const [expandedBlockIndexes, setExpandedBlockIndexes] = useState<Set<number>>(() => new Set([0]));
  const [draggingBlockIndex, setDraggingBlockIndex] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ index: number; title: string } | null>(null);

  let template: DailyReportTemplateConfig;
  try {
    template = resolveDailyReportTemplateFromJson(value);
  } catch {
    template = cloneDailyReportTemplate(DEFAULT_DAILY_REPORT_TEMPLATE);
  }
  let migrationStatus: ReturnType<typeof classifyDailyReportTemplateMigration> = "v2";
  try {
    migrationStatus = classifyDailyReportTemplateMigration(
      value.trim() ? JSON.parse(value) : DEFAULT_DAILY_REPORT_TEMPLATE,
      systemPrompt,
    );
  } catch {
    migrationStatus = "invalid";
  }
  const needsMigration = migrationStatus === "official_default_legacy" || migrationStatus === "custom_legacy_requires_migration";

  const updateTemplate = (mutator: (template: DailyReportTemplateConfig) => void) => {
    try {
      const nextTemplate = cloneDailyReportTemplate(resolveDailyReportTemplateFromJson(value));
      mutator(nextTemplate);
      const normalizedTemplate = normalizeDailyReportTemplateConfig(nextTemplate);

      onChange({
        templateJson: stringifyDailyReportTemplate(normalizedTemplate),
        systemPrompt: compileDailyReportTemplatePrompt(normalizedTemplate),
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : "日报模板格式无效。");
    }
  };

  const remapExpandedBlockIndexes = (fromIndex: number, toIndex: number) => {
    setExpandedBlockIndexes((current) => {
      const next = new Set<number>();
      for (const index of current) {
        if (index === fromIndex) {
          next.add(toIndex);
        } else if (fromIndex < toIndex && index > fromIndex && index <= toIndex) {
          next.add(index - 1);
        } else if (fromIndex > toIndex && index >= toIndex && index < fromIndex) {
          next.add(index + 1);
        } else {
          next.add(index);
        }
      }
      return next;
    });
  };

  const reorderBlock = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    updateTemplate((draft) => {
      const [movedBlock] = draft.blocks.splice(fromIndex, 1);
      if (!movedBlock) return;
      draft.blocks.splice(toIndex, 0, movedBlock);
    });
    remapExpandedBlockIndexes(fromIndex, toIndex);
  };

  const deleteBlock = (blockIndex: number) => {
    updateTemplate((draft) => {
      draft.blocks.splice(blockIndex, 1);
    });
    setExpandedBlockIndexes((current) => {
      const next = new Set<number>();
      for (const index of current) {
        if (index === blockIndex) continue;
        next.add(index > blockIndex ? index - 1 : index);
      }
      return next;
    });
  };

  const toggleBlockExpanded = (blockIndex: number) => {
    setExpandedBlockIndexes((current) => {
      const next = new Set(current);
      if (next.has(blockIndex)) {
        next.delete(blockIndex);
      } else {
        next.add(blockIndex);
      }
      return next;
    });
  };

  const handleBlockDrop = (event: DragEvent<HTMLDivElement>, blockIndex: number) => {
    event.preventDefault();
    if (draggingBlockIndex == null) return;
    reorderBlock(draggingBlockIndex, blockIndex);
    setDraggingBlockIndex(null);
  };

  return (
    <div className="space-y-4 rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-4">
      {needsMigration ? (
        <div className="flex flex-col gap-3 rounded-sm border border-[color:var(--warning-border,var(--line))] bg-[var(--bg-muted)] px-3 py-3 text-sm text-[var(--text-2)] sm:flex-row sm:items-center sm:justify-between">
          <span>{migrationStatus === "official_default_legacy" ? "检测到旧版官方日报模板，将按默认规则静默迁移为模板 v2。" : "检测到自定义旧版 opening/sections/closing 模板，请确认映射后迁移为模板 v2。"}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              try {
                const migrated = migrateLegacyDailyReportTemplate(JSON.parse(value));
                onChange({ templateJson: stringifyDailyReportTemplate(migrated), systemPrompt: compileDailyReportTemplatePrompt(migrated) });
              } catch (error) {
                onError(error instanceof Error ? error.message : "旧模板迁移失败。");
              }
            }}
          >
            迁移为模板 v2
          </Button>
        </div>
      ) : null}
      <FormBlock label="标题规则">
        <TextArea
          rows={3}
          value={template.headlineInstruction}
          onChange={(event) =>
            updateTemplate((draft) => {
              draft.headlineInstruction = event.target.value;
            })
          }
        />
      </FormBlock>

      <FormBlock label="内容全局规则">
        <TextArea
          rows={5}
          value={formatDailyReportGlobalRulesForEditor(template.globalRules)}
          onChange={(event) =>
            updateTemplate((draft) => {
              draft.globalRules = parseDailyReportGlobalRulesFromEditor(event.target.value);
            })
          }
        />
      </FormBlock>

      <FormBlock label="历史主题去重规则">
        <TextArea
          rows={4}
          value={formatDailyReportGlobalRulesForEditor(template.recentTopicRules)}
          onChange={(event) =>
            updateTemplate((draft) => {
              draft.recentTopicRules = parseDailyReportGlobalRulesFromEditor(event.target.value);
            })
          }
        />
      </FormBlock>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-[var(--text-1)]">内容块</div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const nextIndex = template.blocks.length;
                setExpandedBlockIndexes((current) => new Set([...current, nextIndex]));
                updateTemplate((draft) => {
                  draft.blocks.push({
                    type: "text",
                    title: "新文本块",
                    bodyInstruction: "说明这个文本块需要总结什么。",
                  });
                });
              }}
            >
              + 单段内容
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const nextIndex = template.blocks.length;
                setExpandedBlockIndexes((current) => new Set([...current, nextIndex]));
                updateTemplate((draft) => {
                  draft.blocks.push({
                    type: "section",
                    title: "新栏目",
                    description: "说明该栏目选择哪些内容，以及每条要写什么。为空时自动隐藏该栏目。",
                    item: {
                      bodyInstruction: "写清楚该条目的主要内容。",
                      notes: [],
                    },
                  });
                });
              }}
            >
              + 条目栏目
            </Button>
          </div>
        </div>

        {template.blocks.map((block, blockIndex) => (
          <div
            key={`${block.type}-${block.title}-${blockIndex}`}
            className={cx(
              "rounded-lg border border-[color:var(--line)] bg-[var(--surface)] transition hover:shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
              draggingBlockIndex === blockIndex ? "opacity-60 ring-2 ring-[rgba(59,130,246,0.35)]" : "",
            )}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => handleBlockDrop(event, blockIndex)}
          >
            <div className="flex items-center gap-2 rounded-t-lg bg-[var(--bg-muted)] px-3 py-2">
              <button
                type="button"
                draggable
                title="拖动调整顺序"
                aria-label="拖动调整顺序"
                className="cursor-grab rounded-sm px-1 text-[var(--text-3)] transition hover:text-[var(--text-2)] active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.35)]"
                onDragStart={(event) => {
                  setDraggingBlockIndex(blockIndex);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", String(blockIndex));
                }}
                onDragEnd={() => setDraggingBlockIndex(null)}
              >
                <IconGrip className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => toggleBlockExpanded(blockIndex)}
                className="flex min-w-0 flex-1 items-center justify-between gap-3 px-2 py-1.5 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/35"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-[var(--text-1)]">{block.title || `内容块 ${blockIndex + 1}`}</span>
                  <span className="text-xs text-[var(--text-3)]">
                    {block.type === "text"
                      ? "单段内容"
                      : `条目栏目 · ${block.item.notes.length} 个要点`}
                  </span>
                </span>
                <span className="shrink-0 text-[var(--text-3)]">
                  {expandedBlockIndexes.has(blockIndex) ? "收起" : "展开"}
                </span>
              </button>
              <IconButton
                size="sm"
                variant="secondary"
                title={template.blocks.length <= 1 ? "至少保留一个内容块" : "删除内容块"}
                disabled={template.blocks.length <= 1}
                onClick={() => setDeleteTarget({ index: blockIndex, title: block.title || `内容块 ${blockIndex + 1}` })}
              >
                <IconTrash className="h-4 w-4" />
              </IconButton>
            </div>
            {expandedBlockIndexes.has(blockIndex) && block.type === "text" ? (
              <div className="space-y-3 border-t border-[color:var(--line)] p-3">
                <FormBlock label="标题">
                  <TextInput
                    value={block.title}
                    onChange={(event) =>
                      updateTemplate((draft) => {
                        const target = draft.blocks[blockIndex];
                        if (target?.type === "text") target.title = event.target.value;
                      })
                    }
                  />
                </FormBlock>
                <FormBlock label="正文要求">
                  <TextArea
                    rows={3}
                    value={block.bodyInstruction}
                    onChange={(event) =>
                      updateTemplate((draft) => {
                        const target = draft.blocks[blockIndex];
                        if (target?.type === "text") target.bodyInstruction = event.target.value;
                      })
                    }
                  />
                </FormBlock>
              </div>
            ) : null}
            {expandedBlockIndexes.has(blockIndex) && block.type === "section" ? (
              <div className="space-y-3 border-t border-[color:var(--line)] p-3">
                <FormBlock label="标题">
                  <TextInput
                    value={block.title}
                    onChange={(event) =>
                      updateTemplate((draft) => {
                        const target = draft.blocks[blockIndex];
                        if (target?.type === "section") target.title = event.target.value;
                      })
                    }
                  />
                </FormBlock>
                <div className="space-y-2">
                  <span className={labelClassName}>栏目要求</span>
                  <TextArea
                    aria-label="栏目要求"
                    rows={3}
                    value={block.description}
                    onChange={(event) =>
                      updateTemplate((draft) => {
                        const target = draft.blocks[blockIndex];
                        if (target?.type === "section") target.description = event.target.value;
                      })
                    }
                  />
                </div>
                <FormBlock label="正文要求">
                  <TextArea
                    rows={3}
                    value={block.item.bodyInstruction}
                    onChange={(event) =>
                      updateTemplate((draft) => {
                        const target = draft.blocks[blockIndex];
                        if (target?.type === "section") target.item.bodyInstruction = event.target.value;
                      })
                    }
                  />
                </FormBlock>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <label className="flex items-center gap-2 text-sm text-[var(--text-2)]">
                    <input
                      className={checkboxInputClassName}
                      type="checkbox"
                      checked={block.required === true}
                      onChange={(event) => updateTemplate((draft) => {
                        const target = draft.blocks[blockIndex];
                        if (target?.type === "section") target.required = event.target.checked;
                      })}
                    />
                    条目数非空校验
                  </label>
                  <FormBlock label="最少条数">
                    <TextInput
                      type="number"
                      min={0}
                      value={block.minItems ?? 0}
                      onChange={(event) => updateTemplate((draft) => {
                        const target = draft.blocks[blockIndex];
                        if (target?.type === "section") target.minItems = Number.parseInt(event.target.value, 10) || 0;
                      })}
                    />
                  </FormBlock>
                  <FormBlock label="最多条数（留空不限）">
                    <TextInput
                      type="number"
                      min={0}
                      value={block.maxItems == null ? "" : block.maxItems}
                      onChange={(event) => updateTemplate((draft) => {
                        const target = draft.blocks[blockIndex];
                        if (target?.type === "section") target.maxItems = event.target.value.trim() ? Number.parseInt(event.target.value, 10) || 0 : null;
                      })}
                    />
                  </FormBlock>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-[var(--text-2)]">条目要点</div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        updateTemplate((draft) => {
                          const target = draft.blocks[blockIndex];
                          if (target?.type !== "section") return;
                          target.item.notes.push({
                            label: "要点",
                            required: true,
                            instruction: "写清楚该要点内容。",
                          });
                        })
                      }
                    >
                      + 添加要点
                    </Button>
                  </div>
                  {block.item.notes.map((note, noteIndex) => (
                    <div key={`${note.label}-${noteIndex}`} className="grid grid-cols-1 gap-2 rounded-sm bg-[var(--bg-muted)] p-3 sm:grid-cols-[minmax(8rem,1fr)_6rem_auto]">
                      <TextInput
                        aria-label="要点标签"
                        value={note.label}
                        onChange={(event) =>
                          updateTemplate((draft) => {
                            const target = draft.blocks[blockIndex];
                            if (target?.type === "section") target.item.notes[noteIndex].label = event.target.value;
                          })
                        }
                      />
                      <label className="flex items-center gap-2 text-sm text-[var(--text-2)]">
                        <input
                          className={checkboxInputClassName}
                          checked={note.required}
                          type="checkbox"
                          onChange={(event) =>
                            updateTemplate((draft) => {
                              const target = draft.blocks[blockIndex];
                              if (target?.type === "section") target.item.notes[noteIndex].required = event.target.checked;
                            })
                          }
                        />
                        必填
                      </label>
                      <IconButton
                        size="sm"
                        variant="secondary"
                        title="删除要点"
                        className="self-center"
                        onClick={() =>
                          updateTemplate((draft) => {
                            const target = draft.blocks[blockIndex];
                            if (target?.type === "section") target.item.notes.splice(noteIndex, 1);
                          })
                        }
                      >
                        <IconTrash className="h-4 w-4" />
                      </IconButton>
                      <div className="sm:col-span-3">
                        <TextArea
                          aria-label="要点要求"
                          rows={2}
                          value={note.instruction}
                          onChange={(event) =>
                            updateTemplate((draft) => {
                              const target = draft.blocks[blockIndex];
                              if (target?.type === "section") target.item.notes[noteIndex].instruction = event.target.value;
                            })
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <ModalShell
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="删除内容块"
        widthClassName="max-w-md"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDeleteTarget(null)} variant="secondary">
              取消
            </Button>
            <Button
              onClick={() => {
                if (!deleteTarget) return;
                deleteBlock(deleteTarget.index);
                setDeleteTarget(null);
              }}
              variant="danger"
            >
              删除
            </Button>
          </div>
        }
      >
        <p className="text-sm leading-6 text-[var(--text-2)]">
          确定要删除「{deleteTarget?.title ?? ""}」吗？删除后需要重新添加并配置。
        </p>
      </ModalShell>
    </div>
  );
}
