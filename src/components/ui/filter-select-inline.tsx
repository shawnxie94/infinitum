import { FilterControl } from "@/components/ui/filter-control";
import { SelectNative } from "@/components/ui/select-native";

type FilterSelectInlineOption = {
  value: string;
  label: string;
};

type FilterSelectInlineProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: FilterSelectInlineOption[];
  placeholder?: string;
  id?: string;
  className?: string;
  selectClassName?: string;
  showSearch?: boolean;
  ariaLabel?: string;
};

export function FilterSelectInline({
  label,
  value,
  onChange,
  options,
  placeholder,
  id,
  className = "",
  selectClassName = "w-28",
  ariaLabel,
}: FilterSelectInlineProps) {
  const selectId = id || `filter-select-inline-${label}`;

  return (
    <FilterControl label={label} htmlFor={selectId} layout="inline" className={className} controlClassName={selectClassName}>
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
