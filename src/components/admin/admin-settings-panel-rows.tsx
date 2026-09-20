import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";

import { IconButton } from "@/components/ui/icon-button";
import { IconCheck, IconEdit, IconGrip, IconLink, IconTag, IconTrash, IconX } from "@/components/ui/icons";
import { TextInput } from "@/components/ui/text-input";
import type { AdminSettingsSnapshot } from "@/lib/settings/types";
import { getStableGroupBadgeColor } from "@/lib/groups/badge";
import { cx } from "@/lib/ui/cx";
import { settingsNavItems, surfaceCardClassName, type AdminSettingsSection } from "@/components/admin/admin-settings-panel.helpers";


export function AdminWorkspaceSidebar({
  activeSection,
  onSelect,
}: {
  activeSection: AdminSettingsSection;
  onSelect: (section: AdminSettingsSection) => void;
}) {
  return (
    <aside
      aria-label="设置导航"
      className={cx(surfaceCardClassName, "p-3.5 xl:sticky xl:top-24")}
    >
      <div
                        aria-label="设置实体"
        className="space-y-1.5"
        role="tablist"
        aria-orientation="vertical"
      >
        {settingsNavItems.map((item) => {
          const isActive = item.key === activeSection;

          return (
            <button
              key={item.key}
              aria-controls={`settings-panel-${item.key}`}
              aria-label={item.label}
              aria-selected={isActive}
              className={cx(
                "flex w-full rounded-[1rem] border px-3 py-3 text-left text-sm font-semibold transition",
                isActive
                  ? "border-[color:var(--line-strong)] bg-[var(--surface-highlight)] shadow-[var(--shadow-sm)]"
                  : "border-transparent bg-transparent hover:border-[color:var(--line)] hover:bg-[var(--surface)]",
              )}
              id={`settings-tab-${item.key}`}
              role="tab"
              type="button"
              onClick={() => onSelect(item.key)}
            >
              <span className="block text-[var(--foreground)]">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

export function HeaderLinkRow({
  link,
  onEdit,
  onDelete,
}: {
  link: NonNullable<AdminSettingsSnapshot["headerLinks"]>[number];
  onEdit: (link: NonNullable<AdminSettingsSnapshot["headerLinks"]>[number]) => void;
  onDelete: (link: NonNullable<AdminSettingsSnapshot["headerLinks"]>[number]) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: link.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cx(
        "rounded-lg border border-[color:var(--line)] bg-[var(--surface)] px-3 py-3 transition hover:shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
        isDragging && "opacity-60 ring-2 ring-[rgba(59,130,246,0.35)]",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="cursor-grab rounded-sm px-1 text-[var(--text-3)] transition hover:text-[var(--text-2)] active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.35)]"
            title="拖动排序"
            aria-label="拖动排序"
          >
            <IconGrip className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--text-1)]">
                {link.label}
              </h3>
              <span
                className={cx(
                  "rounded-sm px-2 py-0.5 text-xs",
                  link.enabled
                    ? "bg-[var(--success-surface)] text-[var(--success-ink)]"
                    : "bg-[var(--bg-muted)] text-[var(--text-3)]",
                )}
              >
                {link.enabled ? "启用" : "停用"}
              </span>
              <span className="rounded-sm bg-[var(--bg-muted)] px-2 py-0.5 text-xs text-[var(--text-2)]">
                {link.openInNewTab ? "新窗口" : "当前页"}
              </span>
              {link.rel.includes("sponsored") ? (
                <span className="rounded-sm bg-[var(--accent-soft)] px-2 py-0.5 text-xs text-[var(--accent)]">
                  AFF/赞助
                </span>
              ) : null}
            </div>
            <a
              className="mt-1 block truncate text-sm text-[var(--text-3)] hover:text-[var(--accent)]"
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {link.url}
            </a>
          </div>
        </div>

        <div className="flex gap-1">
          <IconButton
            variant="secondary"
            size="sm"
            title="编辑"
            onClick={() => onEdit(link)}
          >
            <IconEdit className="h-4 w-4" />
          </IconButton>
          <IconButton
            variant="secondary"
            size="sm"
            title="删除"
            className="text-[var(--danger-ink)] hover:bg-[var(--danger-surface)] hover:text-[var(--danger-ink)]"
            onClick={() => onDelete(link)}
          >
            <IconTrash className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

export function GroupRow({
  group,
  submitJson,
  onOpenSourceLink,
}: {
  group: AdminSettingsSnapshot["groups"][number];
  submitJson: (
    url: string,
    method: string,
    body: unknown,
    successMessage: string,
    reload?: boolean,
    onSuccess?: () => void,
  ) => void;
  onOpenSourceLink: (group: AdminSettingsSnapshot["groups"][number]) => void;
}) {
  const [name, setName] = useState(group.name);
  const [isEditing, setIsEditing] = useState(false);
  const initial = group.name.charAt(0).toUpperCase();
  const badgeColor = group.color || getStableGroupBadgeColor(group.name);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: group.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cx(
        "rounded-lg border border-[color:var(--line)] bg-[var(--surface)] px-3 py-3 transition hover:shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
        isDragging && "opacity-60 ring-2 ring-[rgba(59,130,246,0.35)]",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="cursor-grab rounded-sm px-1 text-[var(--text-3)] transition hover:text-[var(--text-2)] active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.35)]"
            title="拖动排序"
            aria-label="拖动排序"
          >
            <IconGrip className="h-4 w-4" />
          </button>
          <div
            className="flex h-8 w-8 items-center justify-center rounded text-sm font-bold text-white"
            style={{ backgroundColor: badgeColor }}
          >
            {initial || <IconTag className="h-4 w-4" />}
          </div>
          <div className="min-w-0">
            {isEditing ? (
              <TextInput
                className="min-w-[12rem]"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            ) : (
              <h3 className="text-sm font-semibold text-[var(--text-1)]">
                {group.name}
              </h3>
            )}
          </div>
        </div>

        <div className="flex gap-1">
          {isEditing ? (
            <>
              <IconButton
                variant="secondary"
                size="sm"
                title="保存"
                onClick={() => {
                  submitJson(
                    `/api/admin/settings/groups/${group.id}`,
                    "PATCH",
                    { name },
                    "分组已更新。",
                  );
                  setIsEditing(false);
                }}
                disabled={!name.trim()}
              >
                <IconCheck className="h-4 w-4" />
              </IconButton>
              <IconButton
                variant="secondary"
                size="sm"
                title="取消"
                onClick={() => {
                  setName(group.name);
                  setIsEditing(false);
                }}
              >
                <IconX className="h-4 w-4" />
              </IconButton>
            </>
          ) : (
            <IconButton
              variant="secondary"
              size="sm"
              title="编辑"
              onClick={() => setIsEditing(true)}
            >
              <IconEdit className="h-4 w-4" />
            </IconButton>
          )}
          <IconButton
            variant="secondary"
            size="sm"
            title="关联信息源"
            aria-label={`关联信息源：${group.name}`}
            onClick={() => onOpenSourceLink(group)}
          >
            <IconLink className="h-4 w-4" />
          </IconButton>
          <IconButton
            variant="secondary"
            size="sm"
            title="删除"
            className="text-[var(--danger-ink)] hover:bg-[var(--danger-surface)] hover:text-[var(--danger-ink)]"
            onClick={() =>
              submitJson(
                `/api/admin/settings/groups/${group.id}`,
                "DELETE",
                {},
                "分组已删除。",
                true,
              )
            }
          >
            <IconTrash className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
