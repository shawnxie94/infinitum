"use client";

import { StatusTag } from "@/components/ui/status-tag";
import {
  parseDailyReportTemplateJson,
  type NormalizedDailyReportTemplate,
  type DailyReportTemplateSectionBlock,
} from "@/lib/daily-report/template";

type DailyReportTemplatePreviewProps = {
  templateJson: string | null | undefined;
};

function RuleList({ rules }: { rules: string[] }) {
  if (rules.length === 0) {
    return <p className="text-sm text-[var(--text-3)]">未配置</p>;
  }

  return (
    <ul className="space-y-2 text-sm leading-6 text-[var(--text-2)]">
      {rules.map((rule, index) => (
        <li key={`${rule}-${index}`} className="flex gap-2">
          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" aria-hidden="true" />
          <span>{rule}</span>
        </li>
      ))}
    </ul>
  );
}

function formatItemRange(block: DailyReportTemplateSectionBlock) {
  const minItems = block.minItems ?? 0;
  if (block.maxItems == null) return `${minItems} 条起`;
  if (minItems === block.maxItems) return `${minItems} 条`;
  return `${minItems}-${block.maxItems} 条`;
}

function SectionBlockPreview({ block }: { block: DailyReportTemplateSectionBlock }) {
  return (
    <div className="space-y-3 border-t border-[color:var(--line)] pt-3">
        <div>
          <div className="mb-1 text-xs font-medium text-[var(--text-3)]">栏目要求</div>
          <p className="text-sm leading-6 text-[var(--text-2)]">{block.description}</p>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-[var(--text-3)]">
            <span>正文要求</span>
            <StatusTag tone={block.item.bodyRequired === false ? "neutral" : "warning"}>
              {block.item.bodyRequired === false ? "可为空" : "必填"}
            </StatusTag>
          </div>
          <p className="text-sm leading-6 text-[var(--text-2)]">{block.item.bodyInstruction}</p>
        </div>
        <div>
          <div className="mb-2 text-xs font-medium text-[var(--text-3)]">条目要点</div>
          {block.item.notes.length > 0 ? (
            <div className="space-y-2">
              {block.item.notes.map((note) => (
                <div key={`${block.title}-${note.label}`} className="rounded-md bg-[var(--bg-muted)] px-3 py-2">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-[var(--text-1)]">{note.label}</span>
                    <StatusTag tone={note.required ? "warning" : "neutral"}>
                      {note.required ? "必填" : "可选"}
                    </StatusTag>
                  </div>
                  <p className="text-sm leading-6 text-[var(--text-2)]">{note.instruction}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[var(--text-3)]">无条目要点</p>
          )}
        </div>
    </div>
  );
}

function parseTemplate(templateJson: string | null | undefined): NormalizedDailyReportTemplate | null {
  try {
    return parseDailyReportTemplateJson(templateJson);
  } catch {
    return null;
  }
}

export function DailyReportTemplatePreview({ templateJson }: DailyReportTemplatePreviewProps) {
  const template = parseTemplate(templateJson);

  if (!template) {
    return (
      <div className="rounded-lg border border-[color:var(--warning-line)] bg-[var(--warning-surface)] px-4 py-3 text-sm text-[var(--warning-ink)]">
        日报模板暂时无法预览，请先在编辑中完成模板迁移或修复。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-[color:var(--line)] bg-[var(--surface)] p-4">
        <div className="mb-3 text-sm font-medium text-[var(--text-1)]">标题规则</div>
        <p className="text-sm leading-6 text-[var(--text-2)]">{template.headlineInstruction}</p>
      </section>

      <div className="space-y-3">
        <section className="rounded-lg border border-[color:var(--line)] bg-[var(--surface)] p-4">
          <div className="mb-3 text-sm font-medium text-[var(--text-1)]">正文通用规则</div>
          <RuleList rules={template.globalRules} />
        </section>
        <section className="rounded-lg border border-[color:var(--line)] bg-[var(--surface)] p-4">
          <div className="mb-3 text-sm font-medium text-[var(--text-1)]">历史主题识别策略</div>
          <RuleList rules={template.recentTopicRules} />
        </section>
      </div>

      <section className="space-y-3">
        <div className="text-sm font-medium text-[var(--text-1)]">内容块</div>
        {template.blocks.map((block) => (
          <article key={`${block.type}-${block.title}`} className="rounded-lg border border-[color:var(--line)] bg-[var(--surface)] p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h4 className="font-medium text-[var(--text-1)]">{block.title}</h4>
                {block.type === "section" ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusTag tone={block.required ? "info" : "neutral"}>
                      {block.required ? "必填栏目" : "可选栏目"}
                    </StatusTag>
                    <StatusTag tone="neutral">{formatItemRange(block)}</StatusTag>
                  </div>
                ) : null}
              </div>
              <StatusTag tone="neutral" className="shrink-0">
                {block.type === "text" ? "单段内容" : "条目栏目"}
              </StatusTag>
            </div>
            {block.type === "section" ? <SectionBlockPreview block={block} /> : null}
            {block.type === "text" ? (
              <div className="border-t border-[color:var(--line)] pt-3">
                <div className="mb-1 text-xs font-medium text-[var(--text-3)]">正文要求</div>
                <p className="text-sm leading-6 text-[var(--text-2)]">{block.bodyInstruction}</p>
              </div>
            ) : null}
          </article>
        ))}
      </section>
    </div>
  );
}
