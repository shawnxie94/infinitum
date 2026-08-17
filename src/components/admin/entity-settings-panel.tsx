"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

import {
  addAdminEntityAlias,
  autoMergeHighConfidenceAdminEntitySuggestions,
  deleteAdminEntityAlias,
  dismissAdminEntitySuggestion,
  type AdminEntity,
  type AdminEntitySort,
  type AdminEntitySuggestion,
  type AdminEntitySuggestionSort,
  listAdminEntities,
  listAdminEntitySuggestions,
  mergeAdminEntities,
  precomputeAdminEntitySuggestions,
} from "@/components/admin/admin-settings-panel.api";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterInput } from "@/components/ui/filter-input";
import { FilterSelect } from "@/components/ui/filter-select";
import { IconButton } from "@/components/ui/icon-button";
import { IconCheck, IconMerge, IconPlus, IconRotateCw, IconTrash, IconX } from "@/components/ui/icons";
import { ModalShell } from "@/components/ui/modal-shell";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { StatusBanner } from "@/components/ui/status-banner";
import { TextInput } from "@/components/ui/text-input";
import { useToast } from "@/components/ui/toast";
import { cx } from "@/lib/ui/cx";

const DEFAULT_PAGE_SIZE = 10;
const MERGE_CANDIDATE_PAGE_SIZE = 100;
const DEFAULT_SUGGESTION_PAGE_SIZE = 10;
const SUGGESTION_LOAD_DEBOUNCE_MS = 250;
const ENTITY_SORT_OPTIONS: Array<{ value: AdminEntitySort; label: string }> = [
  { value: "usage_desc", label: "使用数倒序" },
  { value: "updated_desc", label: "更新时间倒序" },
  { value: "name_asc", label: "名称 A-Z" },
  { value: "alias_desc", label: "别名数倒序" },
];
const SUGGESTION_SORT_OPTIONS: Array<{ value: AdminEntitySuggestionSort; label: string }> = [
  { value: "confidence_desc", label: "置信度倒序" },
  { value: "affected_desc", label: "影响条数倒序" },
];

