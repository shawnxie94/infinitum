"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { IconExternalLink, IconRotateCw } from "@/components/ui/icons";
import type {
  ActionableMonitorItem,
  ActionableMonitorRangeDays,
  ActionableMonitorSnapshot,
} from "@/lib/admin/actionable-monitor";
import { cx } from "@/lib/ui/cx";

const rangeOptions: Array<{ value: ActionableMonitorRangeDays; label: string }> = [
  { value: 1, label: "1天" },
  { value: 3, label: "3天" },
  { value: 7, label: "7天" },
];

const categoryOrder: Record<ActionableMonitorItem["category"], number> = {
  source: 0,
  task: 1,
  split: 2,
  cluster: 3,
  content: 4,
  entity: 5,
  preference: 6,
};

function buildDefaultActionItems(rangeDays: ActionableMonitorRangeDays): ActionableMonitorItem[] {
  return [
    {
      id: "sources",
      category: "source",
      severity: "info",
      title: "异常信息源",
      description: "当前没有需要处理的信息源异常。",
      count: 0,
      href: "/admin?tab=monitoring&section=dashboard&sourceSummary=open",
      actionLabel: "查看",
      details: [],
    },
    {
      id: "tasks",
      category: "task",
      severity: "info",
      title: "近期失败任务",
      description: `近 ${rangeDays} 天没有失败或部分成功任务。`,
      count: 0,
      href: `/admin?tab=monitoring&section=tasks&status=failed&rangeDays=${rangeDays}`,
      actionLabel: "查看",
      details: [],
    },
    {
      id: "aggregation-splits",
      category: "split",
      severity: "info",
      title: "聚合拆分复核",
      description: `近 ${rangeDays} 天没有需要复核的聚合拆分记录。`,
      count: 0,
      href: `/admin?tab=monitoring&section=content&view=splits&rangeDays=${rangeDays}`,
      actionLabel: "查看",
      details: [],
    },
    {
      id: "clusters",
      category: "cluster",
      severity: "info",
      title: "聚合待定",
      description: `近 ${rangeDays} 天没有待确认的聚合合并候选。`,
      count: 0,
      href: `/admin?tab=monitoring&section=content&view=clusters&review=pending&rangeDays=${rangeDays}`,
      actionLabel: "查看",
      details: [],
    },
    {
      id: "filtered-content",
      category: "content",
      severity: "info",
      title: "过滤内容复核",
      description: `近 ${rangeDays} 天没有需要复核的过滤内容。`,
      count: 0,
      href: `/admin?tab=monitoring&section=content&view=filtered&rangeDays=${rangeDays}`,
      actionLabel: "查看",
      details: [],
    },
    {
      id: "entities",
      category: "entity",
      severity: "info",
      title: "实体治理建议",
      description: "当前没有待处理的实体治理建议。",
      count: 0,
      href: "/admin?tab=monitoring&section=content&view=entities&suggestions=open",
      actionLabel: "查看",
      details: [],
    },
    {
      id: "briefing-preferences",
      category: "preference",
      severity: "info",
      title: "偏好建议",
      description: "当前没有待处理的事件偏好建议。",
      count: 0,
      href: "/admin?tab=settings&section=content&view=event-briefing&suggestions=open",
      actionLabel: "查看",
      details: [],
    },
  ];
}

function isActionableMonitorSnapshot(value: unknown): value is ActionableMonitorSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  return "items" in value && "totalCount" in value && "rangeDays" in value;
}

function ActionItemCard({ item }: { item: ActionableMonitorItem }) {
  return (
    <article className="grid gap-4 rounded-lg border border-[color:var(--line)] bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)] md:grid-cols-[minmax(0,1fr)_8.5rem] md:items-center">
      <div className="min-w-0 space-y-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-[var(--foreground)]">
            {item.title}
          </h3>
        </div>
        <p className="text-sm leading-6 text-[var(--text-2)]">
          {item.description}
        </p>
      </div>

      <div className="flex items-center justify-between gap-3 md:flex-col md:items-end">
        <div className="text-left md:text-right">
          <div className="text-3xl font-semibold tabular-nums text-[var(--foreground)]">
            {item.count}
          </div>
        </div>
        <a
          className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-sm bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white transition hover:opacity-90"
          href={item.href}
        >
          {item.actionLabel}
          <IconExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </article>
  );
}

function LoadingPanel() {
  return (
    <div className="space-y-4" aria-label="待办事项加载中">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="h-6 w-44 animate-pulse rounded bg-[var(--bg-muted)]" />
        <div className="h-10 w-56 animate-pulse rounded bg-[var(--bg-muted)]" />
      </div>
      <div className="grid gap-3">
        <div className="h-28 animate-pulse rounded-lg bg-[var(--bg-muted)]" />
        <div className="h-28 animate-pulse rounded-lg bg-[var(--bg-muted)]" />
      </div>
    </div>
  );
}

export function ActionItemsPanel() {
  const { showToast } = useToast();
  const [snapshot, setSnapshot] = useState<ActionableMonitorSnapshot | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [rangeDays, setRangeDays] = useState<ActionableMonitorRangeDays>(1);

  const refreshSnapshot = useCallback(async () => {
    setIsRefreshing(true);

    try {
      const response = await fetch(`/api/admin/monitor/action-items?rangeDays=${rangeDays}`);
      const payload = (await response.json()) as ActionableMonitorSnapshot | { error?: string };

      if (!response.ok || !isActionableMonitorSnapshot(payload)) {
        showToast(
          "error" in payload && payload.error ? payload.error : "刷新待办事项失败",
          "error",
        );
        return;
      }

      setSnapshot(payload);
    } catch {
      showToast("刷新待办事项失败", "error");
    } finally {
      setIsRefreshing(false);
    }
  }, [rangeDays, showToast]);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  const orderedItems = useMemo(
    () => {
      const itemsById = new Map(buildDefaultActionItems(rangeDays).map((item) => [item.id, item]));
      for (const item of snapshot?.items ?? []) {
        itemsById.set(item.id, item);
      }

      return [...itemsById.values()].sort((left, right) => {
        const countDiff = right.count - left.count;
        if (countDiff !== 0) {
          return countDiff;
        }
        return categoryOrder[left.category] - categoryOrder[right.category];
      });
    },
    [rangeDays, snapshot?.items],
  );
  if (isRefreshing && !snapshot) {
    return <LoadingPanel />;
  }

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            待办事项
          </h2>
          <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
            实时聚合异常和近期待处理事项
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-sm bg-[var(--bg-muted)] p-1"
            aria-label="待办事项时间范围"
          >
            {rangeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={rangeDays === option.value}
                className={cx(
                  "min-h-8 min-w-12 rounded-sm px-3 text-sm font-medium transition",
                  rangeDays === option.value
                    ? "bg-[var(--surface)] text-[var(--foreground)] shadow-[var(--shadow-sm)]"
                    : "text-[var(--text-2)] hover:text-[var(--foreground)]",
                )}
                onClick={() => setRangeDays(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button
            onClick={() => void refreshSnapshot()}
            variant="secondary"
            disabled={isRefreshing}
          >
            <IconRotateCw className={cx("mr-1 h-4 w-4", isRefreshing && "animate-spin")} />
            刷新
          </Button>
        </div>
      </section>

      <section className="grid gap-3 xl:grid-cols-2" aria-label="待处理事项列表">
        {orderedItems.map((item) => (
          <ActionItemCard key={item.id} item={item} />
        ))}
      </section>
    </div>
  );
}
