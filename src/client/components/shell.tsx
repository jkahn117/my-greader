/** @jsxImportSource react */
import { Outlet } from "@tanstack/react-router";
import { AppSidebar } from "./app-sidebar";

/**
 * Management shell — graphite navigation rail (design rev05) framing every
 * dashboard route; ~1200px content column on cool gray surfaces.
 */
export function Shell() {
  return (
    <div className="min-h-screen bg-background">
      <AppSidebar />
      <main className="lg:pl-[218px]">
        <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
