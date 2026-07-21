import { FilterControl } from "@/components/ui/filter-control";
import { SelectField } from "@/components/ui/select-field";

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
  showSearch,
  ariaLabel,
}: FilterSelectInlineProps) {
  const selectId = id || `filter-select-inline-${label}`;

  return (
    <FilterControl label={label} htmlFor={selectId} layout="inline" className={className} controlClassName={selectClassName}>
      <SelectField
        id={selectId}
        aria-label={ariaLabel ?? label.replace(/[：:]\s*$/, "").trim()}
        value={value}
        onChange={(nextValue) => onChange(String(nextValue ?? ""))}
        options={options}
        placeholder={placeholder}
        showSearch={showSearch}
        className="w-full"
      />
    </FilterControl>
  );
}
