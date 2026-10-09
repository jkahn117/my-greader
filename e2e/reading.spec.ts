import { test, expect } from "@playwright/test";
import { seed } from "./seed";

test.beforeEach(() => seed("seed-feeds.sql"));

// Scope per-Feed assertions to the reading metrics rather than navigation links.
const feedTable = (page: import("@playwright/test").Page) =>
  page.getByRole("table", { name: "Marked read by feed" });

test("reviews marked-read metrics across reporting windows", async ({
  page,
}) => {
  await page.goto("/app/reading");
  await expect(page.getByRole("heading", { name: "Reading" })).toBeVisible();
  await expect(page.getByRole("link", { name: "7 days" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  const total = page.locator("[data-slot='card']").filter({
    hasText: "Items marked read",
  });
  await expect(total.locator("[data-slot='card-title']")).toHaveText("3");
  await expect(total).toContainText("past 7 days in");
  await expect(page.locator("[data-chart]")).toBeVisible();

  const days = page.getByTestId("reading-day");
  await expect(days).toHaveCount(7);
  await page.getByText("Daily totals").click();
  await expect(days.last()).toContainText("today, partial");

  const table = feedTable(page);
  await expect(table.getByRole("link", { name: "Alpha News" })).toBeVisible();
  await expect(table.getByRole("link", { name: "Beta Blog" })).toBeVisible();
  await expect(table.getByRole("link", { name: "Gamma Gazette" })).toHaveCount(
    0,
  );
  await expect(
    table
      .getByRole("row")
      .filter({ hasText: "Alpha News" })
      .getByRole("cell", { name: "2", exact: true }),
  ).toBeVisible();

  await page.getByText("How read activity is counted").click();
  await expect(page.getByText(/received the mark-read/)).toBeVisible();
  await expect(page.getByText(/work offline sync later/)).toBeVisible();

  await page.getByRole("link", { name: "14 days" }).click();
  await expect(page).toHaveURL(/\/app\/reading\?days=14$/);
  await expect(page.getByTestId("reading-day")).toHaveCount(14);
  await expect(
    feedTable(page).getByRole("link", { name: "Gamma Gazette" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "30 days" }).click();
  await expect(page.getByTestId("reading-day")).toHaveCount(30);
  await expect(page.getByText(/past 30 days in/).first()).toBeVisible();
});

test("shows empty states for no activity and no Subscriptions", async ({
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
    page.getByText(
      "No Feed breakdown yet. It will appear when read activity is recorded.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/Activity appears here after your reader/),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Reader connection instructions" })
    .click();
  await expect(page).toHaveURL(/\/app\/access$/);

  await page.unroute("**/app/api/reading*");
  await page.route("**/app/api/reading*", (route) =>
    route.fulfill({ json: { ...base, subscriptionCount: 0 } }),
  );
  await page.goto("/app/reading");
  await expect(page.getByText(/No subscriptions yet/)).toBeVisible();
  await expect(page.getByRole("link", { name: "add feeds" })).toBeVisible();
});
