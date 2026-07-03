import { Select } from "antd";
import type { SelectProps } from "antd";
import type { CSSProperties } from "react";

import {
  denormalizeSingleSelectValue,
  EMPTY_SELECT_VALUE_SENTINEL,
  normalizeSingleSelectOptions,
  normalizeSingleSelectValue,
} from "@/components/ui/select-field-value";

type SelectFieldProps = SelectProps & {
  compact?: boolean;
  multiline?: boolean;
};

const normalizeText = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");

const defaultFilterOption: NonNullable<SelectProps["filterOption"]> = (input, option) => {
  if (!option || typeof option !== "object") {
    return false;
  }

  const record = option as {
    label?: unknown;
    children?: unknown;
    value?: unknown;
  };
  const optionText = normalizeText(record.label ?? record.children ?? record.value);
  const query = normalizeText(input);

  if (!query) {
    return true;
  }

  return optionText.includes(query);
};

export function SelectField({
  compact = false,
  multiline = false,
  className = "",
  popupClassName = "",
  style,
  showSearch,
  optionFilterProp,
  filterOption,
  placeholder,
  options,
  value,
  onChange,
  ...props
}: SelectFieldProps) {
  const height = compact ? 32 : 36;
  const isMultiMode = props.mode === "multiple" || props.mode === "tags";
  const isTestEnvironment = process.env.NODE_ENV === "test";
  const sizeClass = multiline && isMultiMode ? "" : compact ? "h-8" : "h-9";
  const multiLayoutClass = isMultiMode
    ? multiline
      ? "select-modern-antd-multiline"
      : "select-modern-antd-singleline-multiple"
    : "";
  const resolvedClassName = `select-modern-antd ${sizeClass} ${multiLayoutClass} ${className}`.trim();
  const resolvedPopupClassName = `select-modern-dropdown ${popupClassName}`.trim();
  const rawSingleOptions = options as Array<Record<string, unknown>> | undefined;
  const hasEmptyOption = rawSingleOptions?.some((option) => option.value === "") ?? false;
  const resolvedOptions = isMultiMode
    ? options
    : normalizeSingleSelectOptions(rawSingleOptions);
  const resolvedValue = isMultiMode
    ? value
    : value === "" && !hasEmptyOption
      ? undefined
      : normalizeSingleSelectValue(value);
  const resolvedStyle: CSSProperties = {
    width: "100%",
    ...(multiline && isMultiMode ? { minHeight: height } : { height }),
    ...style,
  };

  if (isTestEnvironment && isMultiMode) {
    const nativeOptions = (resolvedOptions as Array<{ label?: unknown; value?: unknown }> | undefined) ?? [];
    const nativeValue = Array.isArray(resolvedValue) ? resolvedValue.map((entry) => String(entry)) : [];

    return (
      <select
        id={props.id}
        aria-label={props["aria-label"]}
        className={`${resolvedClassName} select-modern`.trim()}
        style={resolvedStyle}
        value={nativeValue}
        disabled={props.disabled}
        multiple
        onChange={(event) => {
          if (!onChange) {
            return;
          }

          const nextValue = Array.from(event.currentTarget.selectedOptions).map((option) => option.value);
          onChange(nextValue, undefined as never);
        }}
      >
        {nativeOptions.map((option) => (
          <option key={String(option.value ?? option.label ?? "")} value={String(option.value ?? "")}>
            {String(option.label ?? option.value ?? "")}
          </option>
        ))}
      </select>
    );
  }

  if (isTestEnvironment && !isMultiMode) {
    const nativeOptions = (resolvedOptions as Array<{ label?: unknown; value?: unknown }> | undefined) ?? [];
    const nativeValue = resolvedValue == null && placeholder ? EMPTY_SELECT_VALUE_SENTINEL : String(resolvedValue ?? "");

    return (
      <select
        id={props.id}
        aria-label={props["aria-label"]}
        className={`${resolvedClassName} select-modern`.trim()}
        style={resolvedStyle}
        value={nativeValue}
        disabled={props.disabled}
        onChange={(event) => {
          if (!onChange) {
            return;
          }

          onChange(denormalizeSingleSelectValue(event.target.value), undefined as never);
        }}
      >
        {placeholder ? <option value={EMPTY_SELECT_VALUE_SENTINEL}>{placeholder}</option> : null}
        {nativeOptions.map((option) => (
          <option key={String(option.value ?? option.label ?? "")} value={String(option.value ?? "")}>
            {String(option.label ?? option.value ?? "")}
          </option>
        ))}
      </select>
    );
  }

  return (
    <Select
      {...props}
      className={resolvedClassName}
      classNames={{
        popup: {
          root: resolvedPopupClassName,
        },
      }}
      style={resolvedStyle}
      options={resolvedOptions}
      value={resolvedValue}
      onChange={(nextValue, option) => {
        if (!onChange) {
          return;
        }

        onChange(isMultiMode ? nextValue : denormalizeSingleSelectValue(nextValue), option);
      }}
      showSearch={showSearch ?? true}
      optionFilterProp={optionFilterProp ?? "label"}
      filterOption={filterOption ?? defaultFilterOption}
    />
  );
}
