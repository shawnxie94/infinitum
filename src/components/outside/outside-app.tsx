"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DailyReportDetail } from "@/components/daily/daily-report-detail";
import type { DailyReportDetailDTO, DailyReportListItemDTO } from "@/lib/daily-report/types";

type CatalogSource = {
  id: string;
  name: string;
  siteUrl: string;
  enabled: boolean;
  channel: string;
  rawChannel?: string | null;
  originKind: "preset" | "account";
  transport?: "rss" | "adapter";
  groupName: string | null;
  healthStatus: string;
  healthMessage?: string | null;
  followed: boolean;
  followedAt: string | null;
};

type FollowsPayload = {
  sources: CatalogSource[];
  channels: string[];
  followedSourceIds: string[];
};

type DailyPayload = {
  report: DailyReportDetailDTO | null;
  history: DailyReportListItemDTO[];
  error?: string;
};

type DailyGeneration = { id: string; date: string; phase: "fetch" | "report"; status: string; progressLabel: string | null; error: string | null; fetchWarning?: string | null };

type OutsideTab = "sources" | "follows" | "daily";
type DailyLoadState = "idle" | "loading" | "loaded" | "error";
type AccountProvider = { id: string; name: string; capabilities: { search: boolean; resolve: boolean; inputKinds: string[] } };

// 财经版浅色主题隔离：显式钉住复用组件（日报详情）实际使用的全部主题变量，
// 防止系统/用户深色主题经继承渗入；不修改全局主题与 /daily。
const LIGHT_THEME_VARS = {
  "--bg-app": "#f7f7f8",
  "--bg-elevated": "#f1f1f3",
  "--bg-muted": "#f1f1f3",
  "--text-1": "#111111",
  "--text-2": "#434343",
  "--text-3": "#7a7a7a",
  "--border": "#e6e6e8",
  "--border-strong": "#d4d4d8",
  "--brand": "#3b82f6",
  "--brand-strong": "#1e3a8a",
  "--brand-soft": "#e8f0ff",
  "--surface-overlay": "#ffffff",
  "--surface-highlight": "#ffffff",
  "--surface-inset-highlight": "rgba(255, 255, 255, 0.84)",
  "--background": "#f7f7f8",
  "--surface": "#ffffff",
  "--surface-muted": "#f1f1f3",
  "--surface-subtle": "#f1f1f3",
  "--control-surface": "#ffffff",
  "--control-surface-hover": "#f1f1f3",
  "--control-line": "#d4d4d8",
  "--control-line-focus": "#3b82f6",
  "--foreground": "#111111",
  "--muted": "#434343",
  "--line": "#e6e6e8",
  "--line-strong": "#d4d4d8",
  "--accent": "#3b82f6",
  "--accent-strong": "#1e3a8a",
  "--accent-soft": "#e8f0ff",
  "--danger-surface": "#fef2f2",
  "--danger-line": "#fee2e2",
  "--danger-ink": "#991b1b",
  "--success-surface": "#ecfdf5",
  "--success-line": "#a7f3d0",
  "--success-ink": "#047857",
  "--shadow-sm": "0 8px 24px rgba(17, 24, 39, 0.05)",
  "--shadow-lg": "0 24px 56px rgba(17, 24, 39, 0.1)",
} as React.CSSProperties;

const PAGE_META: Record<OutsideTab, { crumb: string; eyebrow: string; title: string; description: string }> = {
  sources: {
    crumb: "信息源",
    eyebrow: "SOURCES",
    title: "添加信息源",
    description: "搜索账号，或从预置 RSS 目录选择关注。",
  },
  follows: {
    crumb: "我的关注",
    eyebrow: "FOLLOWING",
    title: "我的关注",
    description: "日报仅从关注的信息源生成；取消关注不影响源与历史。",
  },
  daily: {
    crumb: "资讯日报",
    eyebrow: "DAILY BRIEFING",
    title: "资讯日报",
    description: "按日期查看由关注信息源生成的日报。",
  },
};

