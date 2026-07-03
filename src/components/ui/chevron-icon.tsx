import { cx } from "@/lib/ui/cx";

export function ChevronIcon({ expanded, className }: { expanded: boolean; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cx("h-4 w-4 transition", expanded ? "rotate-180" : "", className)}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