function formatEntityCount(count: number) {
  return `${count} 条`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatConfidence(value: number) {
  return `${Math.round(value * 100)}%`;
}

type EntitySuggestionPanelProps = {
  suggestions: AdminEntitySuggestion[];
  totalCount: number;
  page: number;
  pageSize: number;
  search: string;
  sort: AdminEntitySuggestionSort;
  isOpen: boolean;
  isBusy: boolean;
  error: string | null;
  onClose: () => void;
  onSearchChange: (value: string) => void;
  onSortChange: (value: AdminEntitySuggestionSort) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onOpenMergeChoice: (suggestion: AdminEntitySuggestion) => void;
  onOpenDismissChoice: (suggestion: AdminEntitySuggestion) => void;
  onAutoMergeHighConfidence: () => void;
  onRefresh: () => void;
};

function EntitySuggestionModal({
  suggestions,
  totalCount,
  page,
  pageSize,
  search,
  sort,
  isOpen,
  isBusy,
  error,
  onClose,
  onSearchChange,
  onSortChange,
  onPageChange,
  onPageSizeChange,
  onOpenMergeChoice,
  onOpenDismissChoice,
  onAutoMergeHighConfidence,
  onRefresh,
}: EntitySuggestionPanelProps) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="治理建议"
      widthClassName="max-w-6xl"
      headerClassName="border-b border-[color:var(--line)] p-4"
      bodyClassName="space-y-4 p-4 max-h-[76vh] overflow-y-auto"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button className="gap-2" onClick={onAutoMergeHighConfidence} variant="primary" disabled={isBusy}>
            <IconMerge className="h-4 w-4" />
            自动合并高置信
          </Button>
          <div className="flex items-center justify-end gap-2">
            <Button onClick={onRefresh} variant="secondary" disabled={isBusy}>
              刷新建议
            </Button>
            <Button onClick={onClose} variant="secondary" disabled={isBusy}>
              关闭
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid w-full grid-cols-1 gap-3 md:grid-cols-2">
          <FilterInput
            id="entity-suggestion-keyword"
            label="筛选实体"
            ariaLabel="治理建议实体筛选"
            placeholder="搜索来源或目标实体"
            value={search}
            onChange={onSearchChange}
          />
          <FilterSelect
            id="entity-suggestion-sort"
            label="排序"
            ariaLabel="治理建议排序"
            value={sort}
            onChange={(value) => onSortChange(value as AdminEntitySuggestionSort)}
            options={SUGGESTION_SORT_OPTIONS}
            showSearch={false}
          />
        </div>

        {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}

        {suggestions.length === 0 ? (
          <EmptyState className="border-0 bg-[var(--bg-muted)]">
            {search.trim() ? "暂无匹配建议" : "暂无待处理建议"}
          </EmptyState>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full table-auto text-sm">
              <thead className="bg-[var(--bg-muted)] text-[var(--muted)]">
                <tr>
                  <th className="w-[22%] px-3 py-2 text-left">来源实体</th>
                  <th className="w-[22%] px-3 py-2 text-left">目标实体</th>
                  <th className="w-[10%] whitespace-nowrap px-3 py-2 text-left">置信度</th>
                  <th className="w-[12%] whitespace-nowrap px-3 py-2 text-left">影响</th>
                  <th className="w-[22%] px-3 py-2 text-left">原因</th>
                  <th className="w-[12%] whitespace-nowrap px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--line)]">
                {suggestions.map((suggestion) => (
                  <tr key={suggestion.id} className="align-top transition-colors hover:bg-[var(--bg-muted)]">
                    <td className="px-3 py-3">
                      <div className="font-medium text-[var(--foreground)]">{suggestion.sourceEntity.name}</div>
                      <div className="mt-1 text-xs text-[var(--muted)]">
                        {formatEntityCount(suggestion.sourceEntity.itemCount)}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="font-medium text-[var(--foreground)]">{suggestion.targetEntity.name}</div>
                      <div className="mt-1 text-xs text-[var(--muted)]">
                        {formatEntityCount(suggestion.targetEntity.itemCount)}
                      </div>
                    </td>
                    <td className="px-3 py-3 font-medium text-[var(--accent-strong)]">
                      {formatConfidence(suggestion.confidence)}
                    </td>
                    <td className="px-3 py-3 text-[var(--text-2)]">
                      {formatEntityCount(suggestion.affectedItemCount)}
                    </td>
                    <td className="px-3 py-3 text-xs leading-5 text-[var(--text-2)]">
                      {suggestion.reasons.join("；")}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <IconButton
                          aria-label={`选择合并方向：${suggestion.sourceEntity.name}`}
                          title="选择合并方向"
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => onOpenMergeChoice(suggestion)}
                        >
                          <IconMerge className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          aria-label={`处理治理建议：${suggestion.sourceEntity.name}`}
                          title="处理治理建议"
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => onOpenDismissChoice(suggestion)}
                        >
                          <IconX className="h-4 w-4" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalCount > 0 ? (
          <PaginationControls
            totalItems={totalCount}
            page={page}
            totalPages={totalPages}
            pageSize={pageSize}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
            disabled={isBusy}
          />
        ) : null}
      </div>
    </ModalShell>
  );
}

type SuggestionChoiceModalProps = {
  suggestion: AdminEntitySuggestion | null;
  isOpen: boolean;
  isBusy: boolean;
  onClose: () => void;
  onMergeToTarget: () => void;
  onMergeToSource: () => void;
};

function SuggestionMergeChoiceModal({
  suggestion,
  isOpen,
  isBusy,
  onClose,
  onMergeToTarget,
  onMergeToSource,
}: SuggestionChoiceModalProps) {
  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="选择合并方向"
      widthClassName="max-w-xl"
      headerClassName="border-b border-[color:var(--line)] p-4"
      bodyClassName="space-y-4 p-4"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} variant="secondary" disabled={isBusy}>
            取消
          </Button>
          <Button onClick={onMergeToSource} variant="secondary" disabled={isBusy} className="gap-2">
            <IconMerge className="h-4 w-4" />
            合并到来源
          </Button>
          <Button onClick={onMergeToTarget} variant="primary" disabled={isBusy} className="gap-2">
            <IconMerge className="h-4 w-4" />
            合并到目标
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-[color:var(--line)] p-3">
          <div className="text-xs text-[var(--text-3)]">来源实体</div>
          <div className="mt-1 text-sm font-medium text-[var(--foreground)]">
            {suggestion?.sourceEntity.name ?? "-"}
          </div>
        </div>
        <div className="rounded-lg border border-[color:var(--accent-soft)] bg-[var(--accent-soft)]/30 p-3">
          <div className="text-xs text-[var(--text-3)]">目标实体</div>
          <div className="mt-1 text-sm font-medium text-[var(--foreground)]">
            {suggestion?.targetEntity.name ?? "-"}
          </div>
        </div>
      </div>
      <p className="text-sm leading-6 text-[var(--muted)]">
        “合并到目标”会保留目标实体；“合并到来源”会保留来源实体，并把目标实体合并过去。
      </p>
    </ModalShell>
  );
}

