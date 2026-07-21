"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { MouseEvent } from "react";
import { useEffect, useState, useTransition } from "react";

import {
  deleteDailyReport,
  publishDailyReport,
  requestDailyReportGeneration,
  unpublishDailyReport,
} from "@/components/daily/daily-report.api";
import { Button } from "@/components/ui/button";
import { FilterSelectInline } from "@/components/ui/filter-select-inline";
import { IconButton } from "@/components/ui/icon-button";
import { IconEye, IconEyeOff, IconRefresh, IconTrash } from "@/components/ui/icons";
import { renderInlineMarkdown } from "@/components/ui/inline-markdown";
import { ModalShell } from "@/components/ui/modal-shell";
import { getTodayDailyReportDate } from "@/lib/daily-report/date";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { useClientAdminSession } from "@/components/ui/use-client-admin-session";
import type { DailyReportArchiveWeekDTO, DailyReportListItemDTO } from "@/lib/daily-report/types";
import { cx } from "@/lib/ui/cx";

type DailyReportListProps = {
  reports: DailyReportListItemDTO[];
  weeks: DailyReportArchiveWeekDTO[];
  isAdmin: boolean;
  hydrateAdminClient?: boolean;
  selectedWeek: string | null;
  selectedStatus: string;
  total: number;
  page: number;
  pageSize: number;
};

type DailyReportListPayload = {
  reports: DailyReportListItemDTO[];
  weeks: DailyReportArchiveWeekDTO[];
  total: number;
  page: number;
  pageSize: number;
};

function getTodayValue() {
  return getTodayDailyReportDate();
}

function statusLabel(status: DailyReportListItemDTO["status"]) {
  if (status === "published") return "已发布";
  return "草稿";
}

function statusClass(status: DailyReportListItemDTO["status"]) {
  if (status === "published") return "bg-[var(--success-surface)] text-[var(--success-ink)]";
  return "bg-[var(--bg-muted)] text-[var(--text-2)]";
}

