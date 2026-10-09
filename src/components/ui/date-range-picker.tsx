import { ConfigProvider, DatePicker } from "antd";
import type { Dayjs } from "dayjs";
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

export function DateRangePicker({ value, onChange, placeholder, className, style, id }: DateRangePickerProps) {
  const resolvedPlaceholder = placeholder || ["开始日期", "结束日期"];

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#3B82F6",
          borderRadius: 4,
          fontSize: 14,
          controlHeight: 36,
        },
      }}
    >
      <DatePicker.RangePicker
        id={id}
        value={value}
        onChange={(nextValue) => onChange(nextValue)}
        className={className}
        size="middle"
        allowClear
        placeholder={resolvedPlaceholder}
        format="YYYY-MM-DD"
        style={{ height: 36, width: "100%", minWidth: 0, ...style }}
      />
    </ConfigProvider>
  );
}
