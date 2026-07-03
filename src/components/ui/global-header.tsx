"use client";

import { startTransition, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { IconGithub, IconLock, IconLogout, IconMonitor, IconMoon, IconRss, IconSettings, IconSun } from "@/components/ui/icons";
import { cx } from "@/lib/ui/cx";
import { useClientAdminSession } from "@/components/ui/use-client-admin-session";
import type { AdminHeaderLink } from "@/lib/settings/types";

type GlobalHeaderProps = {
  activeNav: "home" | "events" | "daily" | "admin" | null;
  isAdmin: boolean;
  resolveAdminClient?: boolean;
  showShadow?: boolean;
  rssHref?: string;
  customLinks?: AdminHeaderLink[];
  onHomeClick?: () => void;
};

const navItems = [
  { href: "/", key: "home", label: "主页" },
  { href: "/events", key: "events", label: "速览" },
  { href: "/daily", key: "daily", label: "日报" },
] as const;

type ThemePreference = "light" | "dark" | "system";

function getThemeStorage() {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function GlobalHeader({
  activeNav,
  isAdmin: initialIsAdmin,
  resolveAdminClient = false,
  showShadow = true,
  rssHref,
  customLinks = [],
  onHomeClick,
}: GlobalHeaderProps) {
  const router = useRouter();
  const isAdmin = useClientAdminSession(initialIsAdmin, resolveAdminClient);
  const [isPending, setIsPending] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);
  const headerIconButtonClass =
    "inline-flex items-center justify-center w-8 h-8 rounded-sm text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-muted)] transition";

  const themeOptions = useMemo(
    () => [
      { value: "light" as const, label: "明亮", icon: IconSun },
      { value: "dark" as const, label: "暗黑", icon: IconMoon },
      { value: "system" as const, label: "系统", icon: IconMonitor },
    ],
    [],
  );

  const activeTheme = themeOptions.find((option) => option.value === theme) ?? themeOptions[2];

  useEffect(() => {
    const stored = getThemeStorage()?.getItem("theme");
    const initial = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";

    setTheme(initial);
    if (initial === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", initial);
    }
  }, []);

  useEffect(() => {
    if (!themeMenuOpen) return;

    const handleClick = (event: MouseEvent) => {
      if (!themeMenuRef.current) return;
      if (themeMenuRef.current.contains(event.target as Node)) return;
      setThemeMenuOpen(false);
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [themeMenuOpen]);

  const applyTheme = (nextTheme: ThemePreference) => {
    setTheme(nextTheme);
    getThemeStorage()?.setItem("theme", nextTheme);
    if (nextTheme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", nextTheme);
    }
  };

  const goToLogin = () => {
    startTransition(() => {
      const currentPath = window.location.pathname;
      const loginUrl = currentPath !== "/login" ? `/login?redirect=${encodeURIComponent(currentPath)}` : "/login";
      router.push(loginUrl);
    });
  };

  const logout = () => {
    setIsPending(true);

    startTransition(async () => {
      try {
        await fetch("/api/admin/logout", {
          method: "POST",
        });
      } finally {
        router.push("/login");
        router.refresh();
        setIsPending(false);
      }
    });
  };

  const openRss = () => {
    if (typeof window === "undefined") return;
    if (rssHref) {
      window.open(rssHref, "_blank", "noopener,noreferrer");
      return;
    }
    if (activeNav === "daily") {
      window.open("/api/daily/rss", "_blank", "noopener,noreferrer");
      return;
    }
    window.open("/api/feed/rss", "_blank", "noopener,noreferrer");
  };

  const handleHomeClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (activeNav !== "home" || !onHomeClick) {
      return;
    }

    event.preventDefault();
    onHomeClick();
  };

  return (
    <header
      className={cx(
        "border-b border-[color:var(--line)] bg-[var(--surface)]",
        showShadow ? "shadow-[var(--shadow-sm)]" : null,
        activeNav === "home" ? null : "sticky top-0 z-40",
      )}
    >
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-8">
          <Link
            className="inline-flex shrink-0 items-center gap-2 text-[var(--foreground)]"
            href="/"
            onClick={handleHomeClick}
          >
            <svg
              className="logo-mark h-7 w-7"
              width="28"
              height="28"
              viewBox="0 0 128 128"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-label="Infinitum"
            >
              <circle cx="64" cy="64" r="64" fill="#111111" />
              <path
                d="M64 28L100 100H28L64 28Z"
                fill="white"
              />
            </svg>
            <span className="text-2xl font-bold">Infinitum</span>
          </Link>

          <nav aria-label="主导航" className="hidden min-w-0 flex-1 items-center gap-2 text-base font-medium lg:flex">
            {navItems.map((item) => {
              const isActive = item.key === activeNav;

              return (
                <Link
                  key={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cx(
                    "px-3 py-1 rounded-sm transition",
                    isActive
                      ? "bg-[var(--bg-muted)] text-[var(--text-1)]"
                      : "text-[var(--text-2)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]",
                  )}
                  href={item.href}
                  onClick={item.key === "home" ? handleHomeClick : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
            {customLinks.map((link) => (
              <a
                key={link.id}
                className="px-3 py-1 rounded-sm text-[var(--text-2)] transition hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]"
                href={link.url}
                target={link.openInNewTab ? "_blank" : undefined}
                rel={link.openInNewTab ? link.rel : undefined}
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative" ref={themeMenuRef}>
            <button
              type="button"
              onClick={() => setThemeMenuOpen((current) => !current)}
              className={headerIconButtonClass}
              aria-label="切换主题"
              title="切换主题"
            >
              <activeTheme.icon className="h-4 w-4" />
            </button>
            {themeMenuOpen ? (
              <div className="absolute right-0 z-50 mt-2 w-28 rounded-md border border-[color:var(--line)] bg-[var(--surface)] p-1 shadow-[var(--shadow-lg)]">
                {themeOptions.map((option) => {
                  const isActive = theme === option.value;
                  const Icon = option.icon;

                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        applyTheme(option.value);
                        setThemeMenuOpen(false);
                      }}
                      className={cx(
                        "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-xs transition",
                        isActive
                          ? "bg-[var(--bg-muted)] text-[var(--text-1)]"
                          : "text-[var(--text-2)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{option.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={openRss}
            className={headerIconButtonClass}
            aria-label="RSS 订阅"
            title="RSS 订阅"
          >
            <IconRss className="h-4 w-4" />
          </button>
          <a
            href="https://github.com/shawnxie94/infinitum"
            target="_blank"
            rel="noreferrer"
            className={headerIconButtonClass}
            aria-label="GitHub"
            title="GitHub"
          >
            <IconGithub className="h-4 w-4" />
          </a>
          {isAdmin && (
            <Link
              href="/admin"
              prefetch={false}
              className={headerIconButtonClass}
              aria-label="管理"
              title="管理"
            >
              <IconSettings className="h-4 w-4" />
            </Link>
          )}
          {isAdmin ? (
            <button
              aria-label="登出"
              className="inline-flex items-center justify-center w-8 h-8 rounded-sm text-[var(--text-3)] hover:text-[var(--danger-ink)] hover:bg-[var(--danger-surface)] transition disabled:cursor-not-allowed disabled:opacity-55"
              disabled={isPending}
              onClick={logout}
              type="button"
            >
              <IconLogout className="h-4 w-4" />
            </button>
          ) : (
            <button
              aria-label="登录"
              className="inline-flex items-center justify-center w-8 h-8 rounded-sm text-[var(--text-3)] hover:text-[var(--accent)] hover:bg-[var(--accent-soft)] transition"
              onClick={goToLogin}
              type="button"
            >
              <IconLock className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