export function DailyReportList({
  reports: initialReports,
  weeks: initialWeeks,
  isAdmin: initialIsAdmin,
  hydrateAdminClient = false,
  selectedWeek,
  selectedStatus,
  total: initialTotal,
  page: initialPage,
  pageSize: initialPageSize,
}: DailyReportListProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isAdmin = useClientAdminSession(initialIsAdmin, hydrateAdminClient);
  const [adminPayload, setAdminPayload] = useState<DailyReportListPayload | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DailyReportListItemDTO | null>(null);
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);
  const [generateDate, setGenerateDate] = useState(getTodayValue);
  const [isPending, startTransition] = useTransition();
  const reports = adminPayload?.reports ?? initialReports;
  const weeks = adminPayload?.weeks ?? initialWeeks;
  const total = adminPayload?.total ?? initialTotal;
  const page = adminPayload?.page ?? initialPage;
  const pageSize = adminPayload?.pageSize ?? initialPageSize;
  const totalWeekCount = weeks.reduce((sum, week) => sum + week.count, 0);
  const totalPages = Math.ceil(total / pageSize) || 1;
  const [jumpToPage, setJumpToPage] = useState(String(page));

  useEffect(() => {
    if (!hydrateAdminClient || !isAdmin || initialIsAdmin) {
      return;
    }

    let active = true;

    fetch(`/api/daily${searchParams.toString() ? `?${searchParams.toString()}` : ""}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<DailyReportListPayload> : null)
      .then((payload) => {
        if (!active || !payload) {
          return;
        }

        setAdminPayload(payload);
        setJumpToPage(String(payload.page));
      })
      .catch(() => {
        if (active) {
          setFeedback("管理员视图加载失败，请刷新后重试。");
        }
      });

    return () => {
      active = false;
    };
  }, [hydrateAdminClient, initialIsAdmin, isAdmin, searchParams]);

  const handleJumpToPage = () => {
    const nextPage = Number.parseInt(jumpToPage, 10);
    if (!Number.isFinite(nextPage)) {
      setJumpToPage(String(page));
      return;
    }
    const normalizedPage = Math.min(Math.max(1, nextPage), totalPages);
    if (normalizedPage === page) {
      setJumpToPage(String(normalizedPage));
      return;
    }
    updateQuery({ page: normalizedPage });
  };

  const updateQuery = (next: { week?: string | null; status?: string | null; page?: number; pageSize?: number }) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next.week !== undefined) {
      if (next.week) params.set("week", next.week);
      else params.delete("week");
    }
    if (next.status !== undefined) {
      if (next.status && next.status !== "all") params.set("status", next.status);
      else params.delete("status");
    }
    if (next.page !== undefined) {
      if (next.page > 1) params.set("page", String(next.page));
      else params.delete("page");
    }
    if (next.pageSize !== undefined) {
      if (next.pageSize !== 20) params.set("pageSize", String(next.pageSize));
      else params.delete("pageSize");
    }
    router.push(`/daily${params.toString() ? `?${params.toString()}` : ""}`);
  };

  const openGenerateDialog = () => {
    setGenerateDate(getTodayValue());
    setFeedback(null);
    setGenerateDialogOpen(true);
  };

  const generate = () => {
    if (!generateDate) {
      setFeedback("请选择日报日期。");
      return;
    }

    startTransition(async () => {
      setFeedback(null);
      const result = await requestDailyReportGeneration(generateDate);
      if (!result.ok || result.data.error) {
        setFeedback(result.data.error ?? "日报生成提交失败。");
        return;
      }
      setGenerateDialogOpen(false);
      if (result.data.taskRun?.id) {
        router.push(`/admin?tab=monitoring&section=tasks&task=${encodeURIComponent(result.data.taskRun.id)}`);
        return;
      }
      setFeedback("日报生成任务已提交。");
    });
  };

  const runCardAction = (
    event: MouseEvent<HTMLButtonElement>,
    report: DailyReportListItemDTO,
    action: "togglePublish" | "regenerate",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    startTransition(async () => {
      setFeedback(null);

      if (action === "regenerate") {
        const result = await requestDailyReportGeneration(report.date);
        if (!result.ok || result.data.error) {
          setFeedback(result.data.error ?? "操作失败。");
          return;
        }
        if (result.data.taskRun?.id) {
          router.push(`/admin?tab=monitoring&section=tasks&task=${encodeURIComponent(result.data.taskRun.id)}`);
          return;
        }
        setFeedback("日报重新生成任务已提交。");
        return;
      }

      const result = report.status === "published"
        ? await unpublishDailyReport(report.date)
        : await publishDailyReport(report.date);

      if (!result.ok || result.data.error) {
        setFeedback(result.data.error ?? "操作失败。");
        return;
      }

      router.refresh();
    });
  };

  const openDeleteDialog = (event: MouseEvent<HTMLButtonElement>, report: DailyReportListItemDTO) => {
    event.preventDefault();
    event.stopPropagation();
    setDeleteTarget(report);
  };

  const confirmDelete = () => {
    if (!deleteTarget) {
      return;
    }

    startTransition(async () => {
      setFeedback(null);
      const result = await deleteDailyReport(deleteTarget.date);
      if (!result.ok || result.data.error) {
        setFeedback(result.data.error ?? "日报删除失败。");
        return;
      }
      setDeleteTarget(null);
      router.refresh();
    });
  };

  return (
    <>
      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="hidden w-64 flex-shrink-0 lg:block">
          <div className="panel-raised sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-sm border border-[color:var(--line)] p-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold text-[var(--foreground)]">时间筛选</h2>
            </div>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => updateQuery({ week: null })}
                className={cx(
                  "flex w-full items-center justify-between gap-3 rounded-sm px-3 py-2 text-sm transition",
                  !selectedWeek ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "text-[var(--text-2)] hover:bg-[var(--bg-muted)]",
                )}
              >
                <span>全部周</span>
                <span>{totalWeekCount}</span>
              </button>
              {weeks.map((week) => (
                <button
                  key={week.key}
                  type="button"
                  onClick={() => updateQuery({ week: week.key })}
                  className={cx(
                    "flex w-full items-center justify-between gap-3 rounded-sm px-3 py-2 text-sm transition",
                    selectedWeek === week.key ? "bg-[var(--accent-soft)] text-[var(--accent-strong)]" : "text-[var(--text-2)] hover:bg-[var(--bg-muted)]",
                  )}
                >
                  <span className="whitespace-nowrap">{week.label}</span>
                  <span className="shrink-0">{week.count}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <section className="grid w-full min-w-0 flex-1 gap-4">
          <section className="w-full border-b border-[color:var(--line)] pb-3">
            <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
              <div className="min-w-0 flex-1">
                <h1 className="text-xl font-semibold text-[var(--foreground)]">AI 日报</h1>
                <p className="mt-1 text-sm text-[var(--text-2)]">完全使用AI生成每日总结，可能存在错误，需谨慎甄别。</p>
              </div>
              <div className="flex w-full min-w-0 flex-col gap-2 sm:ml-auto sm:w-auto sm:shrink-0 sm:flex-row sm:items-center sm:justify-end">
                <div className="w-full min-w-0 lg:hidden">
                  <FilterSelectInline
                    label="周"
                    ariaLabel="移动端周筛选"
                    value={selectedWeek ?? ""}
                    onChange={(value) => updateQuery({ week: value || null })}
                    options={[
                      { value: "", label: `全部周 (${totalWeekCount})` },
                      ...weeks.map((week) => ({
                        value: week.key,
                        label: `${week.label} (${week.count})`,
                      })),
                    ]}
                    showSearch={false}
                    className="w-full"
                    selectClassName="w-full"
                  />
                </div>
                {isAdmin ? (
                  <>
                    <Button variant="primary" onClick={openGenerateDialog} disabled={isPending} className="w-full sm:w-auto">
                      <span className="inline-flex items-center gap-2">
                        <IconRefresh className="h-4 w-4" />
                        <span>生成日报</span>
                      </span>
                    </Button>
                    <FilterSelectInline
                      label="状态"
                      ariaLabel="日报状态"
                      value={selectedStatus}
                      onChange={(value) => updateQuery({ status: value })}
                      options={[
                        { value: "all", label: "全部" },
                        { value: "published", label: "已发布" },
                        { value: "draft", label: "草稿" },
                      ]}
                      showSearch={false}
                    />
                  </>
                ) : null}
              </div>
            </div>
            {feedback ? <div className="mt-3 rounded-sm bg-[var(--bg-muted)] px-3 py-2 text-sm text-[var(--text-2)]">{feedback}</div> : null}
          </section>

          {reports.length === 0 ? (
            <div className="rounded-[1.15rem] border border-dashed border-[color:var(--line-strong)] bg-[color-mix(in_srgb,var(--surface)_80%,transparent)] px-5 py-8 text-sm leading-7 text-[var(--muted)] shadow-[var(--shadow-sm)]">
              当前时间范围内还没有可展示日报，请稍后再回来看看。
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {reports.map((report) => (
                  <article
                    key={report.id}
                    className="relative w-full rounded-lg border border-[color:var(--line)] bg-[var(--surface)] px-4 py-4 shadow-[var(--shadow-sm)] transition hover:border-[color:var(--line-strong)] hover:shadow-md sm:px-6 sm:py-5"
                  >
                    {isAdmin ? (
                      <div className="absolute right-4 top-4 flex items-center gap-1 sm:right-5 sm:top-5">
                        <IconButton
                          size="sm"
                          title={report.status === "published" ? "撤回为草稿" : "发布日报"}
                          aria-label={report.status === "published" ? "撤回为草稿" : "发布日报"}
                          disabled={isPending}
                          onClick={(event) => runCardAction(event, report, "togglePublish")}
                          className={report.status === "published" ? "text-[var(--accent-strong)]" : ""}
                        >
                          {report.status === "published" ? (
                            <IconEyeOff className="h-4 w-4" />
                          ) : (
                            <IconEye className="h-4 w-4" />
                          )}
                        </IconButton>
                        <IconButton
                          size="sm"
                          title="重新生成"
                          aria-label="重新生成"
                          disabled={isPending}
                          onClick={(event) => runCardAction(event, report, "regenerate")}
                        >
                          <IconRefresh className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          size="sm"
                          title="删除日报"
                          aria-label="删除日报"
                          disabled={isPending}
                          onClick={(event) => openDeleteDialog(event, report)}
                          className="hover:text-[var(--danger-ink)]"
                        >
                          <IconTrash className="h-4 w-4" />
                        </IconButton>
                      </div>
                    ) : null}
                    <div className="min-w-0">
                      <div className={cx("min-w-0", isAdmin ? "pr-28 sm:pr-32" : "")}>
                        <div className="flex min-w-0 items-center gap-2">
                          <h2 className="min-w-0 text-lg font-semibold text-[var(--foreground)]">
                            <Link
                              href={`/daily/${report.date}`}
                              target="_blank"
                              rel="noreferrer"
                              className="block min-w-0 truncate transition hover:text-[var(--accent-strong)] hover:underline"
                            >
                              {report.title}
                            </Link>
                          </h2>
                          {isAdmin ? (
                            <span className={cx("shrink-0 rounded-sm px-2 py-0.5 text-xs", statusClass(report.status))}>
                              {statusLabel(report.status)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-3 line-clamp-5 text-sm leading-6 text-[var(--text-2)]">
                        {renderInlineMarkdown(report.openingSummary || report.errorMessage || "")}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
              <PaginationControls
                totalItems={total}
                page={page}
                totalPages={totalPages}
                pageSize={pageSize}
                onPageChange={(nextPage) => updateQuery({ page: nextPage })}
                onPageSizeChange={(nextPageSize) => updateQuery({ page: 1, pageSize: nextPageSize })}
                jumpValue={jumpToPage}
                onJumpValueChange={setJumpToPage}
                onJump={handleJumpToPage}
              />
            </>
          )}
        </section>
      </div>

      <ModalShell
        isOpen={generateDialogOpen}
        onClose={() => setGenerateDialogOpen(false)}
        title="生成日报"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setGenerateDialogOpen(false)} disabled={isPending}>
              取消
            </Button>
            <Button variant="primary" onClick={generate} disabled={isPending || !generateDate}>
              生成日报
            </Button>
          </div>
        }
      >
        <div className="space-y-2">
          <label className="block text-sm text-[var(--text-2)]" htmlFor="daily-report-generate-date">
            日报日期
          </label>
          <input
            id="daily-report-generate-date"
            type="date"
            value={generateDate}
            max={getTodayValue()}
            onChange={(event) => setGenerateDate(event.target.value)}
            className="min-h-10 w-full rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-1)] outline-none transition focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent-soft)]"
          />
        </div>
      </ModalShell>

      <ModalShell
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="确认删除日报"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteTarget(null)} disabled={isPending}>
              取消
            </Button>
            <Button variant="danger" onClick={confirmDelete} disabled={isPending}>
              确认删除
            </Button>
          </div>
        }
      >
        <p className="text-sm leading-6 text-[var(--text-2)]">
          将永久删除“{deleteTarget?.title ?? ""}”，关联来源引用也会一起删除。此操作不可恢复。
        </p>
      </ModalShell>
    </>
  );
}
