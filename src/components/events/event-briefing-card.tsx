import { IconButton } from "@/components/ui/icon-button";
import { IconThumbsDown, IconThumbsUp } from "@/components/ui/icons";
import type { EventBriefingEntryDTO } from "@/lib/events/types";
import { cx } from "@/lib/ui/cx";

type EventBriefingCardProps = {
  entry: EventBriefingEntryDTO;
  rank: number;
  isAdmin?: boolean;
  activeManualFeedback?: "manual_boost" | "manual_penalty" | null;
  onOpen: (entry: EventBriefingEntryDTO) => void;
  onManualFeedback?: (entry: EventBriefingEntryDTO, eventType: "manual_boost" | "manual_penalty") => void;
};

function formatUpdateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function formatRank(rank: number) {
  return `#${String(rank).padStart(2, "0")}`;
}

export function EventBriefingCard({
  entry,
  rank,
  isAdmin = false,
  activeManualFeedback = null,
  onOpen,
  onManualFeedback,
}: EventBriefingCardProps) {
  const statusLabel = entry.isFollowUp ? "新进展" : "新内容";
  const meta = [
    `${entry.sourceCount} 来源`,
    `${entry.itemCount} 条`,
    `${formatUpdateTime(entry.latestCreatedAt)} 更新`,
  ];

  return (
    <article className="grid gap-2 px-3 py-3 transition hover:bg-[var(--bg-muted)] sm:grid-cols-[2.75rem_minmax(0,1fr)] sm:px-4">
      <div className="flex h-6 items-center">
        <span className="font-mono text-xs font-semibold leading-6 text-[var(--text-3)]">
          {formatRank(rank)}
        </span>
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div className="flex min-h-6 min-w-0 items-center gap-2">
            <h2 className="line-clamp-2 min-w-0 text-[15px] font-semibold leading-6 text-[var(--text-1)] sm:text-base">
              <button
                className="text-left hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.35)]"
                type="button"
                onClick={() => onOpen(entry)}
              >
                {entry.title}
              </button>
            </h2>
            <span className="inline-flex h-5 shrink-0 items-center rounded-sm border border-[color:var(--line)] bg-[var(--bg-muted)] px-1.5 text-[11px] font-medium leading-none text-[var(--text-3)]">
              {statusLabel}
            </span>
          </div>
          <div className="flex min-h-6 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-6 text-[var(--text-3)] sm:justify-end">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {meta.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
            {isAdmin ? (
              <div className="flex items-center gap-0.5">
                <IconButton
                  variant="secondary"
                  size="sm"
                  title="提升事件偏好"
                  aria-label={`提升事件偏好：${entry.title}`}
                  aria-pressed={activeManualFeedback === "manual_boost"}
                  className={cx(
                    "p-1 text-[var(--accent)] hover:text-[var(--accent)]",
                    activeManualFeedback === "manual_boost"
                      ? "border-[var(--accent)] bg-[rgba(59,130,246,0.12)]"
                      : "",
                  )}
                  onClick={() => onManualFeedback?.(entry, "manual_boost")}
                >
                  <IconThumbsUp className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  variant="secondary"
                  size="sm"
                  title="降低事件偏好"
                  aria-label={`降低事件偏好：${entry.title}`}
                  aria-pressed={activeManualFeedback === "manual_penalty"}
                  className={cx(
                    "p-1 text-[var(--danger-ink)] hover:text-[var(--danger-ink)]",
                    activeManualFeedback === "manual_penalty"
                      ? "border-[var(--danger-ink)] bg-[var(--danger-surface)]"
                      : "",
                  )}
                  onClick={() => onManualFeedback?.(entry, "manual_penalty")}
                >
                  <IconThumbsDown className="h-3.5 w-3.5" />
                </IconButton>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}
