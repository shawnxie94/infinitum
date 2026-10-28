"use client";

import { useCallback, useEffect, useState } from "react";

import { checkboxInputClassName } from "@/components/admin/admin-settings-panel.helpers";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { IconCheck, IconEdit, IconPlus, IconTrash, IconX } from "@/components/ui/icons";
import { ModalShell } from "@/components/ui/modal-shell";
import { TextArea } from "@/components/ui/text-area";
import { TextInput } from "@/components/ui/text-input";
import { useToast } from "@/components/ui/toast";

export type AdminEventType = {
  id: string;
  key: string;
  label: string;
  description: string | null;
  aliases: string[];
  enabled: boolean;
  sortOrder: number;
};

type EventTypeDraft = {
  key: string;
  label: string;
  description: string;
  aliases: string;
  enabled: boolean;
};

const EMPTY_DRAFT: EventTypeDraft = { key: "", label: "", description: "", aliases: "", enabled: true };

function parseAliasesInput(value: string) {
  return [...new Set(
    value
      .split(/[、,，\n]/u)
      .map((alias) => alias.trim())
      .filter(Boolean),
  )];
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }

  return payload;
}

export function EventTypeSettingsPanel() {
  const { showToast } = useToast();
  const [eventTypes, setEventTypes] = useState<AdminEventType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<EventTypeDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<AdminEventType | null>(null);
  const [editDraft, setEditDraft] = useState<EventTypeDraft>(EMPTY_DRAFT);
  const [pendingDelete, setPendingDelete] = useState<AdminEventType | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await requestJson<{ eventTypes: AdminEventType[] }>("/api/admin/event-types");
      setEventTypes(result.eventTypes);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "加载事件类型失败");
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    setIsBusy(true);
    try {
      await requestJson("/api/admin/event-types", {
        method: "POST",
        body: JSON.stringify({
          key: createDraft.key.trim() || null,
          label: createDraft.label.trim(),
          description: createDraft.description.trim() || null,
          aliases: parseAliasesInput(createDraft.aliases),
          enabled: createDraft.enabled,
        }),
      });
      setCreateOpen(false);
      setCreateDraft(EMPTY_DRAFT);
      showToast("事件类型已创建。");
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "创建失败");
    } finally {
      setIsBusy(false);
    }
  };

  const openEdit = (eventType: AdminEventType) => {
    setEditing(eventType);
    setEditDraft({
      key: eventType.key,
      label: eventType.label,
      description: eventType.description ?? "",
      aliases: eventType.aliases.join("、"),
      enabled: eventType.enabled,
    });
  };

  const handleUpdate = async () => {
    if (!editing) {
      return;
    }
    setIsBusy(true);
    try {
      await requestJson(`/api/admin/event-types/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          label: editDraft.label.trim(),
          description: editDraft.description.trim() || null,
          aliases: parseAliasesInput(editDraft.aliases),
          enabled: editDraft.enabled,
        }),
      });
      setEditing(null);
      showToast("事件类型已保存。");
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "保存失败");
    } finally {
      setIsBusy(false);
    }
  };

  const handleToggle = async (eventType: AdminEventType) => {
    setIsBusy(true);
    try {
      await requestJson(`/api/admin/event-types/${eventType.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !eventType.enabled }),
      });
      showToast(eventType.enabled ? "已停用，历史内容仍按原 key 展示。" : "已启用。");
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "操作失败");
    } finally {
      setIsBusy(false);
    }
  };

  const handleDelete = async (eventType: AdminEventType) => {
    setIsBusy(true);
    try {
      await requestJson(`/api/admin/event-types/${eventType.id}`, { method: "DELETE" });
      showToast("已删除。");
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "删除失败");
    } finally {
      setIsBusy(false);
    }
  };



  const renderDraftForm = (
    draft: EventTypeDraft,
    setDraft: (next: EventTypeDraft) => void,
    idPrefix: string,
    keyLocked?: { key: string },
  ) => (
    <div className="space-y-4">
      {keyLocked ? (
        <FormField label="Key（创建后不可修改）" htmlFor={`${idPrefix}-key`}>
          <TextInput id={`${idPrefix}-key`} value={keyLocked.key} disabled readOnly />
        </FormField>
      ) : null}
      {keyLocked ? null : (
        <FormField label="Key（留空则由名称自动派生，创建后不可修改）" htmlFor={`${idPrefix}-key-input`}>
          <TextInput
            id={`${idPrefix}-key-input`}
            value={draft.key}
            placeholder="如 economic_data"
            onChange={(event) => setDraft({ ...draft, key: event.target.value })}
          />
        </FormField>
      )}
      <FormField label="名称" htmlFor={`${idPrefix}-label`} required>
        <TextInput
          id={`${idPrefix}-label`}
          value={draft.label}
          onChange={(event) => setDraft({ ...draft, label: event.target.value })}
        />
      </FormField>
      <FormField label="描述" htmlFor={`${idPrefix}-description`}>
        <TextArea
          id={`${idPrefix}-description`}
          rows={2}
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </FormField>
      <FormField label="别名（顿号或逗号分隔）" htmlFor={`${idPrefix}-aliases`}>
        <TextInput
          id={`${idPrefix}-aliases`}
          value={draft.aliases}
          onChange={(event) => setDraft({ ...draft, aliases: event.target.value })}
        />
      </FormField>
      <label className="inline-flex items-center gap-2 text-sm text-[var(--text-2)]">
        <input
          className={checkboxInputClassName}
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
        启用
      </label>
    </div>
  );

  const visibleEventTypes = eventTypes
    .filter((eventType) => eventType.key !== "other")
    .sort((left, right) => Number(right.enabled) - Number(left.enabled));

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[var(--foreground)]">事件类型</h2>
        <Button onClick={() => setCreateOpen(true)} variant="primary">
          <span className="inline-flex items-center gap-1.5">
            <IconPlus className="h-4 w-4" />
            <span>新建</span>
          </span>
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2 animate-pulse">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-12 rounded-sm bg-[var(--bg-muted)]" />
          ))}
        </div>
      ) : eventTypes.length === 0 ? (
        <EmptyState>暂无事件类型；新建或重启后自动播种默认事件类型。</EmptyState>
      ) : visibleEventTypes.length === 0 ? (
        <EmptyState>暂无事件类型；新建或重启后自动播种默认事件类型。</EmptyState>
      ) : (
        <div className="space-y-2">
          {visibleEventTypes.map((eventType) => (
            <div
              key={eventType.id}
              className="rounded-lg border border-[color:var(--line)] bg-[var(--surface)] px-3 py-3 transition hover:shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--text-1)]">{eventType.label}</h3>
                    <span className="rounded-sm bg-[var(--bg-muted)] px-2 py-0.5 text-xs text-[var(--text-2)]">{eventType.key}</span>
                    <span
                      className={
                        eventType.enabled
                          ? "rounded-sm bg-[var(--success-surface)] px-2 py-0.5 text-xs text-[var(--success-ink)]"
                          : "rounded-sm bg-[var(--bg-muted)] px-2 py-0.5 text-xs text-[var(--text-3)]"
                      }
                    >
                      {eventType.enabled ? "启用" : "停用"}
                    </span>
                    {eventType.aliases.length > 0 ? (
                      <span className="rounded-sm bg-[var(--bg-muted)] px-2 py-0.5 text-xs text-[var(--text-2)]">
                        {eventType.aliases.join("、")}
                      </span>
                    ) : null}
                  </div>
                  {eventType.description ? (
                    <p className="mt-1 truncate text-sm text-[var(--text-3)]">{eventType.description}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-1">
                  <IconButton
                    variant="secondary"
                    size="sm"
                    title="编辑"
                    aria-label="编辑"
                    disabled={isBusy}
                    onClick={() => openEdit(eventType)}
                  >
                    <IconEdit className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    variant="secondary"
                    size="sm"
                    title={eventType.enabled ? "停用" : "启用"}
                    aria-label={eventType.enabled ? "停用" : "启用"}
                    disabled={isBusy || eventType.key === "other"}
                    onClick={() => void handleToggle(eventType)}
                  >
                    {eventType.enabled ? <IconX className="h-4 w-4" /> : <IconCheck className="h-4 w-4" />}
                  </IconButton>
                  <IconButton
                    variant="secondary"
                    size="sm"
                    title="删除"
                    aria-label="删除"
                    className="text-[var(--danger-ink)] hover:bg-[var(--danger-surface)]"
                    disabled={isBusy || eventType.key === "other"}
                    onClick={() => setPendingDelete(eventType)}
                  >
                    <IconTrash className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {createOpen ? (
        <ModalShell isOpen onClose={() => setCreateOpen(false)} title="新建事件类型">
          <div className="space-y-4">
            {renderDraftForm(createDraft, setCreateDraft, "event-type-create")}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setCreateOpen(false)} variant="secondary" disabled={isBusy}>取消</Button>
              <Button onClick={() => void handleCreate()} variant="primary" disabled={isBusy || !createDraft.label.trim()}>
                创建
              </Button>
            </div>
          </div>
        </ModalShell>
      ) : null}

      {pendingDelete ? (
        <ModalShell
          isOpen
          onClose={() => setPendingDelete(null)}
          title="确认删除事件类型"
          widthClassName="max-w-lg"
          headerClassName="border-b border-[color:var(--line)] p-4"
          bodyClassName="space-y-2 p-4"
          footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
          footer={
            <div className="flex justify-end gap-2">
              <Button onClick={() => setPendingDelete(null)} variant="secondary">取消</Button>
              <Button onClick={() => { const target = pendingDelete; setPendingDelete(null); if (target) { void handleDelete(target); } }} variant="danger">
                确认删除
              </Button>
            </div>
          }
        >
          <p className="text-sm text-[var(--foreground)]">即将删除事件类型「{pendingDelete.label}」（{pendingDelete.key}）。</p>
          <p className="text-sm leading-6 text-[var(--text-2)]">已被历史内容引用的类型无法删除，请改用停用；停用后历史内容仍按原 key 展示。</p>
        </ModalShell>
      ) : null}

      {editing ? (
        <ModalShell isOpen onClose={() => setEditing(null)} title="编辑事件类型">
          <div className="space-y-4">
            {renderDraftForm(editDraft, setEditDraft, "event-type-edit", { key: editing.key })}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setEditing(null)} variant="secondary" disabled={isBusy}>取消</Button>
              <Button onClick={() => void handleUpdate()} variant="primary" disabled={isBusy || !editDraft.label.trim()}>
                保存
              </Button>
            </div>
          </div>
        </ModalShell>
      ) : null}
    </section>
  );
}