type SuggestionDismissChoiceModalProps = {
  suggestion: AdminEntitySuggestion | null;
  isOpen: boolean;
  isBusy: boolean;
  onClose: () => void;
  onKeepSeparate: () => void;
  onIgnore: () => void;
};

function SuggestionDismissChoiceModal({
  suggestion,
  isOpen,
  isBusy,
  onClose,
  onKeepSeparate,
  onIgnore,
}: SuggestionDismissChoiceModalProps) {
  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="处理治理建议"
      widthClassName="max-w-xl"
      headerClassName="border-b border-[color:var(--line)] p-4"
      bodyClassName="space-y-4 p-4"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} variant="secondary" disabled={isBusy}>
            取消
          </Button>
          <Button onClick={onIgnore} variant="secondary" disabled={isBusy} className="gap-2">
            <IconX className="h-4 w-4" />
            临时忽略
          </Button>
          <Button onClick={onKeepSeparate} variant="primary" disabled={isBusy} className="gap-2">
            <IconCheck className="h-4 w-4" />
            不合并
          </Button>
        </div>
      }
    >
      <div className="rounded-lg border border-[color:var(--line)] bg-[var(--bg-muted)] p-3 text-sm text-[var(--text-2)]">
        {suggestion ? `${suggestion.sourceEntity.name} / ${suggestion.targetEntity.name}` : "实体建议"}
      </div>
      <p className="text-sm leading-6 text-[var(--muted)]">
        “不合并”表示确认两者都应保留为规范实体；“临时忽略”表示暂不处理这条建议。两种操作都会隐藏当前建议对。
      </p>
    </ModalShell>
  );
}

type EntityManageModalProps = {
  entity: AdminEntity | null;
  isOpen: boolean;
  isBusy: boolean;
  onClose: () => void;
  onDeleteAlias: (aliasId: string) => void;
  onOpenMerge: () => void;
  onOpenAlias: () => void;
};

