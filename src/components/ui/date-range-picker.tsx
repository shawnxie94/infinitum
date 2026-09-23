import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import type { CSSProperties } from "react";

type DateRangeValue = [Dayjs | null, Dayjs | null] | null;

type DateRangePickerProps = {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  placeholder?: [string, string];
  className?: string;
  style?: CSSProperties;
  id?: string;
};

// 原生 <input type="date"> 版日期区间，保持 antd RangePicker 的 Dayjs 值契约，
// 供公共 feed 页面使用；admin 不引用本组件。
export function DateRangePicker({ value, onChange, className, style, id }: DateRangePickerProps) {
  const [start, end] = value ?? [null, null];
  const toInputValue = (date: Dayjs | null) => (date && date.isValid() ? date.format("YYYY-MM-DD") : "");
  const handleChange = (index: 0 | 1) => (raw: string) => {
    const parsed = raw ? dayjs(raw) : null;
    if (raw && !parsed?.isValid()) {
      return;
    }
    const nextStart = index === 0 ? parsed : start;
    const nextEnd = index === 1 ? parsed : end;
    onChange(nextStart || nextEnd ? [nextStart, nextEnd] : null);
  };

  return (
    <div
      id={id}
      className={`flex items-center gap-1 rounded-md border border-[color:var(--control-line)] bg-[var(--control-surface)] px-2 ${className ?? ""}`}
      style={{ height: 36, ...style }}
    >
      <input
        type="date"
        aria-label="开始日期"
        value={toInputValue(start)}
        onChange={(event) => handleChange(0)(event.target.value)}
        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--foreground)] outline-none"
      />
      <span aria-hidden className="text-[var(--muted)]">
        –
      </span>
      <input
        type="date"
        aria-label="结束日期"
        value={toInputValue(end)}
        onChange={(event) => handleChange(1)(event.target.value)}
        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--foreground)] outline-none"
      />
    </div>
  );
}
