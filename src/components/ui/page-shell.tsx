import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { AppFooter } from "@/components/ui/app-footer";
import { GlobalHeader } from "@/components/ui/global-header";
import { PageViewTracker } from "@/components/ui/page-view-tracker";
import { cx } from "@/lib/ui/cx";
import type { AdminHeaderLink } from "@/lib/settings/types";

type PageShellNav = "home" | "events" | "daily" | "admin" | null;

type PageShellHeader = {
  activeNav: PageShellNav;
  isAdmin: boolean;
  resolveAdminClient?: boolean;
  showShadow?: boolean;
  rssHref?: string;
  customLinks?: AdminHeaderLink[];
  onHomeClick?: () => void;
};

type PageShellProps = ComponentPropsWithoutRef<"main"> & {
  children: ReactNode;
  contentClassName?: string;
  contentPaddingClassName?: string;
  contentWidth?: "default" | "workspace";
  header?: PageShellHeader | null;
  chromeLabel?: string | null;
  sidebar?: ReactNode;
  sidebarContainerClassName?: string;
  sidebarVisibility?: "always" | "lg" | "xl";
  footerPath?: string;
};

export function PageShell({
  children,
  header,
  chromeLabel = null,
  className,
  contentClassName,
  contentPaddingClassName = "px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10",
  contentWidth = "default",
  sidebar,
  sidebarContainerClassName,
  sidebarVisibility = "always",
  footerPath,
  ...props
}: PageShellProps) {
  return (
    <main
      className={cx(
        "flex min-h-screen flex-col bg-[var(--background)] text-[var(--foreground)]",
        className,
      )}
      {...props}
    >
      {header ? (
        <GlobalHeader
          activeNav={header.activeNav}
          isAdmin={header.isAdmin}
          resolveAdminClient={header.resolveAdminClient}
          showShadow={header.showShadow}
          rssHref={header.rssHref}
          customLinks={header.customLinks}
          onHomeClick={header.onHomeClick}
        />
      ) : null}

      {!header && chromeLabel ? (
        <div className="border-b border-[color:var(--line)] bg-[color-mix(in_srgb,var(--surface)_80%,transparent)] backdrop-blur">
          <div className="mx-auto flex h-14 w-full max-w-6xl items-center px-4 sm:px-6 lg:px-8">
            <div className="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-[var(--muted)]">
              {chromeLabel}
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-1 flex-col">
        <div
          className={cx(
            "mx-auto flex w-full flex-1 flex-col gap-6",
            contentPaddingClassName,
            contentWidth === "workspace" ? "max-w-[92rem]" : "max-w-7xl",
            contentClassName,
          )}
        >
          {sidebar ? (
            <div
              className={cx(
                "flex flex-col gap-6",
                sidebarVisibility === "lg" ? "lg:flex-row" : null,
                sidebarVisibility === "xl" ? "xl:grid xl:grid-cols-[240px_minmax(0,1fr)] xl:items-start xl:gap-4" : null,
              )}
            >
              <div
                className={cx(
                  "min-w-0",
                  sidebarVisibility === "always" ? "w-full" : null,
                  sidebarVisibility === "lg" ? "hidden lg:block lg:w-56" : null,
                  sidebarVisibility === "xl" ? "hidden xl:block" : null,
                  sidebarContainerClassName,
                )}
              >
                {sidebar}
              </div>
              <div className="min-w-0 flex-1">{children}</div>
            </div>
          ) : (
            children
          )}
        </div>
        <AppFooter>
          {footerPath ? <PageViewTracker path={footerPath} /> : null}
        </AppFooter>
      </div>
    </main>
  );
}
