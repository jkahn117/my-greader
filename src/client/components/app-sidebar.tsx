/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { OverviewResponse } from "../../shared/dashboard-api";
import { apiGet } from "../lib/api";
import { cn } from "../lib/utils";

export const NAV_ITEMS = [
  { to: "/overview", label: "Overview" },
  { to: "/feeds", label: "Feeds" },
  { to: "/reading", label: "Reading" },
  { to: "/access", label: "Access" },
] as const;

/** Blue rounded-square RSS mark from the accepted design board. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center rounded-[7px] bg-[#3565ec]"
      style={{ width: size, height: size }}
    >
      <svg
        width={size * 0.7}
        height={size * 0.7}
        viewBox="0 0 30 30"
        fill="none"
      >
        <circle cx="9" cy="21" r="2" fill="white" />
        <path
          d="M8 12 Q17 12 17 21 M8 6 Q23 6 23 21"
          stroke="white"
          strokeWidth="2"
          fill="none"
        />
      </svg>
    </span>
  );
}

/** Feeds needing-attention count for the sidebar badge; silent on failure. */
function useAttentionCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiGet<OverviewResponse>("/app/api/overview")
      .then((res) => {
        if (!cancelled) setCount(res.attention.total);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return count;
}

function NavBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-auto rounded-[5px] bg-[#493c2c] px-1.5 py-0.5 text-[11px] font-medium text-[#ffcf87]">
      {count}
    </span>
  );
}

function navLinkClass(active: boolean) {
  return cn(
    "flex items-center rounded-md px-3 py-2.5 text-sm font-medium transition-colors lg:px-5",
    active
      ? "bg-[#2d55c7] font-bold text-sidebar-foreground"
      : "text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground",
  );
}

/** Graphite navigation rail — desktop sidebar and compact mobile bar. */
export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const dashboardPath = pathname.replace(/^\/app(?=\/|$)/, "");
  const attention = useAttentionCount();

  const nav = (
    <>
      <p className="px-3 pb-2 text-xs font-medium uppercase tracking-wide text-sidebar-muted">
        Workspace
      </p>
      <ul className="space-y-1">
        {NAV_ITEMS.map((item) => {
          const active = dashboardPath.startsWith(item.to);
          return (
            <li key={item.to}>
              <Link
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={navLinkClass(active)}
              >
                {item.label}
                {item.to === "/feeds" && attention !== null && (
                  <NavBadge count={attention} />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );

  return (
    <>
      {/* Desktop rail */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[218px] flex-col bg-sidebar text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-3 px-6 pt-7">
          <BrandMark />
          <span className="text-[17px] font-semibold">My GReader</span>
        </div>
        <nav aria-label="Dashboard" className="mt-8 flex-1 px-4">
          {nav}
        </nav>
        <div className="border-t border-sidebar-accent px-5 py-4">
          <p className="text-[13px] font-medium">Your workspace</p>
          <a
            href="/auth/logout"
            className="mt-0.5 block text-xs text-sidebar-muted hover:text-sidebar-foreground"
          >
            Account / logout
          </a>
        </div>
      </aside>

      {/* Compact mobile bar */}
      <div className="sticky top-0 z-20 bg-sidebar text-sidebar-foreground lg:hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <BrandMark size={26} />
          <span className="text-[15px] font-semibold">My GReader</span>
          <a
            href="/auth/logout"
            className="ml-auto text-xs text-sidebar-muted hover:text-sidebar-foreground"
          >
            Account / logout
          </a>
        </div>
        <nav
          aria-label="Dashboard mobile"
          className="flex gap-1 overflow-x-auto px-3 pb-2"
        >
          {NAV_ITEMS.map((item) => {
            const active = dashboardPath.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cn(navLinkClass(active), "whitespace-nowrap")}
              >
                {item.label}
                {item.to === "/feeds" && attention !== null && (
                  <NavBadge count={attention} />
                )}
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}
