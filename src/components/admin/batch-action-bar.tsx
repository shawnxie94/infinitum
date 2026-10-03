"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { IconRotateCw } from "@/components/ui/icons";
import { cx } from "@/lib/ui/cx";

export const ADMIN_BATCH_MAX_ITEMS = 50;

export type BatchActionDescriptor = {
  /** 动作标识，回传给服务端。 */
  key: string;
  label: string;
  /** 二次确认里展示的动作后果描述。 */
  confirmText: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
};

export type BatchActionResult = {
  succeeded: string[];
  failed: Array<{ id: string; error: string }>;
  total: number;
};

type BatchActionBarProps = {
  selectedCount: number;
  totalCount: number;
  actions: BatchActionDescriptor[];
  isRunning: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onRun: (actionKey: string) => void;
  className?: string;
};

/**
 * 治理类列表共用的多选批量工具条。
 * 未选中时只显示全选入口，选中后展开批量动作并强制二次确认。
 */
export function BatchActionBar({
  selectedCount,
  totalCount,
  actions,
  isRunning,
  onSelectAll,
  onClear,
  onRun,
  className,
}: BatchActionBarProps) {
  const [pendingAction, setPendingAction] = useState<BatchActionDescriptor | null>(null);
  const allSelected = totalCount > 0 && selectedCount === totalCount;
  const overLimit = selectedCount > ADMIN_BATCH_MAX_ITEMS;

  if (totalCount === 0) {
    return null;
  }

  return (
    <>
      <div
        className={cx(
          "flex flex-wrap items-center gap-3 rounded-sm border border-[color:var(--line)] bg-[var(--bg-muted)] px-3 py-2",
          className,
        )}
      >
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-[var(--text-2)]">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={allSelected}
            disabled={isRunning}
            onChange={(event) => {
              if (event.target.checked) {
                onSelectAll();
                return;
              }
              onClear();
            }}
          />
          全选本页
        </label>

        <span className="text-sm tabular-nums text-[var(--text-2)]">
          已选 {selectedCount} / {totalCount}
        </span>

        {overLimit ? (
          <span className="text-sm text-[var(--danger-ink)]">
            单次最多 {ADMIN_BATCH_MAX_ITEMS} 条，请减少选择
          </span>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions.map((action) => (
            <Button
              key={action.key}
              size="sm"
              variant={action.variant ?? "secondary"}
              disabled={selectedCount === 0 || isRunning || overLimit}
              onClick={() => setPendingAction(action)}
            >
              {action.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedCount === 0 || isRunning}
            onClick={onClear}
          >
            清空选择
          </Button>
        </div>
      </div>

      <BatchConfirmModal
        action={pendingAction}
        selectedCount={selectedCount}
        isRunning={isRunning}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => {
          const action = pendingAction;
          setPendingAction(null);
          if (action) {
            onRun(action.key);
          }
        }}
      />
    </>
  );
}

function BatchConfirmModal({
  action,
  selectedCount,
  isRunning,
  onCancel,
  onConfirm,
}: {
  action: BatchActionDescriptor | null;
  selectedCount: number;
  isRunning: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalShell
      isOpen={action !== null}
      onClose={onCancel}
      title="确认批量操作"
      widthClassName="max-w-lg"
      headerClassName="border-b border-[color:var(--line)] p-4"
      bodyClassName="space-y-2 p-4"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} variant="secondary" disabled={isRunning}>
            取消
          </Button>
          <Button
            onClick={onConfirm}
            variant={action?.variant === "danger" ? "danger" : "primary"}
            disabled={isRunning}
          >
            {isRunning ? (
              <>
                <IconRotateCw className="mr-1 h-4 w-4 animate-spin" />
                执行中...
              </>
            ) : (
              "确认执行"
            )}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-[var(--foreground)]">
        即将对已选中的 {selectedCount} 条执行「{action?.label}」。
      </p>
      <p className="text-sm leading-6 text-[var(--text-2)]">{action?.confirmText}</p>
    </ModalShell>
  );
}
