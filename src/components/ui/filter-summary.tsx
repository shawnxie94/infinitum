import type { ReactNode } from "react";

import { cx } from "@/lib/ui/cx";

type FilterSummaryProps = {
  items: string[];
  onClear: () => void;
  canClear: boolean;
  actions?: ReactNode;
  emptyLabel?: string;
  clearLabel?: string;
  details?: ReactNode;
  className?: string;
};

export function FilterSummary({
  items,
  onClear,
  canClear,
  actions,
  emptyLabel = "暂无筛选条件",
  clearLabel = "清除筛选",
  details,
  className,
}: FilterSummaryProps) {
  return (
    <div className={cx("border-t border-[color:var(--line)] pt-2.5", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {items.length === 0 ? (
          <span className="text-sm text-[var(--text-3)]">{emptyLabel}</span>
        ) : (
          items.map((item) => (
            <span key={item} className="filter-chip rounded-sm px-2.5 py-1 text-sm">
              {item}
            </span>
          ))
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onClear}
            className={cx(
              "lumina-home-action-button ml-auto px-3 py-1 text-sm rounded-sm transition",
              canClear
                ? "lumina-home-action-button--clear bg-[var(--surface)] text-[var(--text-2)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]"
                : "lumina-home-action-button--disabled cursor-not-allowed bg-[var(--bg-muted)] text-[var(--text-3)]",
            )}
            disabled={!canClear}
          >
            {clearLabel}
          </button>
          {actions}
        </div>
      </div>
      {details ? <div className="mt-3 flex flex-col gap-1 text-sm text-[var(--text-2)]">{details}</div> : null}
    </div>
  );
}
