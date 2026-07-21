import { FilterControl } from "@/components/ui/filter-control";
import { SelectField } from "@/components/ui/select-field";

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

export function FilterSelect({
  label,
  value,
  onChange,
  options,
  placeholder,
  id,
  showSearch,
  ariaLabel,
  layout = "stack",
  className,
  selectClassName = "w-full",
}: FilterSelectProps) {
  const selectId = id || `filter-select-${label}`;

  return (
    <FilterControl label={label} htmlFor={selectId} layout={layout} className={className} controlClassName={selectClassName}>
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
