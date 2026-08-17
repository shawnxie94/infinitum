"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";

import {
  deleteDailyReport,
  getAdminDailyReportDetail,
  getDailyReportRevision,
  getDailyReportRevisions,
  publishDailyReport,
  requestDailyReportGeneration,
  restoreDailyReportRevision,
  unpublishDailyReport,
} from "@/components/daily/daily-report.api";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useClientAdminSessionState } from "@/components/ui/use-client-admin-session";
import {
  IconArrowDown,
  IconClock,
  IconEye,
  IconEyeOff,
  IconList,
  IconNote,
  IconRefresh,
  IconTrash,
} from "@/components/ui/icons";
import { ModalShell } from "@/components/ui/modal-shell";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { formatDailyReportDateTime } from "@/lib/daily-report/date";
import { buildDailyReportDetailMarkdown } from "@/lib/daily-report/export";
import type { DailyReportDetailDTO } from "@/lib/daily-report/types";
import type { DailyReportRevisionDetailDTO, DailyReportRevisionListItemDTO } from "@/lib/daily-report/types";
import { renderSafeMarkdown } from "@/lib/markdown/safe-html";
import { cx } from "@/lib/ui/cx";

type DailyReportDetailProps = {
  report: DailyReportDetailDTO | null;
  date: string;
  isAdmin: boolean;
  hydrateAdminClient?: boolean;
};

type DailyReportDetailContentProps = {
  report: DailyReportDetailDTO;
  isAdmin: boolean;
};

type AdminReportState = {
  date: string | null;
  report: DailyReportDetailDTO | null;
};

type TocItem = {
  id: string;
  text: string;
  level: number;
};

type CandidateReview = NonNullable<DailyReportDetailDTO["candidateReview"]>;
type CandidateReviewMode = "candidates" | "excluded";

function stripRevisionTitle(markdown: string, title: string) {
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== `# ${title.trim()}`) return markdown;
  return lines.slice(1).join("\n").replace(/^\s*\n/, "");
}

function DailyReportHistoryModal({
  isOpen,
  date,
  currentStatus,
  onClose,
  onRestored,
}: {
  isOpen: boolean;
  date: string;
  currentStatus: DailyReportDetailDTO["status"];
  onClose: () => void;
  onRestored: () => void;
}) {
  const [revisions, setRevisions] = useState<DailyReportRevisionListItemDTO[]>([]);
  const [selected, setSelected] = useState<DailyReportRevisionDetailDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setLoading(true);
      setFeedback(null);
      const result = await getDailyReportRevisions(date);
      if (cancelled) return;
      if (!result.ok || result.data.error) setFeedback(result.data.error ?? "历史版本加载失败。");
      setRevisions(result.data.revisions ?? []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [date, isOpen]);

  const selectRevision = (revision: DailyReportRevisionListItemDTO) => {
    void getDailyReportRevision(date, revision.id).then((result) => {
      if (!result.ok || result.data.error) {
        setFeedback(result.data.error ?? "版本详情加载失败。");
        return;
      }
      setSelected(result.data.revision ?? null);
    });
  };

  const restore = () => {
    if (!selected?.canRestore || currentStatus !== "draft") return;
    setRestoring(true);
    setFeedback(null);
    void restoreDailyReportRevision(date, selected.id).then((result) => {
      setRestoring(false);
      if (!result.ok || result.data.error) {
        setFeedback(result.data.error ?? "历史版本恢复失败。");
        return;
      }
      onRestored();
      onClose();
    });
  };

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="日报生成历史"
      widthClassName="max-w-4xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>关闭</Button>
            <Button variant="primary" onClick={restore} disabled={restoring || currentStatus !== "draft" || !selected?.canRestore}>
              {restoring ? "恢复中..." : "恢复"}
            </Button>
          </div>
        </div>
      }
    >
      {feedback ? <div className="mb-3 rounded-sm bg-[var(--bg-muted)] px-3 py-2 text-sm text-[var(--text-2)]">{feedback}</div> : null}
      {currentStatus !== "draft" ? <div className="mb-3 rounded-sm bg-[var(--bg-muted)] px-3 py-2 text-sm text-[var(--text-2)]">已发布日报不能恢复历史版本，请先撤回为草稿。</div> : null}
      {loading ? <p className="text-sm text-[var(--text-2)]">加载中...</p> : (
        <div className="grid gap-4 md:grid-cols-[15rem_1fr]">
          <div className="space-y-1">
            {revisions.length === 0 ? <p className="text-sm text-[var(--text-2)]">暂无生成历史。</p> : revisions.map((revision) => (
              <button
                key={revision.id}
                type="button"
                onClick={() => selectRevision(revision)}
                className={cx("w-full rounded-sm border px-3 py-2 text-left text-sm", selected?.id === revision.id ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[color:var(--line)] hover:bg-[var(--bg-muted)]")}
              >
                <span className="block font-medium">#{revision.revisionNo} {revision.action === "baseline" ? "基线" : revision.action === "restored" ? "恢复" : "生成"}</span>
                <span className="mt-1 block truncate text-xs text-[var(--text-2)]">{revision.title}</span>
                <span className="mt-1 block text-[11px] text-[var(--text-3)]">{formatDailyReportDateTime(revision.createdAt)}{revision.isCurrent ? " · 当前" : ""}</span>
              </button>
            ))}
          </div>
          <div className="min-h-40 rounded-sm border border-[color:var(--line)] bg-[var(--bg-muted)] p-4">
            {selected ? (
              <>
                <h3 className="font-semibold leading-6 text-[var(--text-1)]">{selected.title}</h3>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-[var(--text-3)]">
                  <span>版本 #{selected.revisionNo}</span><span>{selected.status === "published" ? "已发布" : "草稿"}</span><span>{selected.sources.length} 个来源</span>
                </div>
                <div
                  className="article-prose prose prose-sm mt-4 max-h-[32rem] max-w-none overflow-y-auto border-t border-[color:var(--line)] pt-4"
                  dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(stripRevisionTitle(selected.renderedMarkdown, selected.title), { headingIdPrefix: `revision-${selected.id}` }) }}
                />
              </>
            ) : <p className="text-sm text-[var(--text-2)]">选择左侧版本查看正文和恢复资格。</p>}
          </div>
        </div>
      )}
    </ModalShell>
  );
}

