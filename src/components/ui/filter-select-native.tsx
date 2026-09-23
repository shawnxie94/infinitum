import { FilterControl } from "@/components/ui/filter-control";
import { SelectNative } from "@/components/ui/select-native";

type FilterSelectOption = {
  value: string;
  label: string;
};

type FilterSelectProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: FilterSelectOption[];
  placeholder?: string;
  id?: string;
  showSearch?: boolean;
  ariaLabel?: string;
  layout?: "inline" | "stack";
  className?: string;
  selectClassName?: string;
};

// 公共页面用的原生 select 筛选器；admin 面板继续用 antd 版 filter-select.tsx。
export function FilterSelectNative({
  label,
  value,
  onChange,
  options,
  placeholder,
  id,
  ariaLabel,
  layout = "stack",
  className,
  selectClassName = "w-full",
}: FilterSelectProps) {
  const selectId = id || `filter-select-${label}`;

  return (
    <FilterControl label={label} htmlFor={selectId} layout={layout} className={className} controlClassName={selectClassName}>
      <SelectNative
        id={selectId}
        aria-label={ariaLabel ?? label.replace(/[：:]\s*$/, "").trim()}
        value={value}
        onChange={(nextValue) => onChange(String(nextValue ?? ""))}
        options={options}
        placeholder={placeholder}
        className="w-full"
      />
    </FilterControl>
  );
}
