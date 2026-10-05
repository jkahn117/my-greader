import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const seedFile = fileURLToPath(new URL("./seed-feeds.sql", import.meta.url));

test.beforeAll(() => {
  execSync(
    `pnpm exec wrangler d1 execute rss-reader --local --file ${seedFile}`,
    { stdio: "pipe", env: process.env },
  );
});

const feedTable = (page: import("@playwright/test").Page) =>
  page.getByRole("table", { name: "Marked read by feed" });

test("shows daily and per-feed marked-read metrics for the default window", async ({
  page,
}) => {
  await page.goto("/app/reading");
  await expect(page.getByRole("heading", { name: "Reading" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "7 days" }),
  ).toHaveAttribute("aria-current", "page");

  const total = page.locator("[data-slot='card']").filter({
    hasText: "Items marked read",
  });
  // Alpha 1h + 3h (may straddle midnight) and Beta 2d ago; Gamma is 10d ago
  await expect(total.locator("[data-slot='card-title']")).toHaveText("3");
  await expect(total).toContainText("past 7 days in");

  const days = page.getByTestId("reading-day");
  await expect(days).toHaveCount(7);
  await expect(days.last()).toContainText("today, partial");

  const table = feedTable(page);
  await expect(table.getByRole("link", { name: "Alpha News" })).toBeVisible();
  await expect(table.getByRole("link", { name: "Beta Blog" })).toBeVisible();
  await expect(table.getByRole("link", { name: "Gamma Gazette" })).toHaveCount(
    0,
  );
  // other users' receipts never inflate the dev user's per-feed counts
  await expect(
    table
      .getByRole("row")
      .filter({ hasText: "Alpha News" })
      .getByRole("cell", { name: "2", exact: true }),
  ).toBeVisible();

  await expect(page.getByText(/Currently starred/i)).toBeVisible();
  await expect(page.getByText(/received the mark-read/)).toBeVisible();
  await expect(page.getByText(/work offline sync later/)).toBeVisible();
  await expect(page.getByText(/Marking an item read again/)).toBeVisible();
  await expect(page.getByText(/days after they\s+were fetched/)).toBeVisible();
});

test("time window control widens the window via the keyboard", async ({
  page,
}) => {
  await page.goto("/app/reading");
  await expect(page.getByTestId("reading-day")).toHaveCount(7);

  await page.getByRole("link", { name: "14 days" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app\/reading\?days=14$/);
  await expect(page.getByTestId("reading-day")).toHaveCount(14);
  await expect(
    feedTable(page).getByRole("link", { name: "Gamma Gazette" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "30 days" }).click();
  await expect(page.getByTestId("reading-day")).toHaveCount(30);
  await expect(page.getByText(/past 30 days in/).first()).toBeVisible();

  // unsupported windows fall back to the default
  await page.goto("/app/reading?days=99");
  await expect(
    page.getByRole("link", { name: "7 days" }),
  ).toHaveAttribute("aria-current", "page");
});

test("per-feed rows link to the feed detail page", async ({ page }) => {
  await page.goto("/app/reading");
  await feedTable(page).getByRole("link", { name: "Beta Blog" }).click();
  await expect(page).toHaveURL(/\/app\/feeds\/e2e-feed-failing$/);
});

test("empty windows and missing subscriptions show explicit empty states", async ({
  page,
}) => {
  const base = {
    days: 7,
    timezone: "UTC",
    windowStart: 0,
    windowEnd: 0,
    markedRead: 0,
    daily: Array.from({ length: 7 }, (_, i) => ({
      date: `2026-01-0${i + 1}`,
      count: 0,
      partial: i === 6,
    })),
    byFeed: [],
    starredCount: 0,
    retentionDays: 30,
    generatedAt: 0,
  };

  await page.route("**/app/api/reading*", (route) =>
    route.fulfill({ json: { ...base, subscriptionCount: 3 } }),
  );
  await page.goto("/app/reading");
  await expect(
    page.getByText("No items marked read in the past 7 days."),
  ).toBeVisible();
  await expect(
    page.getByText("No feeds have items marked read in this window."),
  ).toBeVisible();

  await page.unroute("**/app/api/reading*");
  await page.route("**/app/api/reading*", (route) =>
    route.fulfill({ json: { ...base, subscriptionCount: 0 } }),
  );
  await page.reload();
  await expect(page.getByText(/No subscriptions yet/)).toBeVisible();
  await expect(page.getByRole("link", { name: "add feeds" })).toBeVisible();
});

test("reading page fits a narrow viewport without horizontal scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/app/reading?days=30");
  await expect(page.getByTestId("reading-day")).toHaveCount(30);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
