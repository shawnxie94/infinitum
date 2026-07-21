import type { ChangeEvent } from "react";

import { FilterControl } from "@/components/ui/filter-control";
import { TextInput } from "@/components/ui/text-input";

type FilterInputProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "number" | "date";
  id?: string;
  ariaLabel?: string;
  layout?: "inline" | "stack";
  className?: string;
  inputClassName?: string;
  compact?: boolean;
};

export function FilterInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  id,
  ariaLabel,
  layout = "stack",
  className,
  inputClassName,
  compact = false,
}: FilterInputProps) {
  const inputId = id || `filter-input-${label}`;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.value);
  };

  return (
    <FilterControl label={label} htmlFor={inputId} layout={layout} className={className} controlClassName={inputClassName}>
      <TextInput
        id={inputId}
        aria-label={ariaLabel ?? label.replace(/[：:]\s*$/, "").trim()}
        type={type}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        compact={compact || layout === "inline"}
        className="w-full"
      />
    </FilterControl>
  );
}