const candidateReviewPageSize = 8;

function statusLabel(status: DailyReportDetailDTO["status"]) {
  if (status === "published") return "已发布";
  if (status === "failed") return "失败";
  return "草稿";
}

function truncateNavTitle(title: string) {
  return title.length > 24 ? `${title.slice(0, 24)}...` : title;
}

function TableOfContents({ items, activeId, onSelect }: {
  items: TocItem[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <nav className="space-y-1 border-l-2 border-[color:var(--line)] pl-2">
      {items.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          onClick={(event) => {
            event.preventDefault();
            onSelect(item.id);
          }}
          className={cx(
            "block truncate rounded-sm px-2 py-1 text-xs transition",
            activeId === item.id
              ? "bg-[var(--accent-soft)] font-semibold text-[var(--accent-strong)]"
              : "text-[var(--text-2)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]",
          )}
          style={{ paddingLeft: `${(item.level - 1) * 8 + 8}px` }}
        >
          {item.text}
        </a>
      ))}
    </nav>
  );
}

function DailyReportUnavailable({ isAdmin, isLoading }: { isAdmin: boolean; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="flex min-h-48 w-full items-center justify-center px-4 py-12 text-sm text-[var(--text-2)]">
        加载中...
      </div>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-1 items-center justify-center px-4 py-16 text-center sm:px-6 lg:px-8">
      <div className="panel-raised rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-6 py-8 shadow-[var(--shadow-sm)]">
        <h1 className="text-xl font-semibold text-[var(--foreground)]">日报不存在</h1>
        <p className="mt-3 text-sm leading-6 text-[var(--text-2)]">
          {isAdmin ? "未找到这篇日报，或日报已被删除。" : "这篇日报尚未发布或不存在。"}
        </p>
        <Link
          href="/daily"
          className="mt-5 inline-flex rounded-sm bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
        >
          返回日报列表
        </Link>
      </div>
    </section>
  );
}

function isExcludedCandidate(
  candidate: CandidateReview["candidates"][number] | CandidateReview["excludedRecentDuplicates"][number],
): candidate is CandidateReview["excludedRecentDuplicates"][number] {
  return "excludedReason" in candidate;
}

function formatCandidateEventAnchor(candidate: CandidateReview["candidates"][number]) {
  return [
    candidate.eventSubject,
    candidate.eventAction,
    candidate.eventObject,
    candidate.eventDate,
  ].filter(Boolean).join(" / ");
}