function NavIcon({ kind }: { kind: OutsideTab }) {
  const common = {
    width: 17,
    height: 17,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "sources") {
    return (
      <svg {...common}>
        <rect x="4" y="4" width="7" height="7" rx="1.5" />
        <rect x="13" y="4" width="7" height="7" rx="1.5" />
        <rect x="4" y="13" width="7" height="7" rx="1.5" />
        <rect x="13" y="13" width="7" height="7" rx="1.5" />
      </svg>
    );
  }
  if (kind === "follows") {
    return (
      <svg {...common}>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6S13.9 16 14.5 19" />
        <circle cx="16.5" cy="9.5" r="2.6" />
        <path d="M15.5 14.6c2.3.2 4.2 1.6 4.9 4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="m3 13 9 5 9-5" />
      <path d="m3 17.5 9 5 9-5" opacity="0" />
    </svg>
  );
}

function OrbitMark() {
  return (
    <svg width="36" height="36" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <ellipse cx="20" cy="20" rx="16" ry="8" transform="rotate(-45 20 20)" />
      <ellipse cx="20" cy="20" rx="16" ry="8" transform="rotate(45 20 20)" />
      <circle cx="20" cy="20" r="3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function OutsideApp() {
  const [tab, setTab] = useState<OutsideTab>("sources");
  const [data, setData] = useState<FollowsPayload | null>(null);
  const [accountPlatform, setAccountPlatform] = useState("");
  const [accountProviders, setAccountProviders] = useState<AccountProvider[]>([]);
  const [providersError, setProvidersError] = useState("");
  const [accountWarning, setAccountWarning] = useState("");
  const [sourceStage, setSourceStage] = useState<"cards" | "account">("cards");
  const [followKind, setFollowKind] = useState<"" | "account" | "preset">("");
  const [search, setSearch] = useState("");
  const [presetSearch, setPresetSearch] = useState("");
  const [xueqiuQuery, setXueqiuQuery] = useState("");
  const [xueqiuCandidates, setXueqiuCandidates] = useState<Array<{ uid: string; name: string; siteUrl?: string; avatarUrl?: string | null; description?: string; followed: boolean }>>([]);
  const [xueqiuSearched, setXueqiuSearched] = useState(false);
  const [xueqiuBusy, setXueqiuBusy] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  // 防过期响应：只有最新一次请求允许写入状态。
  const followsRequestIdRef = useRef(0);

  const [dailyDate, setDailyDate] = useState("");
  const [dailyReport, setDailyReport] = useState<DailyReportDetailDTO | null>(null);
  const [dailyHistory, setDailyHistory] = useState<DailyReportListItemDTO[]>([]);
  const [dailyError, setDailyError] = useState("");
  const [dailyLoadState, setDailyLoadState] = useState<DailyLoadState>("idle");
  const dailyRequestIdRef = useRef(0);
  const [dailyGeneration, setDailyGeneration] = useState<DailyGeneration | null>(null);
  const [generationDialog, setGenerationDialog] = useState(false);
  const [generationDate, setGenerationDate] = useState("");
  const [generationError, setGenerationError] = useState("");
  const [generationSubmitting, setGenerationSubmitting] = useState(false);
  const completedGenerationRef = useRef<string | null>(null);
  const generationRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++followsRequestIdRef.current;
    const params = new URLSearchParams();
    if (tab === "sources") params.set("originKind", "preset");
    if (tab !== "sources" && search.trim()) params.set("search", search.trim());
    try {
      const response = await fetch(`/api/outside/follows?${params.toString()}`);
      if (!response.ok) {
        throw new Error("request failed");
      }
      const payload = await response.json() as FollowsPayload;
      if (requestId !== followsRequestIdRef.current) return;
      setData(payload);
      setError("");
    } catch {
      if (requestId !== followsRequestIdRef.current) return;
      setError("加载信息源目录失败。");
    }
  }, [search, tab]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) void load();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/outside/adapter", { signal: controller.signal });
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload.providers)) throw new Error(payload.error || "账号渠道不可用。");
        setAccountProviders(payload.providers);
      } catch (error) {
        if (!controller.signal.aborted) setProvidersError(error instanceof Error ? error.message : "账号渠道不可用。");
      }
    })();
    return () => controller.abort();
  }, []);

  const loadDaily = useCallback(async (date: string) => {
    const requestId = ++dailyRequestIdRef.current;
    setDailyLoadState("loading");
    setDailyError("");
    try {
      const params = new URLSearchParams();
      if (date) params.set("date", date);
      const response = await fetch(`/api/outside/daily?${params.toString()}`);
      const payload = await response.json() as DailyPayload;
      if (requestId !== dailyRequestIdRef.current) return;
      if (!response.ok) {
        setDailyError(payload?.error ?? "加载日报失败。");
        setDailyReport(null);
        setDailyHistory([]);
        setDailyLoadState("error");
        return;
      }
      setDailyReport(payload.report ?? null);
      setDailyHistory(payload.history ?? []);
      if (payload.report) setDailyDate(payload.report.date);
      setDailyLoadState("loaded");
    } catch {
      if (requestId !== dailyRequestIdRef.current) return;
      setDailyError("加载日报失败。");
      setDailyReport(null);
      setDailyHistory([]);
      setDailyLoadState("error");
    }
  }, []);

  // 空日报 / 空历史也只请求一次：由显式 loadState 驱动，不依赖内容是否为空。
  useEffect(() => {
    if (tab !== "daily" || dailyLoadState !== "idle") return;
    void loadDaily("");
  }, [tab, dailyLoadState, loadDaily]);

  useEffect(() => {
    if (tab !== "daily") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const requestId = ++generationRequestRef.current;
      try {
        const response = await fetch("/api/outside/daily/generate");
        if (!response.ok) throw new Error("状态获取失败。");
        const payload = await response.json() as { generation: DailyGeneration | null };
        if (stopped) return;
        if (requestId !== generationRequestRef.current) { timer = setTimeout(poll, 2000); return; }
        setGenerationError("");
        const generation = payload.generation ?? null;
        setDailyGeneration(generation);
        if (generation?.status === "succeeded" && generation.phase === "report" && completedGenerationRef.current !== generation.id) {
          completedGenerationRef.current = generation.id;
          setDailyDate(generation.date);
          void loadDaily(generation.date);
        }
      } catch {
        if (!stopped) setGenerationError("无法获取生成状态，请检查服务后重试。");
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [tab, loadDaily]);

  const generationActive = generationSubmitting || Boolean(dailyGeneration && ["queued", "running"].includes(dailyGeneration.status));
  const startGeneration = async () => {
    if (generationSubmitting || !generationDate) return;
    setGenerationSubmitting(true);
    generationRequestRef.current += 1;
    setGenerationError("");
    try {
      const response = await fetch("/api/outside/daily/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: generationDate }) });
      const payload = await response.json() as { generation?: DailyGeneration; error?: string };
      if (!response.ok || !payload.generation) throw new Error(payload.error || "启动失败。");
      setDailyGeneration(payload.generation);
      setGenerationDialog(false);
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "启动失败。");
    } finally { setGenerationSubmitting(false); }
  };

  const followed = useMemo(() => (data?.sources ?? []).filter((source) => source.followed), [data]);

  const toggleFollow = async (source: CatalogSource) => {
    setPendingId(source.id);
    setError("");
    try {
      const response = await fetch("/api/outside/follows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: source.id, action: source.followed ? "unfollow" : "follow" }),
      });
      if (!response.ok) {
        setError("操作失败，请重试。");
        return;
      }
      await load();
    } catch {
      setError("网络异常，操作未完成，请重试。");
    } finally {
      setPendingId(null);
    }
  };

  const xueqiuAction = async (action: "search" | "follow", query: string) => {
    setXueqiuBusy(true);
    setError("");
    setAccountWarning("");
    if (action === "search") { setXueqiuCandidates([]); setXueqiuSearched(false); }
    try {
      const provider = accountProviders.find((entry) => entry.id === accountPlatform);
      if (!provider) throw new Error("账号渠道不可用。");
      const selected = xueqiuCandidates.find((candidate) => candidate.uid === query);
      const operation = action === "follow" ? "follow" : provider.capabilities.resolve && (!provider.capabilities.search || /^\d+$/.test(query.trim()) || /^https?:\/\//i.test(query.trim())) ? "resolve" : "search";
      const response = await fetch("/api/outside/adapter", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: operation, providerId: accountPlatform, query, ...(selected ? { account: { accountId: selected.uid, name: selected.name, description: selected.description, siteUrl: selected.siteUrl, avatarUrl: selected.avatarUrl } } : {}) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "操作失败。");
      if (action === "search") { setXueqiuCandidates(payload.candidates.map((candidate: { accountId: string; name: string; siteUrl?: string; avatarUrl?: string | null; description?: string; followed: boolean }) => ({ ...candidate, uid: candidate.accountId }))); setAccountWarning(payload.warning ?? ""); setXueqiuSearched(true); }
      else { setXueqiuCandidates([]); setXueqiuSearched(false); await load(); }
    } catch (error) {
      setError(error instanceof Error ? error.message : "网络异常，请重试。");
    } finally { setXueqiuBusy(false); }
  };

  const presetSources = (data?.sources ?? []).filter((source) => source.originKind === "preset");
  const sourceRows = tab === "follows" ? followed.filter((source) => !followKind || source.originKind === followKind) : presetSources.filter((source) => !presetSearch.trim() || source.name.toLowerCase().includes(presetSearch.trim().toLowerCase()));
  const emptyMessage = tab === "follows"
    ? (data && data.followedSourceIds.length === 0
      ? "尚未关注任何信息源。"
      : "当前筛选下没有关注项。")
    : (data && data.sources.length === 0
      ? "暂无已配置信息源。"
      : "没有匹配的信息源。");
  const meta = PAGE_META[tab];

  return (
    <div
      className="flex min-h-screen flex-col bg-[#f6f7f2] font-sans text-[#29372d] md:flex-row"
      style={{ ...LIGHT_THEME_VARS, colorScheme: "light" }}
      data-light-scope=""
    >
      <aside className="border-b border-[#e5e9df] bg-[#fcfcf8] md:fixed md:inset-y-0 md:left-0 md:w-[208px] md:border-b-0 md:border-r md:px-[19px] md:py-[33px] md:pb-5">
        <div className="mx-auto flex max-w-[560px] items-center gap-2.5 px-4 pt-4 md:mx-0 md:ml-3 md:max-w-none md:px-0 md:pt-0">
          <span className="block text-[#31533b]">
            <OrbitMark />
          </span>
          <span className="text-[21px] font-semibold leading-tight tracking-[3px] text-[#304832]">
            财经版
            <small className="mt-1 block text-[8px] font-semibold tracking-[3.5px] text-[#9aa38f]">FINANCE</small>
          </span>
        </div>
        <div className="px-4 pb-3 pt-3 text-[10px] tracking-[0.7px] text-[#9aa38f] md:px-4 md:pb-9 md:pt-[22px]">
          关注驱动的财经日报
        </div>
        <nav className="flex gap-1.5 px-4 pb-3 md:grid md:gap-[7px] md:px-0 md:pb-0">
          {([
            ["sources", "信息源"],
            ["follows", "我的关注"],
            ["daily", "资讯日报"],
          ] as Array<[OutsideTab, string]>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`flex flex-1 items-center gap-2.5 rounded-lg px-3.5 py-3 text-left text-[13px] transition-colors md:w-full md:flex-none ${
                tab === key
                  ? "bg-[#e9efdf] font-semibold text-[#31533b]"
                  : "text-[#87917e] hover:bg-[#f0f3e9]"
              }`}
            >
              <span className="shrink-0">
                <NavIcon kind={key} />
              </span>
              <span className="flex-1">{label}</span>
              {key === "follows" && data ? (
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  tab === key ? "bg-[#dce6cc] text-[#698456]" : "bg-[#f0f3e9] text-[#95a083]"
                }`}>
                  {data.followedSourceIds.length}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="mt-auto hidden border-t border-[#e5e9df] px-1 pt-3 text-[10px] text-[#9aa38f] md:block">
          <Link className="underline-offset-2 hover:text-[#6f8858] hover:underline" href="/">返回原首页</Link>
          <span className="mx-1.5 text-[#c2c9b7]">/</span>
          <Link className="underline-offset-2 hover:text-[#6f8858] hover:underline" href="/admin">后台</Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col md:ml-[208px]">
        <header className="flex h-16 items-center justify-between border-b border-[#e5e9df] bg-[#fafbf6] px-5 md:h-[76px] md:px-[38px]">
          <div className="flex items-center gap-3 text-[11px] text-[#95a08b]">
            <span>财经版</span>
            <span className="text-[#c2c9b7]">/</span>
            <strong className="font-medium text-[#5f7153]">{meta.crumb}</strong>
          </div>
          <div className="flex items-center gap-3 text-[11px] md:hidden">
            <Link className="text-[#88977b] underline-offset-2 hover:text-[#6f8858] hover:underline" href="/">首页</Link>
            <span className="text-[#c2c9b7]">/</span>
            <Link className="text-[#88977b] underline-offset-2 hover:text-[#6f8858] hover:underline" href="/admin">后台</Link>
          </div>
          <div className="hidden items-center gap-3 text-[11px] md:flex">
            <Link className="inline-flex items-center gap-1.5 text-[#88977b] underline-offset-2 hover:text-[#6f8858] hover:underline" href="/">返回原首页</Link>
            <span className="h-4 w-px bg-[#e5e9df]" />
            <Link className="inline-flex items-center gap-1.5 text-[#88977b] underline-offset-2 hover:text-[#6f8858] hover:underline" href="/admin">后台管理</Link>
          </div>
        </header>

        <main className="min-h-[calc(100vh-118px)] flex-1 px-4 py-7 md:px-7 md:py-9 lg:px-[45px] lg:py-[41px]">
          {error ? (
            <p className="mb-4 rounded-lg border border-[#e8d9c6] bg-[#faf3e6] px-4 py-2.5 text-[12px] text-[#977a43]">{error}</p>
          ) : null}

          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-[8px] font-semibold tracking-[1.8px] text-[#98a688]">{meta.eyebrow}</div>
              <h1 className="mt-2 text-[25px] font-semibold leading-snug tracking-[0.5px] text-[#2c3c2d] md:text-[28px]">
                {meta.title}
                <em className="not-italic text-[#849c67]">。</em>
              </h1>
              <p className="mt-2 max-w-[420px] text-[12px] leading-relaxed text-[#97a188]">{meta.description}</p>
            </div>
          </div>

          {tab !== "daily" ? (
            <>
              {tab === "sources" && sourceStage === "cards" ? (
                <div className="space-y-7">
                  <section>
                    <h2 className="mb-3 text-[14px] font-semibold text-[#31533b]">账号渠道</h2>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {accountProviders.map((provider) => (
                        <button key={provider.id} type="button" aria-label={`${provider.name}账号渠道`} onClick={() => { setAccountPlatform(provider.id); setXueqiuQuery(""); setXueqiuCandidates([]); setXueqiuSearched(false); setAccountWarning(""); setSourceStage("account"); }} className="rounded-[10px] border border-[#e5e9df] bg-white p-5 text-left hover:border-[#b7c9aa] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#718d61]">
                          <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#eef3e7] text-[12px] font-semibold text-[#698456]">{provider.name.slice(0, 2)}</span>
                          <strong className="mt-4 block text-[14px] text-[#29372d]">{provider.name}</strong>
                          <span className="mt-5 block border-t border-[#eff2e9] pt-3 text-right text-[11px] text-[#6a7d5b]">选择账号 →</span>
                        </button>
                      ))}
                    </div>
                    {providersError ? <p role="alert" className="mt-3 text-[12px] text-[#977a43]">{providersError}</p> : null}
                  </section>
                  <section>
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                      <h2 className="text-[14px] font-semibold text-[#31533b]">普通订阅源 <span className="text-[11px] font-normal text-[#95a08b]">{sourceRows.length} 个</span></h2>
                      <input aria-label="搜索普通订阅源" value={presetSearch} onChange={(event) => setPresetSearch(event.target.value)} placeholder="搜索名称" className="w-full rounded-lg border border-[#e5e9df] bg-[#fcfdf9] px-3 py-2 text-[12px] text-[#5f7650] sm:w-44" />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {sourceRows.map((source) => (
                        <article key={source.id} className="flex min-w-0 flex-col rounded-[10px] border border-[#e5e9df] bg-white p-5">
                          <div className="flex items-start justify-between gap-3">
                            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#eef3e7] text-[12px] font-semibold text-[#698456]">RSS</span>
                            <span className={`rounded px-2 py-1 text-[10px] ${source.enabled ? "bg-[#eef4e3] text-[#6b8455]" : "bg-[#f5efdf] text-[#977a43]"}`}>{source.enabled ? "可用" : "停用（不可用）"}</span>
                          </div>
                          <a href={source.siteUrl} target="_blank" rel="noreferrer" className="mt-4 break-words text-[14px] font-semibold text-[#29372d] hover:underline">{source.name}</a>
                          <span className="mt-1 text-[11px] text-[#95a08b]">{source.followed ? "已关注" : "未关注"}</span>
                          <div className="mt-5 flex justify-end border-t border-[#eff2e9] pt-3">
                            <button type="button" aria-label={`${source.followed ? "取消关注" : "关注"} ${source.name}`} disabled={pendingId === source.id} onClick={() => void toggleFollow(source)} className="rounded-md border border-[#dee5d5] px-3 py-1.5 text-[11px] text-[#6a7d5b] hover:bg-[#edf2e5] disabled:opacity-45">{source.followed ? "取消关注" : "关注"}</button>
                          </div>
                        </article>
                      ))}
                    </div>
                    {data && sourceRows.length === 0 ? <p className="text-[12px] text-[#95a08b]">{emptyMessage}</p> : null}
                  </section>
                </div>
              ) : null}
              {tab === "sources" && sourceStage !== "cards" ? (
                <button type="button" disabled={xueqiuBusy} onClick={() => setSourceStage("cards")} className="mb-4 text-[12px] text-[#6a7d5b] hover:underline">← 返回信息源</button>
              ) : null}
              {tab === "sources" && sourceStage === "account" ? (
                <div className="mb-5 rounded-lg border border-[#e5e9df] bg-white p-4">
                  <h2 className="mb-3 text-[14px] font-semibold text-[#31533b]">搜索账号</h2>
                  <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void xueqiuAction("search", xueqiuQuery); }}>
                    <input aria-label="账号名称、ID 或主页链接" disabled={xueqiuBusy} value={xueqiuQuery} onChange={(event) => { setXueqiuQuery(event.target.value); setXueqiuCandidates([]); setXueqiuSearched(false); }} placeholder={accountProviders.find((provider) => provider.id === accountPlatform)?.capabilities.search ? "账号名称、ID 或主页链接" : "账号 ID 或主页链接"} className="w-64 rounded border border-[#e5e9df] px-3 py-2 text-[12px]" />
                    <button disabled={xueqiuBusy} className="rounded bg-[#31533b] px-3 py-2 text-[12px] text-white disabled:opacity-45">查找账号</button>
                  </form>
                  {accountWarning ? <p className="mt-3 text-[12px] text-[#977a43]">{accountWarning}</p> : xueqiuSearched && xueqiuCandidates.length === 0 ? <p className="mt-3 text-[12px]">没有找到匹配账号。</p> : null}
                  {xueqiuCandidates.map((candidate) => (
                    <div key={candidate.uid} className="mt-3 flex items-start gap-3 border-t border-[#eff2e9] pt-3 text-[12px]">
                      {candidate.avatarUrl ? <img src={candidate.avatarUrl} alt="" referrerPolicy="no-referrer" className="h-9 w-9 shrink-0 rounded-full object-cover" /> : null}
                      <div className="min-w-0 flex-1">
                        {candidate.siteUrl ? <a href={candidate.siteUrl} target="_blank" rel="noreferrer" className="break-words underline">{candidate.name}</a> : <span className="break-words">{candidate.name}</span>}
                        {accountProviders.find((provider) => provider.id === accountPlatform)?.capabilities.inputKinds.includes("id") ? <span className="ml-2 inline-block text-[#87917e]">ID {candidate.uid}</span> : null}
                        {candidate.description ? <p className="mt-1 break-words whitespace-pre-line text-[#748563]">{candidate.description}</p> : null}
                      </div>
                      <button type="button" disabled={xueqiuBusy || candidate.followed} onClick={() => void xueqiuAction("follow", candidate.uid)} className="shrink-0 rounded border border-[#31533b] px-3 py-1 text-[#31533b] disabled:opacity-45">{candidate.followed ? "已关注" : "关注"}</button>
                    </div>
                  ))}
                </div>
              ) : null}
              {tab === "follows" ? <>
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 rounded-lg border border-[#e5e9df] bg-[#fcfdf9] px-3 py-2 text-[12px] text-[#5f7650] focus-within:outline focus-within:outline-[3px] focus-within:outline-[#a5bb8b]">
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="搜索名称"
                      className="w-44 bg-transparent text-[12px] text-[#5f7650] placeholder:text-[#92a17f] focus:outline-none"
                    />
                  </label>
                  {tab === "follows" ? (
                    <select
                      value={followKind}
                      onChange={(event) => setFollowKind(event.target.value as "" | "account" | "preset")}
                      aria-label="按订阅类型筛选"
                      className="rounded-md border border-[#e5e9df] bg-[#fcfdf9] px-2.5 py-2 text-[12px] text-[#8e9e7c]"
                    >
                      <option value="">全部类型</option>
                      <option value="account">账号订阅</option>
                      <option value="preset">预置 RSS</option>
                    </select>
                  ) : null}
                </div>
                <div className="text-[11px] text-[#95a08b]">
                  {tab === "follows" ? (
                    <>
                      关注 <strong className="font-medium text-[#698456]">{data?.followedSourceIds.length ?? 0}</strong> 项
                    </>
                  ) : (
                    <>
                      共 <strong className="font-medium text-[#698456]">{sourceRows.length}</strong> 个信息源
                    </>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto rounded-[10px] border border-[#e5e9df] bg-white">
                <table className="w-full min-w-[560px] text-left">
                  <thead>
                    <tr>
                      {["名称", "状态", ""].map((header, index) => (
                        <th
                          key={`${header}-${index}`}
                          className={`whitespace-nowrap border-b border-[#e5e9df] bg-[#fcfdf8] px-3 py-3 text-[10px] font-normal text-[#a1ac94] ${index === 0 ? "w-[30%]" : ""}`}
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sourceRows.map((source) => (
                      <tr key={source.id} className="border-b border-[#eff2e9] last:border-b-0 hover:bg-[#fafcf5]">
                        <td className="px-3 py-4 align-middle">
                          <div className="flex items-center gap-2.5">
                            <span
                              aria-hidden
                              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[#d6dfc9] bg-[#eff4e7] text-[12px] font-semibold text-[#5f7951]"
                            >
                              {source.name.slice(0, 1)}
                            </span>
                            <span className="min-w-0">
                              {source.siteUrl ? <a
                                href={source.siteUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="block truncate text-[12px] font-semibold text-[#29372d] hover:text-[#4c6a41] hover:underline"
                              >
                                {source.name}
                              </a> : <span className="block truncate text-[12px] font-semibold text-[#29372d]">{source.name}</span>}
                              {tab === "follows" ? (
                                <small className="block text-[10px] text-[#748563]">{source.originKind === "account" ? (source.channel === "其他" ? "账号订阅" : `账号订阅 · ${source.channel}`) : "预置 RSS"}</small>
                              ) : null}
                              {source.groupName ? (
                                <small className="block text-[10px] text-[#98a58b]">{source.groupName}</small>
                              ) : null}
                            </span>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 align-middle">
                          {source.enabled && source.healthStatus === "failed" ? (
                            <span className="rounded bg-[#f5efdf] px-1.5 py-1 text-[10px] text-[#977a43]">{source.healthMessage || "采集异常"}</span>
                          ) : source.enabled && source.transport === "adapter" && source.healthStatus === "unknown" ? (
                            <span className="rounded bg-[#f5efdf] px-1.5 py-1 text-[10px] text-[#977a43]">待采集</span>
                          ) : source.enabled ? (
                            <span className="rounded bg-[#eef4e3] px-1.5 py-1 text-[10px] text-[#6b8455]">可用</span>
                          ) : (
                            <span className="rounded bg-[#f5efdf] px-1.5 py-1 text-[10px] text-[#977a43]">停用（不可用）</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-right align-middle">
                          <button
                            type="button"
                            disabled={pendingId === source.id}
                            onClick={() => void toggleFollow(source)}
                            className={`inline-block rounded-md px-3 py-1.5 text-[11px] transition-colors disabled:opacity-45 ${
                              source.followed
                                ? "border border-[#dee5d5] bg-[#fcfdf8] text-[#6a7d5b] hover:bg-[#edf2e5]"
                                : "border border-[#31533b] bg-[#31533b] text-[#f8fbee] hover:bg-[#24462f]"
                            }`}
                          >
                            {source.followed ? "取消关注" : "关注"}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {sourceRows.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="px-4 py-10 text-center">
                          <div className="mx-auto max-w-sm rounded-lg border border-dashed border-[#dbe5cc] bg-[#fafcf5] px-5 py-8 text-[#9baa8b]">
                            <p className="text-[14px] font-medium text-[#728d5e]">{emptyMessage}</p>
                            {tab === "follows" ? (
                              <button
                                type="button"
                                onClick={() => { setSourceStage("cards"); setTab("sources"); }}
                                className="mt-4 inline-block rounded-md border border-[#dee5d5] bg-[#fcfdf8] px-3 py-1.5 text-[11px] text-[#6a7d5b] hover:bg-[#edf2e5]"
                              >
                                去信息源目录选择关注
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[10px] leading-relaxed text-[#a7b29a]">
                关注不改变采集与启用状态；停用源仍可关注，日报生成时标记为不可用。
              </p>
              </> : null}
            </>
          ) : (
            <div className="mx-auto w-full max-w-3xl lg:max-w-5xl 2xl:max-w-none">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <input
                  type="date"
                  value={dailyDate}
                  onChange={(event) => setDailyDate(event.target.value)}
                  className="rounded-md border border-[#e5e9df] bg-[#fcfdf9] px-3 py-2 text-[12px] text-[#5f7650]"
                />
                <button
                  type="button"
                  onClick={() => void loadDaily(dailyDate)}
                  className="rounded-md border border-[#dee5d5] bg-[#fcfdf8] px-3.5 py-2 text-[12px] text-[#6a7d5b] hover:bg-[#edf2e5]"
                >
                  查看
                </button>
              </div>

              <div className="mb-4 flex items-center gap-3" aria-live="polite">
                {generationActive ? (
                  <span className="flex items-center gap-2 text-xs text-[#5f7650]" role="status">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#dbe5cc] border-t-[#5f7650]" aria-hidden="true" />
                    {dailyGeneration?.phase === "report" ? "正在生成日报" : "正在抓取资讯"}{dailyGeneration?.progressLabel ? ` · ${dailyGeneration.progressLabel}` : "…"}
                  </span>
                ) : (
                  <button type="button" onClick={() => { setGenerationDate(dailyDate || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())); setGenerationError(""); setGenerationDialog(true); }} className="rounded-md bg-[#31533b] px-3.5 py-2 text-xs text-white">生成日报</button>
                )}
                {dailyGeneration?.fetchWarning ? <span className="text-xs text-[#977a43]">抓取部分失败，已继续生成日报。 {dailyGeneration.fetchWarning}</span> : null}
                {!generationActive && dailyGeneration && ["failed", "partial", "cancelled"].includes(dailyGeneration.status) ? <span className="text-xs text-[#977a43]">{dailyGeneration.phase === "fetch" ? "抓取未完成，未生成日报。" : "日报生成未完成。"}{dailyGeneration.error ? ` ${dailyGeneration.error}` : ""}</span> : null}
                {generationError && !generationDialog ? <span className="text-xs text-[#977a43]">{generationError}</span> : null}
              </div>
              {generationDialog ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-labelledby="generate-daily-title">
                  <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg">
                    <h2 id="generate-daily-title" className="mb-4 text-sm font-medium">生成日报</h2>
                    <label className="block text-xs text-[#5f7650]">日期<input type="date" value={generationDate} onChange={(event) => setGenerationDate(event.target.value)} className="mt-2 block w-full rounded-md border border-[#e5e9df] px-3 py-2" /></label>
                    {generationError ? <p role="alert" className="mt-3 text-xs text-[#977a43]">{generationError}</p> : null}
                    <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setGenerationDialog(false)} disabled={generationSubmitting} className="px-3 py-2 text-xs">取消</button><button type="button" onClick={() => void startGeneration()} disabled={generationSubmitting || !generationDate} className="rounded-md bg-[#31533b] px-3 py-2 text-xs text-white disabled:opacity-50">开始生成</button></div>
                  </div>
                </div>
              ) : null}

              {dailyHistory.length > 1 ? (
                <div className="mb-4 flex flex-wrap gap-2">
                  {dailyHistory.map((item) => (
                    <button
                      key={item.date}
                      type="button"
                      onClick={() => {
                        setDailyDate(item.date);
                        void loadDaily(item.date);
                      }}
                      className={`rounded-md border px-2.5 py-1 text-[11px] ${
                        item.date === dailyReport?.date
                          ? "border-[#31533b] bg-[#e9efdf] font-medium text-[#31533b]"
                          : "border-[#e5e9df] bg-white text-[#87917e] hover:bg-[#f0f3e9]"
                      }`}
                    >
                      {item.date}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="rounded-[10px] border border-[#e5e9df] bg-white">
                {dailyLoadState === "loading" ? (
                  <p className="px-5 py-8 text-center text-[12px] text-[#98a58b]">加载中…</p>
                ) : dailyLoadState === "error" ? (
                  <div className="px-5 py-8 text-center">
                    <p className="text-[13px] text-[#977a43]">{dailyError}</p>
                    <button
                      type="button"
                      onClick={() => void loadDaily(dailyDate)}
                      className="mt-4 inline-block rounded-md border border-[#dee5d5] bg-[#fcfdf8] px-3 py-1.5 text-[11px] text-[#6a7d5b] hover:bg-[#edf2e5]"
                    >
                      重试
                    </button>
                  </div>
                ) : dailyLoadState === "loaded" && !dailyReport ? (
                  <div className="px-5 py-10 text-center">
                    <div className="mx-auto max-w-sm rounded-lg border border-dashed border-[#dbe5cc] bg-[#fafcf5] px-5 py-8 text-[#9baa8b]">
                      <p className="text-[14px] font-medium text-[#728d5e]">该日期没有日报</p>
                      <p className="mt-2 text-[11px] leading-relaxed">可尝试其他日期，或生成日报。</p>
                    </div>
                  </div>
                ) : dailyReport ? (
                  <div className="px-4 py-4 md:px-6 md:py-6">
                    <DailyReportDetail report={dailyReport} date={dailyDate || dailyReport.date} isAdmin layout="embedded" hideRegenerate={generationActive} />
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[#e5e9df] px-5 py-4 text-[10px] text-[#a7b29a] md:px-[38px]">
          <span>财经版 · 把注意力，还给自己。</span>
          <span>日报由关注的信息源生成 · 历史日报保留</span>
        </footer>
      </div>
    </div>
  );
}
