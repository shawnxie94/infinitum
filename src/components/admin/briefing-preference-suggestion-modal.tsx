import { eventBriefingRuleTypeLabels, formatSignedWeight, type BriefingPreferenceSuggestionSort } from "@/components/admin/admin-settings-panel.helpers";


import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterInput } from "@/components/ui/filter-input";
import { FilterSelect } from "@/components/ui/filter-select";
import { IconButton } from "@/components/ui/icon-button";
import { IconCheck, IconX } from "@/components/ui/icons";
import { ModalShell } from "@/components/ui/modal-shell";
import { PaginationControls } from "@/components/ui/pagination-controls";
import type { AdminBriefingPreferenceSuggestion } from "@/lib/settings/types";
import { cx } from "@/lib/ui/cx";


const briefingPreferenceSuggestionSortOptions: Array<{ value: BriefingPreferenceSuggestionSort; label: string }> = [
  { value: "sample_desc", label: "按证据次数" },
  { value: "weight_desc", label: "按建议权重" },
  { value: "updated_desc", label: "按更新时间" },
];

type BriefingPreferenceSuggestionModalProps = {
  suggestions: AdminBriefingPreferenceSuggestion[];
  pendingCount: number;
  totalCount: number;
  page: number;
  pageSize: number;
  search: string;
  sort: BriefingPreferenceSuggestionSort;
  isOpen: boolean;
  isBusy: boolean;
  onClose: () => void;
  onSearchChange: (value: string) => void;
  onSortChange: (value: BriefingPreferenceSuggestionSort) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onAccept: (suggestion: AdminBriefingPreferenceSuggestion) => void;
  onDismiss: (suggestion: AdminBriefingPreferenceSuggestion) => void;
  onDismissAll: () => void;
  onRefresh: () => void;
};


export default function BriefingPreferenceSuggestionModal({
  suggestions,
  pendingCount,
  totalCount,
  page,
  pageSize,
  search,
  sort,
  isOpen,
  isBusy,
  onClose,
  onSearchChange,
  onSortChange,
  onPageChange,
  onPageSizeChange,
  onAccept,
  onDismiss,
  onDismissAll,
  onRefresh,
}: BriefingPreferenceSuggestionModalProps) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="偏好建议"
      widthClassName="max-w-6xl"
      headerClassName="border-b border-[color:var(--line)] p-4"
      bodyClassName="space-y-4 p-4 max-h-[76vh] overflow-y-auto"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Button onClick={onDismissAll} variant="danger" disabled={isBusy || pendingCount === 0}>
            忽略当前列表
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-4">
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
            id="briefing-preference-suggestion-keyword"
            label="筛选建议"
            ariaLabel="偏好建议筛选"
            placeholder="搜索类型、内容或原因"
            value={search}
            onChange={onSearchChange}
          />
          <FilterSelect
            id="briefing-preference-suggestion-sort"
            label="排序"
            ariaLabel="偏好建议排序"
            value={sort}
            onChange={(value) => onSortChange(value as BriefingPreferenceSuggestionSort)}
            options={briefingPreferenceSuggestionSortOptions}
            showSearch={false}
          />
        </div>

        {suggestions.length === 0 ? (
          <EmptyState className="border-0 bg-[var(--bg-muted)]">
            {search.trim() ? "暂无匹配建议" : "暂无待处理建议"}
          </EmptyState>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full table-auto text-sm">
              <thead className="bg-[var(--bg-muted)] text-[var(--muted)]">
                <tr>
                  <th className="w-[12%] whitespace-nowrap px-3 py-2 text-left">类型</th>
                  <th className="w-[24%] px-3 py-2 text-left">建议</th>
                  <th className="w-[10%] whitespace-nowrap px-3 py-2 text-right">权重</th>
                  <th className="w-[14%] whitespace-nowrap px-3 py-2 text-right">证据次数</th>
                  <th className="px-3 py-2 text-left">原因</th>
                  <th className="w-[12%] whitespace-nowrap px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--line)]">
                {suggestions.map((suggestion) => (
                  <tr key={suggestion.id} className="align-top transition-colors hover:bg-[var(--bg-muted)]">
                    <td className="px-3 py-3 text-[var(--text-2)]">
                      {eventBriefingRuleTypeLabels[suggestion.ruleType]}
                    </td>
                    <td className="px-3 py-3">
                      <div className="font-medium text-[var(--foreground)]">
                        {suggestion.label ?? suggestion.value}
                      </div>
                    </td>
                    <td className={cx(
                      "px-3 py-3 text-right font-mono font-medium",
                      suggestion.suggestedWeight > 0 ? "text-[var(--accent-strong)]" : "text-[var(--danger-ink)]",
                    )}>
                      {formatSignedWeight(suggestion.suggestedWeight)}
                    </td>
                    <td className="px-3 py-3 text-right text-[var(--text-2)]">
                      {suggestion.sampleCount} 次
                    </td>
                    <td className="px-3 py-3 text-xs leading-5 text-[var(--text-2)]">
                      {suggestion.reason}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <IconButton
                          aria-label={`接受偏好建议：${suggestion.label ?? suggestion.value}`}
                          title="接受建议"
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => onAccept(suggestion)}
                        >
                          <IconCheck className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          aria-label={`忽略偏好建议：${suggestion.label ?? suggestion.value}`}
                          title="忽略建议"
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => onDismiss(suggestion)}
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

