/** @jsxImportSource react */
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from "./ui/navigation-menu";

const NAV_ITEMS = [
  { to: "/overview", label: "Overview" },
  { to: "/feeds", label: "Feeds" },
  { to: "/reading", label: "Reading" },
  { to: "/access", label: "Access" },
] as const;

/**
 * Management shell — header with primary navigation; the React client's
 * persistent frame for every dashboard route.
 */
export function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <a href="/app" className="text-base font-semibold text-foreground">
            my-greader
          </a>
          <a
            href="/auth/logout"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Log out
          </a>
        </div>
        <nav aria-label="Dashboard" className="mx-auto max-w-5xl px-2 pb-1">
          <NavigationMenu viewport={false}>
            <NavigationMenuList>
              {NAV_ITEMS.map((item) => (
                <NavigationMenuItem key={item.to}>
                  <NavigationMenuLink
                    asChild
                    active={pathname.startsWith(item.to)}
                  >
                    <Link to={item.to}>{item.label}</Link>
                  </NavigationMenuLink>
                </NavigationMenuItem>
              ))}
            </NavigationMenuList>
          </NavigationMenu>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