function EntityManageModal({
  entity,
  isOpen,
  isBusy,
  onClose,
  onDeleteAlias,
  onOpenMerge,
  onOpenAlias,
}: EntityManageModalProps) {
  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="实体详情"
      widthClassName="max-w-3xl"
      headerClassName="border-b border-[color:var(--line)] p-6"
      bodyClassName="space-y-4 p-6 max-h-[70vh] overflow-y-auto"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button className="gap-2" onClick={onOpenAlias} variant="primary" disabled={isBusy}>
            <IconPlus className="h-4 w-4" />
            新增别名
          </Button>
          <Button className="gap-2" onClick={onOpenMerge} variant="secondary" disabled={isBusy}>
            <IconMerge className="h-4 w-4" />
            合并实体
          </Button>
          <Button onClick={onClose} variant="secondary" disabled={isBusy}>
            关闭
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <section className="rounded-lg border border-[color:var(--accent-soft)] bg-[var(--accent-soft)]/30 p-4">
          <h4 className="text-sm font-semibold text-[var(--text-1)]">基本信息</h4>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <div className="text-xs text-[var(--text-3)]">实体名称</div>
              <div className="mt-1 truncate text-sm font-medium text-[var(--foreground)]">{entity?.name ?? "-"}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-3)]">关联内容</div>
              <div className="mt-1 text-sm text-[var(--text-2)]">{formatEntityCount(entity?.itemCount ?? 0)}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-3)]">关联别名</div>
              <div className="mt-1 text-sm text-[var(--text-2)]">{entity?.aliasCount ?? 0} 个</div>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-[color:var(--line)]">
          <div className="border-b border-[color:var(--line)] bg-[var(--bg-muted)] px-4 py-3 text-sm font-semibold text-[var(--text-1)]">
            已有关联别名
          </div>
          {entity?.aliases.length ? (
            <div className="divide-y divide-[color:var(--line)]">
              {entity.aliases.map((alias) => (
                <div key={alias.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[var(--text-1)]">{alias.aliasName}</div>
                    <div className="truncate text-xs text-[var(--text-3)]">
                      {alias.createdBy} · {formatDateTime(alias.createdAt)}
                    </div>
                  </div>
                  <IconButton
                    aria-label={`删除别名：${alias.aliasName}`}
                    disabled={isBusy}
                    onClick={() => onDeleteAlias(alias.id)}
                    size="sm"
                    title="删除别名"
                    variant="ghost"
                  >
                    <IconTrash className="h-4 w-4 text-[var(--danger-ink)]" />
                  </IconButton>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState className="rounded-none border-0">暂无别名</EmptyState>
          )}
        </section>
      </div>
    </ModalShell>
  );
}

type EntityMergeModalProps = {
  targetEntity: AdminEntity | null;
  isOpen: boolean;
  isBusy: boolean;
  onClose: () => void;
  onMerge: (sourceEntityIds: string[]) => void;
};

function EntityMergeModal({ targetEntity, isOpen, isBusy, onClose, onMerge }: EntityMergeModalProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [candidateEntities, setCandidateEntities] = useState<AdminEntity[]>([]);
  const [selectedEntityIds, setSelectedEntityIds] = useState<Set<string>>(new Set());
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSearchQuery("");
      setSelectedEntityIds(new Set());
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [isOpen, targetEntity?.id]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      setIsLoadingCandidates(true);
      try {
        const result = await listAdminEntities({
          search: searchQuery,
          page: 1,
          pageSize: MERGE_CANDIDATE_PAGE_SIZE,
        });
        if (cancelled) {
          return;
        }
        setCandidateEntities(result.entities.filter((entity) => entity.id !== targetEntity?.id));
      } finally {
        if (!cancelled) {
          setIsLoadingCandidates(false);
        }
      }
    }, searchQuery.trim() ? 250 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [isOpen, searchQuery, targetEntity?.id]);

  function toggleEntity(entityId: string) {
    setSelectedEntityIds((current) => {
      const next = new Set(current);
      if (next.has(entityId)) {
        next.delete(entityId);
      } else {
        next.add(entityId);
      }
      return next;
    });
  }

  function handleMerge() {
    if (selectedEntityIds.size === 0) {
      return;
    }

    onMerge([...selectedEntityIds]);
  }

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="合并实体"
      widthClassName="max-w-3xl"
      headerClassName="border-b border-[color:var(--line)] p-4"
      bodyClassName="p-4 space-y-4"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="secondary" disabled={isBusy}>
            取消
          </Button>
          <Button
            className="gap-2"
            onClick={handleMerge}
            variant="primary"
            disabled={isBusy || selectedEntityIds.size === 0}
          >
            {isBusy ? <IconRotateCw className="h-4 w-4 animate-spin" /> : <IconMerge className="h-4 w-4" />}
            确认合并 ({selectedEntityIds.size} 个)
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-[color:var(--line)] bg-[var(--bg-muted)] p-4">
          <h4 className="mb-2 text-sm font-semibold text-[var(--text-1)]">操作说明</h4>
          <ul className="list-inside list-disc space-y-1 text-sm text-[var(--text-2)]">
            <li>选中的来源实体会合并到当前目标实体</li>
            <li>合并后，来源实体的内容会归属到目标实体</li>
            <li>来源实体名称和已有别名会自动保存为目标实体的别名</li>
          </ul>
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-[var(--text-1)]">目标实体（当前）</h4>
          <div className="rounded-lg border border-[color:var(--accent-soft)] bg-[var(--accent-soft)]/30 p-3">
            <div className="text-sm font-medium text-[var(--foreground)]">{targetEntity?.name ?? "加载中..."}</div>
            <div className="mt-1 text-xs text-[var(--muted)]">
              {targetEntity ? `${formatEntityCount(targetEntity.itemCount)} · ${targetEntity.aliasCount} 个别名` : ""}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-[var(--text-1)]">
            选择要合并的实体
            {selectedEntityIds.size > 0 ? (
              <span className="ml-2 text-xs font-normal text-[var(--accent-strong)]">
                已选择 {selectedEntityIds.size} 个
              </span>
            ) : null}
          </h4>
          <TextInput
            aria-label="搜索要合并的实体"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索实体名称或别名..."
          />
          <div className="max-h-[280px] space-y-1 overflow-y-auto rounded-lg border border-[color:var(--line)] p-2">
            {isLoadingCandidates ? (
              <p className="py-4 text-center text-sm text-[var(--muted)]">正在搜索实体...</p>
            ) : candidateEntities.length === 0 ? (
              <p className="py-4 text-center text-sm text-[var(--muted)]">
                {searchQuery.trim() ? "未找到匹配的实体" : "暂无可合并的实体"}
              </p>
            ) : (
              candidateEntities.map((entity) => (
                <label
                  key={entity.id}
                  className={cx(
                    "flex cursor-pointer items-center gap-3 rounded-lg border p-2 transition-colors",
                    selectedEntityIds.has(entity.id)
                      ? "border-[color:var(--accent)] bg-[var(--accent-soft)]"
                      : "border-transparent hover:bg-[var(--surface)]",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selectedEntityIds.has(entity.id)}
                    onChange={() => toggleEntity(entity.id)}
                    className="h-4 w-4 rounded text-[var(--accent)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--foreground)]">{entity.name}</div>
                    <div className="text-xs text-[var(--muted)]">
                      {formatEntityCount(entity.itemCount)} · {entity.aliasCount} 个别名
                    </div>
                  </div>
                </label>
              ))
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

type AddAliasModalProps = {
  entity: AdminEntity | null;
  isOpen: boolean;
  isBusy: boolean;
  onClose: () => void;
  onAddAlias: (aliasName: string) => void;
};

function AddAliasModal({ entity, isOpen, isBusy, onClose, onAddAlias }: AddAliasModalProps) {
  const [aliasName, setAliasName] = useState("");

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setAliasName("");
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [isOpen, entity?.id]);

  function handleSubmit() {
    if (!aliasName.trim()) {
      return;
    }

    onAddAlias(aliasName);
    setAliasName("");
  }

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="新增别名"
      widthClassName="max-w-lg"
      headerClassName="border-b border-[color:var(--line)] p-4"
      bodyClassName="p-4 space-y-4"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="secondary" disabled={isBusy}>
            取消
          </Button>
          <Button className="gap-2" onClick={handleSubmit} variant="primary" disabled={isBusy || !aliasName.trim()}>
            <IconPlus className="h-4 w-4" />
            添加别名
          </Button>
        </div>
      }
    >
      <div className="rounded-lg border border-[color:var(--accent-soft)] bg-[var(--accent-soft)]/30 p-3">
        <div className="text-sm font-medium text-[var(--foreground)]">{entity?.name ?? "实体"}</div>
        <div className="mt-1 text-xs text-[var(--muted)]">新内容命中别名后会自动写入该实体</div>
      </div>
      <div className="space-y-1">
        <label className="text-sm text-[var(--text-2)]" htmlFor="entity-alias-name">
          别名
        </label>
        <TextInput
          id="entity-alias-name"
          value={aliasName}
          onChange={(event) => setAliasName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              handleSubmit();
            }
          }}
          placeholder="例如：智能体"
        />
      </div>
    </ModalShell>
  );
}

