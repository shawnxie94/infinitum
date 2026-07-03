import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextInput } from "@/components/ui/text-input";
import { cx } from "@/lib/ui/cx";

type PaginationControlsProps = {
  totalItems: number;
  page: number;
  totalPages: number;
  pageSize: number;
  pageSizeOptions?: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  className?: string;
  disabled?: boolean;
  nextLabel?: string;
  itemLabel?: string;
  totalLabel?: string;
  jumpValue?: string;
  onJumpValueChange?: (value: string) => void;
  onJump?: () => void;
};

const defaultPageSizeOptions = [10, 20, 50] as const;

export function PaginationControls({
  totalItems,
  page,
  totalPages,
  pageSize,
  pageSizeOptions = defaultPageSizeOptions,
  onPageChange,
  onPageSizeChange,
  className,
  disabled = false,
  nextLabel = "下一页",
  itemLabel = "条",
  totalLabel = itemLabel,
  jumpValue,
  onJumpValueChange,
  onJump,
}: PaginationControlsProps) {
  const canGoPrevious = page > 1 && !disabled;
  const canGoNext = page < totalPages && !disabled;
  const showJump = jumpValue !== undefined && onJumpValueChange && onJump;

  return (
    <div className={cx("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--muted)]">
        <span>每页显示</span>
        <SelectField
          aria-label="每页显示"
          value={pageSize}
          onChange={(value) => onPageSizeChange(Number(value))}
          style={{ width: 80 }}
          compact
          disabled={disabled}
          showSearch={false}
          options={pageSizeOptions.map((option) => ({
            value: option,
            label: String(option),
          }))}
        />
        <span className="whitespace-nowrap">{itemLabel}，共 {totalItems} {totalLabel}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={!canGoPrevious}>
          上一页
        </Button>
        <span className="min-w-[100px] rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-4 py-2 text-center text-sm text-[var(--muted)]">
          第 {page} / {totalPages} 页
        </span>
        <Button variant="secondary" size="sm" onClick={() => onPageChange(Math.min(totalPages, page + 1))} disabled={!canGoNext}>
          {nextLabel}
        </Button>
        {showJump ? (
          <div className="ml-2 flex flex-none items-center gap-1 whitespace-nowrap">
            <TextInput
              aria-label="跳转页码"
              type="number"
              value={jumpValue}
              onChange={(event) => onJumpValueChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onJump();
                }
              }}
              className="w-16 text-center"
              compact
              min={1}
              max={totalPages}
              disabled={disabled}
            />
            <Button onClick={onJump} variant="primary" size="sm" className="whitespace-nowrap" disabled={disabled}>
              跳转
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
