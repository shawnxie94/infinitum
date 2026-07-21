import type { ReactNode } from "react";

import { cx } from "@/lib/ui/cx";

export type FilterControlLayout = "inline" | "stack";

type FilterControlProps = {
  label: string;
  htmlFor?: string;
  layout?: FilterControlLayout;
  className?: string;
  controlClassName?: string;
  children: ReactNode;
};

export function normalizeFilterLabel(label: string) {
  return label.replace(/[：:]\s*$/, "").trim();
}

export function formatInlineFilterLabel(label: string) {
  const normalized = normalizeFilterLabel(label);
  return normalized ? `${normalized}：` : "";
}

export function FilterControl({
  label,
  htmlFor,
  layout = "inline",
  className,
  controlClassName,
  children,
}: FilterControlProps) {
  const normalizedLabel = normalizeFilterLabel(label);

  if (layout === "stack") {
    return (
      <div className={cx("min-w-0", className)}>
        {normalizedLabel ? (
          <label htmlFor={htmlFor} className="mb-1.5 block text-sm text-[var(--muted)]">
            {normalizedLabel}
          </label>
        ) : null}
        <div className={cx("min-w-0", controlClassName)}>{children}</div>
      </div>
    );
  }

  return (
    <div className={cx("flex min-w-0 items-center gap-2", className)}>
      {normalizedLabel ? (
        <label htmlFor={htmlFor} className="shrink-0 whitespace-nowrap text-sm text-[var(--text-2)]">
          {formatInlineFilterLabel(normalizedLabel)}
        </label>
      ) : null}
      <div className={cx("min-w-0 flex-1", controlClassName)}>{children}</div>
    </div>
  );
}
