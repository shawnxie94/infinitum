"use client";

import {
  startTransition,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  IconClose,
  IconGithub,
  IconLock,
  IconLogout,
  IconMenu,
  IconMonitor,
  IconMoon,
  IconRss,
  IconSettings,
  IconSun,
  IconType,
} from "@/components/ui/icons";
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
type FontSizePreference = "sm" | "md" | "lg" | "xl";

const FONT_SIZE_STORAGE_KEY = "font-size";
const FONT_SIZE_OPTIONS = [
  { value: "sm" as const, label: "小" },
  { value: "md" as const, label: "中" },
  { value: "lg" as const, label: "大" },
  { value: "xl" as const, label: "超大" },
] as const;

function isFontSizePreference(value: string | null | undefined): value is FontSizePreference {
  return value === "sm" || value === "md" || value === "lg" || value === "xl";
}

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
  const [fontSize, setFontSize] = useState<FontSizePreference>("sm");
  const [fontSizeMenuOpen, setFontSizeMenuOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);
  const fontSizeMenuRef = useRef<HTMLDivElement | null>(null);
  const mobileNavPanelId = useId();
  const headerIconButtonClass =
    "inline-flex items-center justify-center h-10 w-10 rounded-sm text-[var(--text-3)] transition hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)] sm:h-8 sm:w-8";

  const themeOptions = useMemo(
    () => [
      { value: "light" as const, label: "明亮", icon: IconSun },
      { value: "dark" as const, label: "暗黑", icon: IconMoon },
      { value: "system" as const, label: "系统", icon: IconMonitor },
    ],
    [],
  );

  const fontSizeOptions = useMemo(() => [...FONT_SIZE_OPTIONS], []);

  const activeTheme = themeOptions.find((option) => option.value === theme) ?? themeOptions[2];
  const activeFontSize = fontSizeOptions.find((option) => option.value === fontSize) ?? fontSizeOptions[0];
  const activeFontSizeTitle = `字体大小：${activeFontSize.label}`;

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
    const stored = getThemeStorage()?.getItem(FONT_SIZE_STORAGE_KEY);
    const initial = isFontSizePreference(stored) ? stored : "sm";
    setFontSize(initial);
    document.documentElement.setAttribute("data-font-size", initial);
  }, []);

  useEffect(() => {
    if (!themeMenuOpen && !fontSizeMenuOpen) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (themeMenuRef.current?.contains(target) || fontSizeMenuRef.current?.contains(target)) {
        return;
      }
      setThemeMenuOpen(false);
      setFontSizeMenuOpen(false);
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [themeMenuOpen, fontSizeMenuOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const media = window.matchMedia("(min-width: 1024px)");
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setMobileNavOpen(false);
      }
    };

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }

    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, []);


  const applyTheme = (nextTheme: ThemePreference) => {
    setTheme(nextTheme);
    getThemeStorage()?.setItem("theme", nextTheme);
    if (nextTheme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", nextTheme);
    }
  };

  const applyFontSize = (nextFontSize: FontSizePreference) => {
    setFontSize(nextFontSize);
    getThemeStorage()?.setItem(FONT_SIZE_STORAGE_KEY, nextFontSize);
    document.documentElement.setAttribute("data-font-size", nextFontSize);
  };

  const goToLogin = () => {
    setMobileNavOpen(false);
    startTransition(() => {
      const currentPath = window.location.pathname;
      const loginUrl = currentPath !== "/login" ? `/login?redirect=${encodeURIComponent(currentPath)}` : "/login";
      router.push(loginUrl);
    });
  };

  const logout = () => {
    setIsPending(true);
    setMobileNavOpen(false);

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
    setMobileNavOpen(false);
    onHomeClick();
  };

  const closeMobileNav = () => {
    setMobileNavOpen(false);
  };

  const navLinkClassName = (isActive: boolean) =>
    cx(
      "rounded-sm px-3 py-1 transition",
      isActive
        ? "bg-[var(--bg-muted)] text-[var(--text-1)]"
        : "text-[var(--text-2)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]",
    );

  const mobileNavLinkClassName = (isActive: boolean) =>
    cx(
      "flex min-h-11 items-center rounded-sm px-3 py-2 text-base font-medium transition",
      isActive
        ? "bg-[var(--bg-muted)] text-[var(--text-1)]"
        : "text-[var(--text-2)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]",
    );

  return (
    <header
      className={cx(
        "border-b border-[color:var(--line)] bg-[var(--surface)]",
        showShadow ? "shadow-[var(--shadow-sm)]" : null,
        activeNav === "home" ? null : "sticky top-0 z-40",
      )}
    >
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-6 sm:py-4 lg:px-8">
        <div className="flex min-w-0 items-center gap-3 sm:gap-8">
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
              <path d="M64 28L100 100H28L64 28Z" fill="white" />
            </svg>
            <span className="text-xl font-bold sm:text-2xl">Infinitum</span>
          </Link>

          <nav aria-label="主导航" className="hidden min-w-0 flex-1 items-center gap-2 text-base font-medium lg:flex">
            {navItems.map((item) => {
              const isActive = item.key === activeNav;

              return (
                <Link
                  key={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={navLinkClassName(isActive)}
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
                className="rounded-sm px-3 py-1 text-[var(--text-2)] transition hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]"
                href={link.url}
                target={link.openInNewTab ? "_blank" : undefined}
                rel={link.openInNewTab ? link.rel : undefined}
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <div className="relative" ref={themeMenuRef}>
            <button
              type="button"
              onClick={() => {
                setThemeMenuOpen((current) => !current);
                setFontSizeMenuOpen(false);
              }}
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
          <div className="relative" ref={fontSizeMenuRef}>
            <button
              type="button"
              onClick={() => {
                setFontSizeMenuOpen((current) => !current);
                setThemeMenuOpen(false);
              }}
              className={headerIconButtonClass}
              aria-label="调整字体大小"
              title={activeFontSizeTitle}
            >
              <IconType className="h-4 w-4" />
            </button>
            {fontSizeMenuOpen ? (
              <div className="absolute right-0 z-50 mt-2 w-28 rounded-md border border-[color:var(--line)] bg-[var(--surface)] p-1 shadow-[var(--shadow-lg)]">
                {fontSizeOptions.map((option) => {
                  const isActive = fontSize === option.value;

                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        applyFontSize(option.value);
                        setFontSizeMenuOpen(false);
                      }}
                      className={cx(
                        "flex w-full items-center justify-between rounded-sm px-2 py-1 text-xs transition",
                        isActive
                          ? "bg-[var(--bg-muted)] text-[var(--text-1)]"
                          : "text-[var(--text-2)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]",
                      )}
                    >
                      <span>{option.label}</span>
                      {isActive ? <span aria-hidden="true" className="text-[10px] text-[var(--text-3)]">当前</span> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={openRss}
            className={cx(headerIconButtonClass, "hidden sm:inline-flex")}
            aria-label="RSS 订阅"
            title="RSS 订阅"
          >
            <IconRss className="h-4 w-4" />
          </button>
          <a
            href="https://github.com/shawnxie94/infinitum"
            target="_blank"
            rel="noreferrer"
            className={cx(headerIconButtonClass, "hidden sm:inline-flex")}
            aria-label="GitHub"
            title="GitHub"
          >
            <IconGithub className="h-4 w-4" />
          </a>
          {isAdmin ? (
            <Link
              href="/admin"
              prefetch={false}
              className={cx(headerIconButtonClass, "hidden sm:inline-flex")}
              aria-label="管理"
              title="管理"
              onClick={closeMobileNav}
            >
              <IconSettings className="h-4 w-4" />
            </Link>
          ) : null}
          {isAdmin ? (
            <button
              type="button"
              onClick={logout}
              disabled={isPending}
              aria-label="登出"
              title="登出"
              className={cx(
                headerIconButtonClass,
                "hidden text-[var(--text-3)] hover:bg-[var(--danger-surface)] hover:text-[var(--danger-ink)] disabled:cursor-not-allowed disabled:opacity-55 sm:inline-flex",
              )}
            >
              <IconLogout className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="登录"
              title="登录"
              className={cx(
                headerIconButtonClass,
                "hidden hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] sm:inline-flex",
              )}
              onClick={goToLogin}
            >
              <IconLock className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            className={cx(headerIconButtonClass, "lg:hidden")}
            aria-label={mobileNavOpen ? "关闭导航菜单" : "打开导航菜单"}
            aria-expanded={mobileNavOpen}
            aria-controls={mobileNavPanelId}
            title={mobileNavOpen ? "关闭导航菜单" : "打开导航菜单"}
            onClick={() => setMobileNavOpen((current) => !current)}
          >
            {mobileNavOpen ? <IconClose className="h-4 w-4" /> : <IconMenu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {mobileNavOpen ? (
        <div className="border-t border-[color:var(--line)] bg-[var(--surface)] lg:hidden">
          <div
            className="fixed inset-0 z-40 bg-black/35"
            aria-hidden="true"
            onClick={closeMobileNav}
          />
          <div
            id={mobileNavPanelId}
            className="relative z-50 mx-auto w-full max-w-7xl px-4 py-3 sm:px-6"
          >
            <nav aria-label="移动主导航" className="space-y-1">
              {navItems.map((item) => {
                const isActive = item.key === activeNav;

                return (
                  <Link
                    key={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={mobileNavLinkClassName(isActive)}
                    href={item.href}
                    onClick={item.key === "home" ? handleHomeClick : closeMobileNav}
                  >
                    {item.label}
                  </Link>
                );
              })}
              {customLinks.map((link) => (
                <a
                  key={link.id}
                  className={mobileNavLinkClassName(false)}
                  href={link.url}
                  target={link.openInNewTab ? "_blank" : undefined}
                  rel={link.openInNewTab ? link.rel : undefined}
                  onClick={closeMobileNav}
                >
                  {link.label}
                </a>
              ))}
            </nav>

            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[color:var(--line)] pt-3 sm:hidden">
              <button
                type="button"
                onClick={() => {
                  openRss();
                  closeMobileNav();
                }}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-sm border border-[color:var(--line)] px-3 text-sm text-[var(--text-2)] transition hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]"
              >
                <IconRss className="h-4 w-4" />
                RSS
              </button>
              <a
                href="https://github.com/shawnxie94/infinitum"
                target="_blank"
                rel="noreferrer"
                onClick={closeMobileNav}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-sm border border-[color:var(--line)] px-3 text-sm text-[var(--text-2)] transition hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]"
              >
                <IconGithub className="h-4 w-4" />
                GitHub
              </a>
              {isAdmin ? (
                <>
                  <Link
                    href="/admin"
                    prefetch={false}
                    onClick={closeMobileNav}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-sm border border-[color:var(--line)] px-3 text-sm text-[var(--text-2)] transition hover:bg-[var(--bg-muted)] hover:text-[var(--text-1)]"
                  >
                    <IconSettings className="h-4 w-4" />
                    管理
                  </Link>
                  <button
                    type="button"
                    onClick={logout}
                    disabled={isPending}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-sm border border-[color:var(--line)] px-3 text-sm text-[var(--danger-ink)] transition hover:bg-[var(--danger-surface)] disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <IconLogout className="h-4 w-4" />
                    登出
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={goToLogin}
                  className="col-span-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-sm border border-[color:var(--line)] px-3 text-sm text-[var(--accent)] transition hover:bg-[var(--accent-soft)]"
                >
                  <IconLock className="h-4 w-4" />
                  登录
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