function CandidateReviewModal({
  isOpen,
  onClose,
  review,
}: {
  isOpen: boolean;
  onClose: () => void;
  review: CandidateReview;
}) {
  const [mode, setMode] = useState<CandidateReviewMode>("candidates");
  const [page, setPage] = useState(1);
  const items = mode === "candidates" ? review.candidates : review.excludedRecentDuplicates;
  const totalPages = Math.max(1, Math.ceil(items.length / candidateReviewPageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleItems = items.slice(
    (currentPage - 1) * candidateReviewPageSize,
    currentPage * candidateReviewPageSize,
  );

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="候选与去重"
      widthClassName="max-w-3xl"
      panelClassName="flex max-h-[calc(100vh-2rem)] flex-col"
      bodyClassName="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
      footerClassName="shrink-0 border-t border-[color:var(--line)] bg-[var(--surface-muted)] p-4"
      footer={
        items.length > 0 ? (
          <PaginationControls
            totalItems={items.length}
            page={currentPage}
            totalPages={totalPages}
            pageSize={candidateReviewPageSize}
            pageSizeOptions={[candidateReviewPageSize]}
            onPageChange={setPage}
            onPageSizeChange={() => setPage(1)}
          />
        ) : null
      }
    >
      <div className="rounded-sm border border-[color:var(--line)] bg-[var(--bg-muted)] p-3 text-center text-xs text-[var(--text-2)] sm:p-4">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <div className="text-lg font-semibold text-[var(--foreground)]">{review.candidateCount}</div>
            <div>候选</div>
          </div>
          <div>
            <div className="text-lg font-semibold text-[var(--foreground)]">{review.selectedCount}</div>
            <div>入选</div>
          </div>
          <div>
            <div className="text-lg font-semibold text-[var(--foreground)]">{review.excludedRecentDuplicates.length}</div>
            <div>近期重复</div>
          </div>
        </div>

        {review.candidateCoverage ? (
          <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 border-t border-[color:var(--line)]/70 pt-3 text-[var(--text-3)]">
            <span>高排名 {review.candidateCoverage.selectedTopRankCount}/{review.candidateCoverage.topRankPoolCount}</span>
            <span>当日新增 {review.candidateCoverage.selectedSameDayCount}/{review.candidateCoverage.sameDayCandidateCount}</span>
            <span>低排名入选 {review.candidateCoverage.lowRankSelectedCount}</span>
          </div>
        ) : null}

        {review.candidateCoverage?.warnings.length ? (
          <div className="mt-3 rounded-sm bg-amber-50 px-2 py-1.5 text-left leading-5 text-amber-800">
            覆盖告警：{review.candidateCoverage.warnings.join("、")}
          </div>
        ) : null}
      </div>

      <div className="inline-flex rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-1">
        <button
          type="button"
          onClick={() => {
            setMode("candidates");
            setPage(1);
          }}
          className={cx(
            "rounded-sm px-3 py-1.5 text-sm transition",
            mode === "candidates"
              ? "bg-[var(--accent)] text-white"
              : "text-[var(--text-2)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]",
          )}
        >
          全部候选
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("excluded");
            setPage(1);
          }}
          className={cx(
            "rounded-sm px-3 py-1.5 text-sm transition",
            mode === "excluded"
              ? "bg-[var(--accent)] text-white"
              : "text-[var(--text-2)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]",
          )}
        >
          重复排除
        </button>
      </div>

      <div className="min-h-72 space-y-2">
        {visibleItems.length === 0 ? (
          <div className="rounded-sm border border-[color:var(--line)] bg-[var(--bg-muted)] p-5 text-sm text-[var(--text-3)]">
            {mode === "candidates" ? "暂无候选" : "无重复排除"}
          </div>
        ) : visibleItems.map((candidate) => (
          <div
            key={`${candidate.sourceKey}-${isExcludedCandidate(candidate) ? candidate.matchedRecentDate ?? "" : ""}`}
            className="rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-3"
          >
            <div className="line-clamp-2 text-sm font-medium leading-6 text-[var(--text-1)]">
              {candidate.itemTitle}
            </div>
            {candidate.title !== candidate.itemTitle ? (
              <div className="mt-1 text-xs text-[var(--text-3)]">
                事件：{candidate.title}
              </div>
            ) : formatCandidateEventAnchor(candidate) ? (
              <div className="mt-1 text-xs text-[var(--text-3)]">
                事件：{formatCandidateEventAnchor(candidate)}
              </div>
            ) : null}
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--text-3)]">
              <span>{candidate.sourceName}</span>
              <span>分数 {candidate.candidateScore}</span>
              <span>来源 {candidate.sourceCount}</span>
              <span>内容 {candidate.itemCount}</span>
            </div>
            {isExcludedCandidate(candidate) ? (
              <div className="mt-2 rounded-sm bg-[var(--bg-muted)] px-2 py-1 text-xs leading-5 text-[var(--text-2)]">
                {candidate.excludedReason}
                {candidate.matchedRecentDate ? `：${candidate.matchedRecentDate}` : ""}
                {candidate.matchedRecentTitle ? ` · ${candidate.matchedRecentTitle}` : ""}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </ModalShell>
  );
}

export function DailyReportDetail({
  report: initialReport,
  date,
  isAdmin: initialIsAdmin,
  hydrateAdminClient = false,
}: DailyReportDetailProps) {
  const { isAdmin, isResolving: isResolvingAdminSession } = useClientAdminSessionState(
    initialIsAdmin,
    hydrateAdminClient,
  );
  const [adminReportState, setAdminReportState] = useState<AdminReportState>({
    date: null,
    report: null,
  });
  const shouldFetchAdminReport = hydrateAdminClient && isAdmin && !initialIsAdmin;
  const adminReport = adminReportState.date === date ? adminReportState.report : null;
  const report = adminReport ?? initialReport;
  const isLoadingAdminReport = shouldFetchAdminReport && adminReportState.date !== date;

  useEffect(() => {
    if (!shouldFetchAdminReport || adminReportState.date === date) {
      return;
    }

    let active = true;

    getAdminDailyReportDetail(date)
      .then((result) => {
        if (!active) return;
        setAdminReportState({
          date,
          report: result.ok ? (result.data.report ?? null) : null,
        });
      })
      .catch(() => {
        if (active) {
          setAdminReportState({ date, report: null });
        }
      });

    return () => {
      active = false;
    };
  }, [adminReportState.date, date, shouldFetchAdminReport]);

  if (!report) {
    return (
      <DailyReportUnavailable
        isAdmin={isAdmin}
        isLoading={isResolvingAdminSession || (isAdmin && isLoadingAdminReport)}
      />
    );
  }

  return <DailyReportDetailContent report={report} isAdmin={isAdmin} />;
}

function DailyReportDetailContent({ report, isAdmin }: DailyReportDetailContentProps) {
  const router = useRouter();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const sourceListOpenStateRef = useRef(new Map<string, boolean>());
  const sourceListContentHtmlRef = useRef("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [candidateReviewOpen, setCandidateReviewOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeTocId, setActiveTocId] = useState("top");
  const [tocItems, setTocItems] = useState<TocItem[]>([]);
  const [isPending, startTransition] = useTransition();
  const sourceStats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of report.sources) {
      counts.set(source.sourceName, (counts.get(source.sourceName) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  }, [report.sources]);
  const detailMarkdown = useMemo(() => buildDailyReportDetailMarkdown(report), [report]);
  const contentHtml = useMemo(() => renderSafeMarkdown(detailMarkdown, {
    headingIdPrefix: "daily-heading",
    collapsibleSourceLists: true,
  }), [detailMarkdown]);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const headings = Array.from(content.querySelectorAll<HTMLHeadingElement>("h2, h3"));
    const nextItems = headings.map((heading) => {
      return {
        id: heading.id,
        text: heading.textContent ?? "",
        level: Number.parseInt(heading.tagName[1] ?? "2", 10),
      };
    }).filter((item) => item.id);

    setTocItems(nextItems);
    setActiveTocId(nextItems[0]?.id ?? "");
  }, [contentHtml]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    if (sourceListContentHtmlRef.current !== contentHtml) {
      sourceListContentHtmlRef.current = contentHtml;
      sourceListOpenStateRef.current.clear();
    }

    const sourceLists = Array.from(content.querySelectorAll<HTMLDetailsElement>("details.daily-report-source-list"));
    sourceLists.forEach((details, index) => {
      const key = String(index);
      details.dataset.sourceListKey = key;
      details.open = sourceListOpenStateRef.current.get(key) ?? false;
    });
  });

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const handleSourceListToggle = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement) || !target.classList.contains("daily-report-source-list")) {
        return;
      }

      const sourceLists = Array.from(content.querySelectorAll<HTMLDetailsElement>("details.daily-report-source-list"));
      const key = target.dataset.sourceListKey ?? String(sourceLists.indexOf(target));
      if (key === "-1") return;
      target.dataset.sourceListKey = key;
      sourceListOpenStateRef.current.set(key, target.open);
    };

    content.addEventListener("toggle", handleSourceListToggle, true);
    return () => {
      content.removeEventListener("toggle", handleSourceListToggle, true);
    };
  }, [contentHtml]);

  useEffect(() => {
    if (tocItems.length === 0) return;

    let frameId = 0;
    const updateActiveHeading = () => {
      frameId = 0;
      const bottomDistance = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
      if (bottomDistance < 128 && tocItems.at(-1)?.id) {
        setActiveTocId(tocItems.at(-1)?.id ?? "");
        return;
      }

      const anchorTop = 128;
      const headings = tocItems
        .map((item) => ({
          id: item.id,
          top: document.getElementById(item.id)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
        }))
        .filter((item) => Number.isFinite(item.top));

      const nextActiveId = headings
        .map((item) => ({ ...item, distance: Math.abs(item.top - anchorTop) }))
        .sort((left, right) => left.distance - right.distance)[0]?.id ?? tocItems[0]?.id;

      if (nextActiveId) {
        setActiveTocId(nextActiveId);
      }
    };

    const scheduleUpdate = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(updateActiveHeading);
    };

    updateActiveHeading();
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [tocItems]);

  const handleTocSelect = (id: string) => {
    setActiveTocId(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const runAction = (action: "publish" | "unpublish" | "regenerate") => {
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
        setFeedback("重新生成任务已提交。");
        return;
      }

      const result = action === "publish"
        ? await publishDailyReport(report.date)
        : await unpublishDailyReport(report.date);
      if (!result.ok || result.data.error) {
        setFeedback(result.data.error ?? "操作失败。");
        return;
      }
      setFeedback("状态已更新。");
      router.refresh();
    });
  };

  const exportMarkdown = () => {
    const blob = new Blob([`# ${report.title}\n\n${detailMarkdown.trim()}\n`], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${report.date}-ai-daily.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const confirmDelete = () => {
    startTransition(async () => {
      setFeedback(null);
      const result = await deleteDailyReport(report.date);
      if (!result.ok || result.data.error) {
        setFeedback(result.data.error ?? "日报删除失败。");
        return;
      }
      setDeleteDialogOpen(false);
      router.push("/daily");
    });
  };

  return (
    <>
      <section className="border-b border-[color:var(--line)] bg-[var(--surface)]">
        <div className="mx-auto w-full max-w-7xl px-4 py-5 text-center sm:px-6 sm:py-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <h1 className="text-2xl font-semibold text-[var(--foreground)]">{report.title}</h1>
            {isAdmin ? <span className="rounded-sm bg-[var(--bg-muted)] px-2 py-0.5 text-xs text-[var(--text-2)]">{statusLabel(report.status)}</span> : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-sm text-[var(--text-2)]">
            <span>来源：{report.sourceCount} 个引用</span>
            <span>生成：{formatDailyReportDateTime(report.generatedAt)}</span>
          </div>
        </div>
      </section>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:flex-row lg:px-8">
        <article className="panel-raised min-w-0 flex-1 rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)] sm:p-7">
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-[var(--foreground)]">
                <IconNote className="h-4 w-4" />
                <span>内容</span>
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {isAdmin && report.candidateReview ? (
                <IconButton
                  onClick={() => setCandidateReviewOpen(true)}
                  variant="ghost"
                  size="md"
                  title="查看候选与去重"
                  className="rounded-sm"
                >
                  <IconList className="h-4 w-4" />
                </IconButton>
              ) : null}
              {isAdmin ? (
                <IconButton
                  onClick={() => setHistoryOpen(true)}
                  variant="ghost"
                  size="md"
                  title="查看生成历史"
                  className="rounded-sm"
                >
                  <IconClock className="h-4 w-4" />
                </IconButton>
              ) : null}
              <IconButton onClick={exportMarkdown} variant="ghost" size="md" title="导出 Markdown" className="rounded-sm">
                <IconArrowDown className="h-4 w-4" />
              </IconButton>
              {isAdmin ? (
                <>
                  <IconButton
                    onClick={() => runAction("regenerate")}
                    variant="ghost"
                    size="md"
                    title="重新生成日报"
                    disabled={isPending}
                    className="rounded-sm"
                  >
                    <IconRefresh className={cx("h-4 w-4", isPending && "animate-spin")} />
                  </IconButton>
                  <IconButton
                    onClick={() => runAction(report.status === "published" ? "unpublish" : "publish")}
                    variant="ghost"
                    size="md"
                    title={report.status === "published" ? "撤回为草稿" : "发布日报"}
                    disabled={isPending || report.status === "failed"}
                    className="rounded-sm"
                  >
                    {report.status === "published" ? (
                      <IconEyeOff className="h-4 w-4" />
                    ) : (
                      <IconEye className="h-4 w-4" />
                    )}
                  </IconButton>
                  <IconButton
                    onClick={() => setDeleteDialogOpen(true)}
                    variant="ghost"
                    size="md"
                    title="删除日报"
                    disabled={isPending}
                    className="rounded-sm hover:text-[var(--danger-ink)]"
                  >
                    <IconTrash className="h-4 w-4" />
                  </IconButton>
                </>
              ) : null}
            </div>
          </div>

          {feedback ? <div className="mb-5 rounded-sm bg-[var(--bg-muted)] px-3 py-2 text-sm text-[var(--text-2)]">{feedback}</div> : null}

          <div
            ref={contentRef}
            className="article-prose prose prose-sm max-w-none break-words overflow-x-auto"
            dangerouslySetInnerHTML={{ __html: contentHtml }}
          />

          <div className="mt-8 flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <Link
              href={report.previous ? `/daily/${report.previous.date}` : "#"}
              aria-disabled={!report.previous}
              title={report.previous?.title ?? "无上一篇"}
              className={cx(
                "rounded-lg px-3 py-2 text-left transition",
                report.previous
                  ? "bg-[var(--bg-muted)] text-[var(--text-2)] hover:bg-[var(--surface)] hover:text-[var(--text-1)]"
                  : "pointer-events-none cursor-not-allowed bg-[var(--bg-muted)] text-[var(--text-3)]",
              )}
            >
              <span className="block">← 上一篇</span>
              {report.previous ? (
                <span className="block text-xs text-[var(--text-3)]">{truncateNavTitle(report.previous.title)}</span>
              ) : null}
            </Link>
            <Link
              href={report.next ? `/daily/${report.next.date}` : "#"}
              aria-disabled={!report.next}
              title={report.next?.title ?? "无下一篇"}
              className={cx(
                "rounded-lg px-3 py-2 text-right transition",
                report.next
                  ? "bg-[var(--bg-muted)] text-[var(--text-2)] hover:bg-[var(--surface)] hover:text-[var(--text-1)]"
                  : "pointer-events-none cursor-not-allowed bg-[var(--bg-muted)] text-[var(--text-3)]",
              )}
            >
              <span className="block">下一篇 →</span>
              {report.next ? (
                <span className="block text-xs text-[var(--text-3)]">{truncateNavTitle(report.next.title)}</span>
              ) : null}
            </Link>
          </div>
        </article>

        <aside className="w-full flex-shrink-0 lg:w-80">
          <div className="panel-raised rounded-sm border border-[color:var(--line)] p-4 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
            <div className="mb-3 flex items-center gap-2">
              <IconList className="h-4 w-4 text-[var(--text-2)]" />
              <h2 className="text-base font-semibold text-[var(--foreground)]">目录</h2>
            </div>
            <TableOfContents items={tocItems} activeId={activeTocId} onSelect={handleTocSelect} />
            <div className="mt-5 border-t border-[color:var(--line)] pt-4">
              <h3 className="text-base font-semibold text-[var(--foreground)]">来源统计</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {sourceStats.map((source) => (
                  <span key={source.name} className="rounded-sm bg-[var(--bg-muted)] px-2 py-1 text-xs text-[var(--text-2)]">
                    {source.name} {source.count}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </aside>
      </div>

      {isAdmin && candidateReviewOpen && report.candidateReview ? (
        <CandidateReviewModal
          key={report.id}
          isOpen={candidateReviewOpen}
          onClose={() => setCandidateReviewOpen(false)}
          review={report.candidateReview}
        />
      ) : null}

      {isAdmin ? (
        <DailyReportHistoryModal
          isOpen={historyOpen}
          date={report.date}
          currentStatus={report.status}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => router.refresh()}
        />
      ) : null}

      <ModalShell
        isOpen={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        title="确认删除日报"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteDialogOpen(false)} disabled={isPending}>
              取消
            </Button>
            <Button variant="danger" onClick={confirmDelete} disabled={isPending}>
              确认删除
            </Button>
          </div>
        }
      >
        <p className="text-sm leading-6 text-[var(--text-2)]">
          将永久删除“{report.title}”，关联来源引用也会一起删除。此操作不可恢复。
        </p>
      </ModalShell>
    </>
  );
}
