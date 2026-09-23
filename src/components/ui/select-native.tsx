import type { CSSProperties } from "react";

import {
  denormalizeSingleSelectValue,
  EMPTY_SELECT_VALUE_SENTINEL,
  normalizeSingleSelectOptions,
  normalizeSingleSelectValue,
} from "@/components/ui/select-field-value";
import { cx } from "@/lib/ui/cx";

type SelectNativeOption = {
  value: string | number;
  label: string;
};

type SelectNativeProps = {
  value?: string | number | null;
  onChange?: (value: string) => void;
  options: readonly SelectNativeOption[];
  placeholder?: string;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  "aria-label"?: string;
};

// 原生 <select> 版 SelectField（单选、无搜索面板），样式复用 .select-modern，
// 供公共页面使用，避免为简单筛选引入 antd。
export function SelectNative({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  compact = false,
  className = "",
  style,
  id,
  ...aria
}: SelectNativeProps) {
  const rawOptions = options ?? [];
  const hasEmptyOption = rawOptions.some((option) => option.value === "");
  const resolvedOptions = normalizeSingleSelectOptions([...rawOptions]) ?? [];
  const resolvedValue = value === "" && !hasEmptyOption ? undefined : normalizeSingleSelectValue(value);
  const nativeValue = resolvedValue == null && placeholder ? EMPTY_SELECT_VALUE_SENTINEL : String(resolvedValue ?? "");

  return (
    <select
      id={id}
      aria-label={aria["aria-label"]}
      className={cx("select-modern", compact ? "h-8" : "h-9", className)}
      style={{ width: "100%", height: compact ? 32 : 36, ...style }}
      value={nativeValue}
      disabled={disabled}
      onChange={(event) => {
        onChange?.(String(denormalizeSingleSelectValue(event.target.value)));
      }}
    >
      {placeholder ? <option value={EMPTY_SELECT_VALUE_SENTINEL}>{placeholder}</option> : null}
      {resolvedOptions.map((option) => (
        <option key={String(option.value ?? "")} value={String(option.value ?? "")}>
          {String(option.label ?? option.value ?? "")}
        </option>
      ))}
    </select>
  );
}
