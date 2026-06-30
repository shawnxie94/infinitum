"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  LineChart,
  Line,
} from "recharts";
import type { LegendPayload } from "recharts";

import { SourceMonitorPanel } from "@/components/admin/source-monitor-panel";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type {
  DailyArticleStat,
  DailyAiUsageStat,
  DailySourceHealthStat,
  QualityScoreBucket,
  IngestionMetrics,
} from "@/lib/ingestion/metrics-service";

type IngestionDashboardProps = {
  initialOpenSourceAttentionSummary?: boolean;
};

const CHART_COLORS = {
  articles: "var(--accent)",
  summaries: "#8884d8",
  analyses: "#82ca9d",
  aggregations: "#a78bfa",
  clusterMatches: "#ffc658",
  clusterMerges: "#06b6d4",
  clusterSummaries: "#ff7300",
  dailyReports: "#f43f5e",
  totalCalls: "var(--accent)",
  grid: "var(--line)",
  text: "var(--muted)",
};

const AI_USAGE_SERIES = [
  { dataKey: "totalCalls", name: "总调用", color: CHART_COLORS.totalCalls, strokeWidth: 2 },
  { dataKey: "summaries", name: "摘要生成", color: CHART_COLORS.summaries, strokeWidth: 1.5 },
  { dataKey: "analyses", name: "内容分析", color: CHART_COLORS.analyses, strokeWidth: 1.5 },
  { dataKey: "aggregations", name: "聚合拆条", color: CHART_COLORS.aggregations, strokeWidth: 1.5 },
  { dataKey: "clusterMatches", name: "聚合匹配", color: CHART_COLORS.clusterMatches, strokeWidth: 1.5 },
  { dataKey: "clusterMerges", name: "聚合合并", color: CHART_COLORS.clusterMerges, strokeWidth: 1.5 },
  { dataKey: "clusterSummaries", name: "聚合摘要", color: CHART_COLORS.clusterSummaries, strokeWidth: 1.5 },
  { dataKey: "dailyReports", name: "AI 日报", color: CHART_COLORS.dailyReports, strokeWidth: 1.5 },
] as const;

function formatDateLabel(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function ArticleTrendChart({ data }: { data: DailyArticleStat[] }) {
  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <EmptyState>暂无文章数据</EmptyState>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
        <XAxis
          dataKey="date"
          tickFormatter={formatDateLabel}
          tick={{ fontSize: 12, fill: CHART_COLORS.text }}
          interval="preserveStartEnd"
        />
        <YAxis tick={{ fontSize: 12, fill: CHART_COLORS.text }} width={40} />
        <Tooltip
          labelFormatter={(label) => `日期: ${label}`}
          formatter={(value) => [`${String(value)} 篇`, "新增文章"]}
        />
        <Bar dataKey="count" fill={CHART_COLORS.articles} radius={[2, 2, 0, 0]} name="新增文章" />
      </BarChart>
    </ResponsiveContainer>
  );
}