export function EntitySettingsPanel({
  initialOpenSuggestions = false,
}: {
  initialOpenSuggestions?: boolean;
} = {}) {
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [entities, setEntities] = useState<AdminEntity[]>([]);
  const [suggestions, setSuggestions] = useState<AdminEntitySuggestion[]>([]);
  const [suggestionTotalCount, setSuggestionTotalCount] = useState(0);
  const [suggestionSearch, setSuggestionSearch] = useState("");
  const [suggestionSort, setSuggestionSort] = useState<AdminEntitySuggestionSort>("confidence_desc");
  const [suggestionPage, setSuggestionPage] = useState(1);
  const [suggestionPageSize, setSuggestionPageSize] = useState(DEFAULT_SUGGESTION_PAGE_SIZE);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<AdminEntitySort>("usage_desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [totalCount, setTotalCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [managingEntityId, setManagingEntityId] = useState<string | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [isMergeModalOpen, setIsMergeModalOpen] = useState(false);
  const [isAliasModalOpen, setIsAliasModalOpen] = useState(false);
  const [isSuggestionModalOpen, setIsSuggestionModalOpen] = useState(initialOpenSuggestions);
  const [mergeChoiceSuggestion, setMergeChoiceSuggestion] = useState<AdminEntitySuggestion | null>(null);
  const [dismissChoiceSuggestion, setDismissChoiceSuggestion] = useState<AdminEntitySuggestion | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const managingEntity = useMemo(
    () => entities.find((entity) => entity.id === managingEntityId) ?? null,
    [managingEntityId, entities],
  );
  const hasSearch = Boolean(search);
  const hasFilters = hasSearch || sort !== "usage_desc";

  const loadEntities = useCallback(async () => {
    try {
      const payload = await listAdminEntities({ search, sort, page, pageSize });
      setError(null);
      setEntities(payload.entities);
      setTotalCount(payload.totalCount);
      if (managingEntityId && !payload.entities.some((entity) => entity.id === managingEntityId)) {
        setManagingEntityId(null);
        setIsDetailModalOpen(false);
        setIsMergeModalOpen(false);
        setIsAliasModalOpen(false);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "实体列表加载失败。");
    }
  }, [managingEntityId, page, pageSize, search, sort]);

  const loadSuggestions = useCallback(async () => {
    try {
      const payload = await listAdminEntitySuggestions({
        search: suggestionSearch,
        sort: suggestionSort,
        page: suggestionPage,
        pageSize: suggestionPageSize,
      });
      setSuggestionError(null);
      setSuggestions(payload.suggestions);
      setSuggestionTotalCount(payload.totalCount);
    } catch (loadError) {
      setSuggestionError(loadError instanceof Error ? loadError.message : "实体治理建议加载失败。");
    }
  }, [suggestionPage, suggestionPageSize, suggestionSearch, suggestionSort]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadEntities();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [loadEntities]);

  useEffect(() => {
    if (!isSuggestionModalOpen) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void loadSuggestions();
    }, suggestionSearch.trim() ? SUGGESTION_LOAD_DEBOUNCE_MS : 0);

    return () => window.clearTimeout(timeoutId);
  }, [isSuggestionModalOpen, loadSuggestions, suggestionSearch]);

  function handleClearFilters() {
    setSearch("");
    setSort("usage_desc");
    setPage(1);
  }

  function handleRefresh() {
    startTransition(async () => {
      await Promise.all([
        loadEntities(),
        isSuggestionModalOpen ? loadSuggestions() : Promise.resolve(),
      ]);
    });
  }

  async function reloadAfterEntityMutation() {
    await Promise.all([
      loadEntities(),
      isSuggestionModalOpen ? loadSuggestions() : Promise.resolve(),
    ]);
  }

  async function handleAddAlias(aliasName: string) {
    if (!managingEntity) {
      return;
    }

    await addAdminEntityAlias({
      entityId: managingEntity.id,
      aliasName,
    });
    showToast("别名已添加。");
    setIsAliasModalOpen(false);
    await reloadAfterEntityMutation();
  }

  async function handleDeleteAlias(aliasId: string) {
    await deleteAdminEntityAlias(aliasId);
    showToast("别名已删除。");
    await reloadAfterEntityMutation();
  }

  async function handleMerge(sourceEntityIds: string[]) {
    if (!managingEntity) {
      return;
    }

    const result = await mergeAdminEntities({
      targetEntityId: managingEntity.id,
      sourceEntityIds,
    });
    showToast(`已合并 ${result.mergedCount} 个实体。`);
    setIsMergeModalOpen(false);
    await reloadAfterEntityMutation();
  }

  async function handleSuggestionMerge(suggestion: AdminEntitySuggestion, direction: "target" | "source") {
    const targetEntityId = direction === "target" ? suggestion.targetEntity.id : suggestion.sourceEntity.id;
    const sourceEntityIds = [direction === "target" ? suggestion.sourceEntity.id : suggestion.targetEntity.id];
    const result = await mergeAdminEntities({
      targetEntityId,
      sourceEntityIds,
    });
    showToast(`已合并 ${result.mergedCount} 个实体。`);
    setMergeChoiceSuggestion(null);
    await reloadAfterEntityMutation();
  }

  async function handleSuggestionDismiss(suggestion: AdminEntitySuggestion, decision: "ignored" | "kept") {
    await dismissAdminEntitySuggestion({
      sourceEntityId: suggestion.sourceEntity.id,
      targetEntityId: suggestion.targetEntity.id,
      decision,
    });
    showToast(decision === "kept" ? "已保留为规范实体。" : "已忽略该建议。");
    setDismissChoiceSuggestion(null);
    await loadSuggestions();
  }

  async function handleAutoMergeHighConfidenceSuggestions() {
    const result = await autoMergeHighConfidenceAdminEntitySuggestions();
    const failedText = result.failedCount > 0 ? `，${result.failedCount} 条失败` : "";
    const skippedText = result.skippedCount > 0 ? `，${result.skippedCount} 条已跳过` : "";
    showToast(`已自动合并 ${result.mergedCount} 个高置信实体${skippedText}${failedText}。`);
    await reloadAfterEntityMutation();
  }

  async function handleRefreshSuggestions() {
    const result = await precomputeAdminEntitySuggestions();
    showToast(`已刷新 ${result.storedCandidates} 条治理建议。`);
    await loadSuggestions();
  }

  function runModalAction(action: () => Promise<void>) {
    startTransition(async () => {
      try {
        await action();
      } catch (actionError) {
        showToast(actionError instanceof Error ? actionError.message : "操作失败。", "error");
      }
    });
  }

  function openEntityDetail(entityId: string) {
    setManagingEntityId(entityId);
    setIsDetailModalOpen(true);
    setIsMergeModalOpen(false);
    setIsAliasModalOpen(false);
  }

  function openEntityAlias(entityId: string) {
    setManagingEntityId(entityId);
    setIsDetailModalOpen(false);
    setIsMergeModalOpen(false);
    setIsAliasModalOpen(true);
  }

  function openEntityMerge(entityId: string) {
    setManagingEntityId(entityId);
    setIsDetailModalOpen(false);
    setIsAliasModalOpen(false);
    setIsMergeModalOpen(true);
  }

  function openSuggestionModal() {
    setIsSuggestionModalOpen(true);
    setSuggestionPage(1);
  }

  function closeSuggestionModal() {
    setIsSuggestionModalOpen(false);
    setMergeChoiceSuggestion(null);
    setDismissChoiceSuggestion(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-[var(--foreground)]">实体管理</h2>
          <p className="text-sm text-[var(--muted)]">
            管理规范实体、同义别名和历史实体合并
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={openSuggestionModal} variant="secondary" disabled={isPending}>
            治理建议
          </Button>
          <Button onClick={handleClearFilters} variant="secondary" disabled={!hasFilters}>
            清空筛选
          </Button>
          <Button onClick={handleRefresh} variant="secondary" disabled={isPending}>
            刷新
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FilterInput
          id="entity-management-keyword"
          label="关键词"
          ariaLabel="实体关键词"
          placeholder="搜索实体名或别名"
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
        />
        <FilterSelect
          id="entity-management-sort"
          label="排序"
          ariaLabel="实体排序"
          value={sort}
          onChange={(value) => {
            setSort(value as AdminEntitySort);
            setPage(1);
          }}
          options={ENTITY_SORT_OPTIONS}
          showSearch={false}
        />
      </div>

      {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}

      {isPending && entities.length === 0 ? (
        <EmptyState>加载中...</EmptyState>
      ) : entities.length === 0 ? (
        <EmptyState>{hasSearch ? "暂无匹配实体" : "暂无实体"}</EmptyState>
      ) : (
        <div className="w-full overflow-x-auto">
          <table className="w-full table-auto text-sm">
            <thead className="bg-[var(--bg-muted)] text-[var(--muted)]">
              <tr>
                <th className="w-[36%] px-4 py-3 text-left">实体</th>
                <th className="w-[16%] whitespace-nowrap px-4 py-3 text-left">使用数</th>
                <th className="w-[16%] whitespace-nowrap px-4 py-3 text-left">别名数</th>
                <th className="w-[16%] whitespace-nowrap px-4 py-3 text-left">更新时间</th>
                <th className="w-[16%] whitespace-nowrap px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--line)]">
              {entities.map((entity) => (
                <tr key={entity.id} className="transition-colors hover:bg-[var(--bg-muted)]">
                  <td className="max-w-0 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => openEntityDetail(entity.id)}
                      className="w-full truncate text-left font-medium text-[var(--foreground)] transition-colors hover:text-[var(--accent)]"
                    >
                      {entity.name}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-2)]">{formatEntityCount(entity.itemCount)}</td>
                  <td className="px-4 py-3 text-[var(--text-2)]">{entity.aliasCount} 个</td>
                  <td className="px-4 py-3 text-xs text-[var(--text-3)]">{formatDateTime(entity.updatedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        aria-label={`新增别名：${entity.name}`}
                        onClick={() => openEntityAlias(entity.id)}
                        size="sm"
                        title="新增别名"
                        variant="ghost"
                      >
                        <IconPlus className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        aria-label={`合并实体：${entity.name}`}
                        onClick={() => openEntityMerge(entity.id)}
                        size="sm"
                        title="合并实体"
                        variant="ghost"
                      >
                        <IconMerge className="h-4 w-4" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalCount > 0 ? (
        <PaginationControls
          totalItems={totalCount}
          page={page}
          totalPages={totalPages}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(nextPageSize) => {
            setPageSize(nextPageSize);
            setPage(1);
          }}
          disabled={isPending}
        />
      ) : null}

      <EntitySuggestionModal
        suggestions={suggestions}
        totalCount={suggestionTotalCount}
        page={suggestionPage}
        pageSize={suggestionPageSize}
        search={suggestionSearch}
        sort={suggestionSort}
        isOpen={isSuggestionModalOpen}
        isBusy={isPending}
        error={suggestionError}
        onClose={closeSuggestionModal}
        onSearchChange={(value) => {
          setSuggestionSearch(value);
          setSuggestionPage(1);
        }}
        onSortChange={(value) => {
          setSuggestionSort(value);
          setSuggestionPage(1);
        }}
        onPageChange={setSuggestionPage}
        onPageSizeChange={(nextPageSize) => {
          setSuggestionPageSize(nextPageSize);
          setSuggestionPage(1);
        }}
        onOpenMergeChoice={setMergeChoiceSuggestion}
        onOpenDismissChoice={setDismissChoiceSuggestion}
        onAutoMergeHighConfidence={() => runModalAction(handleAutoMergeHighConfidenceSuggestions)}
        onRefresh={() => runModalAction(handleRefreshSuggestions)}
      />

      <SuggestionMergeChoiceModal
        suggestion={mergeChoiceSuggestion}
        isOpen={Boolean(mergeChoiceSuggestion)}
        isBusy={isPending}
        onClose={() => setMergeChoiceSuggestion(null)}
        onMergeToTarget={() => {
          if (mergeChoiceSuggestion) {
            runModalAction(() => handleSuggestionMerge(mergeChoiceSuggestion, "target"));
          }
        }}
        onMergeToSource={() => {
          if (mergeChoiceSuggestion) {
            runModalAction(() => handleSuggestionMerge(mergeChoiceSuggestion, "source"));
          }
        }}
      />

      <SuggestionDismissChoiceModal
        suggestion={dismissChoiceSuggestion}
        isOpen={Boolean(dismissChoiceSuggestion)}
        isBusy={isPending}
        onClose={() => setDismissChoiceSuggestion(null)}
        onKeepSeparate={() => {
          if (dismissChoiceSuggestion) {
            runModalAction(() => handleSuggestionDismiss(dismissChoiceSuggestion, "kept"));
          }
        }}
        onIgnore={() => {
          if (dismissChoiceSuggestion) {
            runModalAction(() => handleSuggestionDismiss(dismissChoiceSuggestion, "ignored"));
          }
        }}
      />

      <EntityManageModal
        entity={managingEntity}
        isOpen={Boolean(managingEntity) && isDetailModalOpen}
        isBusy={isPending}
        onClose={() => {
          setIsDetailModalOpen(false);
          setManagingEntityId(null);
          setIsMergeModalOpen(false);
          setIsAliasModalOpen(false);
        }}
        onDeleteAlias={(aliasId) => runModalAction(() => handleDeleteAlias(aliasId))}
        onOpenMerge={() => setIsMergeModalOpen(true)}
        onOpenAlias={() => setIsAliasModalOpen(true)}
      />

      <EntityMergeModal
        targetEntity={managingEntity}
        isOpen={Boolean(managingEntity) && isMergeModalOpen}
        isBusy={isPending}
        onClose={() => setIsMergeModalOpen(false)}
        onMerge={(sourceEntityIds) => runModalAction(() => handleMerge(sourceEntityIds))}
      />

      <AddAliasModal
        entity={managingEntity}
        isOpen={Boolean(managingEntity) && isAliasModalOpen}
        isBusy={isPending}
        onClose={() => setIsAliasModalOpen(false)}
        onAddAlias={(aliasName) => runModalAction(() => handleAddAlias(aliasName))}
      />
    </div>
  );
}