function AiUsageLegend({ payload }: { payload?: ReadonlyArray<LegendPayload> }) {
  const payloadByKey = new Map(
    (payload ?? []).map((entry) => [String(entry.dataKey), entry])
  );

  return (
    <div className="mt-2 overflow-x-auto pb-1">
      <div className="flex min-w-max flex-nowrap items-center justify-center gap-x-4 text-[11px] leading-none">
        {AI_USAGE_SERIES.map(({ dataKey, name, color }) => {
          const entry = payloadByKey.get(dataKey);
          const legendColor = entry?.color ?? color;

          return (
            <span
              key={dataKey}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap"
              style={{ color: legendColor }}
            >
              <span className="relative h-3 w-5 shrink-0">
                <span className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-current" />
                <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-current bg-[var(--surface)]" />
              </span>
              <span>{name}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function AiUsageChart({ data }: { data: DailyAiUsageStat[] }) {
  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <EmptyState>暂无AI使用数据</EmptyState>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
        <XAxis
          dataKey="date"
          tickFormatter={formatDateLabel}
          tick={{ fontSize: 12, fill: CHART_COLORS.text }}
          interval="preserveStartEnd"
        />
        <YAxis tick={{ fontSize: 12, fill: CHART_COLORS.text }} width={40} />
        <Tooltip labelFormatter={(label) => `日期: ${label}`} />
        <Legend content={<AiUsageLegend />} />
        {AI_USAGE_SERIES.map(({ dataKey, name, color, strokeWidth }) => (
          <Line
            key={dataKey}
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={strokeWidth}
            dot={false}
            name={name}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function QualityDistributionChart({ data }: { data: QualityScoreBucket[] }) {
  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <EmptyState>暂无质量分数据</EmptyState>
      </div>
    );
  }

  const total = data.reduce((sum, b) => sum + b.count, 0);

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
        <XAxis
          dataKey="range"
          tick={{ fontSize: 12, fill: CHART_COLORS.text }}
        />
        <YAxis tick={{ fontSize: 12, fill: CHART_COLORS.text }} width={40} />
        <Tooltip
          formatter={(value) => {
            const num = Number(value) || 0;
            const pct = total > 0 ? ((num / total) * 100).toFixed(1) : "0";
            return [`${num} 篇 (${pct}%)`, "数量"];
          }}
        />
        <Bar dataKey="count" fill={CHART_COLORS.articles} radius={[2, 2, 0, 0]} name="文章数" />
      </BarChart>
    </ResponsiveContainer>
  );
}

function SourceHealthTrendChart({ data }: { data: DailySourceHealthStat[] }) {
  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-[280px]">
        <EmptyState>暂无源健康数据</EmptyState>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
        <XAxis
          dataKey="date"
          tickFormatter={formatDateLabel}
          tick={{ fontSize: 12, fill: CHART_COLORS.text }}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fontSize: 12, fill: CHART_COLORS.text }}
          width={40}
          allowDecimals={false}
        />
        <Tooltip labelFormatter={(label) => `日期: ${label}`} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line
          type="monotone"
          dataKey="healthy"
          stroke="var(--success-ink)"
          strokeWidth={2}
          dot={false}
          name="正常"
        />
        <Line
          type="monotone"
          dataKey="failed"
          stroke="var(--danger-ink)"
          strokeWidth={2}
          dot={false}
          name="异常"
        />
        <Line
          type="monotone"
          dataKey="unknown"
          stroke="var(--text-3)"
          strokeWidth={2}
          dot={false}
          name="未巡检"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function isValidMetrics(value: unknown): value is IngestionMetrics {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    Array.isArray(m.dailyArticleStats) &&
    Array.isArray(m.dailyAiUsageStats) &&
    Array.isArray(m.dailySourceHealthStats) &&
    Array.isArray(m.qualityScoreDistribution)
  );
}

export function IngestionDashboard({
  initialOpenSourceAttentionSummary = false,
}: IngestionDashboardProps = {}) {
  const { showToast } = useToast();
  const [metrics, setMetrics] = useState<IngestionMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/monitor/metrics");
      const payload = await response.json();

      if (!response.ok) {
        const message = payload && typeof payload === "object" && "error" in payload
          ? (payload as { error: string }).error
          : "获取指标数据失败";
        throw new Error(message);
      }

      if (!isValidMetrics(payload)) {
        throw new Error("无效的指标数据格式");
      }

      setMetrics(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "获取指标数据失败";
      setError(message);
      showToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void fetchMetrics();
  }, [fetchMetrics]);

  if (loading && !metrics) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 rounded bg-[var(--bg-muted)]" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 rounded-sm bg-[var(--bg-muted)]" />
          ))}
        </div>
        <div className="h-80 rounded-sm bg-[var(--bg-muted)]" />
        <div className="h-80 rounded-sm bg-[var(--bg-muted)]" />
      </div>
    );
  }

  if (error && !metrics) {
    return (
      <div className="space-y-4 text-center py-12">
        <p className="text-[var(--danger-ink)]">{error}</p>
        <Button onClick={() => void fetchMetrics()} variant="secondary">
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-[var(--foreground)]">
          数据监控
        </h2>
        <p className="text-sm text-[var(--muted)]">
          摄入管道运行指标与内容质量概览（近30天）
        </p>
      </div>

      {/* Daily Article Trend + AI Usage Trend - side by side */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3 min-w-0" aria-label="每日新增文章趋势">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">
            每日新增文章数趋势
          </h3>
          <div className="rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-4">
            <ArticleTrendChart data={metrics?.dailyArticleStats ?? []} />
          </div>
        </section>

        <section className="space-y-3 min-w-0" aria-label="AI调用趋势">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">
            AI 调用量趋势
          </h3>
          <div className="rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-4">
            <AiUsageChart data={metrics?.dailyAiUsageStats ?? []} />
          </div>
        </section>
      </div>

      {/* Quality Distribution and Health Timeline - side by side */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3" aria-label="内容质量分分布">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">
            内容质量分分布
          </h3>
          <div className="rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-4">
            <QualityDistributionChart data={metrics?.qualityScoreDistribution ?? []} />
          </div>
        </section>

        <section className="space-y-3" aria-label="源健康状态趋势">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">
            源健康状态趋势
          </h3>
          <div className="rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-4">
            <SourceHealthTrendChart data={metrics?.dailySourceHealthStats ?? []} />
          </div>
        </section>
      </div>

      {/* Source Monitor Panel */}
      <section className="space-y-3 border-t border-[color:var(--line)] pt-6" aria-label="信息源监控">
        <SourceMonitorPanel
          hideStats
          initialOpenAttentionSummary={initialOpenSourceAttentionSummary}
        />
      </section>
    </div>
  );
}
