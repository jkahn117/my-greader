import { expect, test } from "@playwright/test";
import { seed } from "./seed";

test.beforeEach(() => seed("seed-feeds.sql"));

function overviewSummary(feedCount: number) {
  return {
    feedCount,
    activeFeedCount: feedCount,
    deactivatedFeedCount: 0,
    newItemsLast7Days: 0,
    markedReadLast7Days: 0,
    attention: {
      total: 0,
      rateLimited: 0,
      failing: 0,
      autoDeactivated: 0,
      manuallyPaused: 0,
    },
    latestCycle: { state: "missing" as const, ranAt: null, checkedFeeds: null },
    timezone: "UTC",
    generatedAt: 1,
  };
}

function overviewPanels(missing: number) {
  return {
    reading: { windowDays: 7, daily: [], total: 0, topFeeds: [] },
    feedHealth: {
      successful: 0,
      rateLimited: 0,
      failed: 0,
      skipped: 0,
      running: 0,
      empty: 0,
      missing,
    },
    cycle: { state: "missing" as const, ranAt: null, checkedFeeds: null },
    needsAttention: [],
    manuallyPaused: 0,
    analyticsEngine: { status: "unavailable" as const },
    generatedAt: 1,
  };
}

test("routes through the dashboard shell and reloads a deep link", async ({
  page,
}) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/app\/overview$/);

  const nav = page.getByRole("navigation", { name: "Dashboard" });
  for (const label of ["Overview", "Feeds", "Reading", "Access"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }

  await nav.getByRole("link", { name: "Reading" }).click();
  await expect(page.getByRole("heading", { name: "Reading" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Reading" })).toBeVisible();
});

test("refreshes the summary and panels after a Sync", async ({ page }) => {
  let summaryRequests = 0;
  let panelRequests = 0;

  await page.route("**/app/api/overview", async (route) => {
    summaryRequests += 1;
    await route.fulfill({
      json: overviewSummary(summaryRequests === 1 ? 10 : 11),
    });
  });
  await page.route("**/app/api/overview/panels", async (route) => {
    panelRequests += 1;
    await route.fulfill({
      json: overviewPanels(panelRequests === 1 ? 10 : 11),
    });
  });

  await page.goto("/app/overview");
  const feedsCard = page
    .locator("[data-slot='card']")
    .filter({ hasText: "Your Feeds" })
    .first();
  const healthCard = page
    .locator("[data-slot='card']")
    .filter({ hasText: "Feed health" });
  await expect(feedsCard.getByText("10", { exact: true })).toBeVisible();
  await expect(
    healthCard
      .getByRole("listitem")
      .filter({ hasText: "No recorded activity" }),
  ).toContainText("10");

  const syncResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/app/api/feeds/sync") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sync now" }).press("Enter");
  await page.getByRole("menuitem", { name: "Sync now" }).press("Enter");
  await syncResponse;
  await expect(feedsCard.getByText("11", { exact: true })).toBeVisible();
  await expect.poll(() => panelRequests).toBeGreaterThanOrEqual(2);
  await expect(
    healthCard
      .getByRole("listitem")
      .filter({ hasText: "No recorded activity" }),
  ).toContainText("11");
  expect(summaryRequests).toBeGreaterThanOrEqual(2);
  expect(panelRequests).toBeGreaterThanOrEqual(2);
});

test("recovers failed panels on a later router refresh", async ({ page }) => {
  let panelRequests = 0;
  await page.route("**/app/api/overview/panels", async (route) => {
    panelRequests += 1;
    if (panelRequests === 1) {
      await route.abort();
      return;
    }

    await route.fulfill({ json: overviewPanels(12) });
  });

  await page.goto("/app/overview");
  await expect(
    page.getByText("Overview panels could not be loaded"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
  const syncResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/app/api/feeds/sync") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sync now" }).press("Enter");
  await page.getByRole("menuitem", { name: "Sync now" }).press("Enter");
  await syncResponse;
  await expect.poll(() => panelRequests).toBeGreaterThanOrEqual(2);
  await expect(
    page.getByText("Your reading activity", { exact: true }),
  ).toBeVisible();
});

test("presents seeded reading, Feed health, and attention data", async ({
  page,
}) => {
  await page.goto("/app/overview");

  const summaryCards = page.locator("[data-slot='card']");
  await expect(
    summaryCards.filter({ hasText: "Your Feeds" }).first(),
  ).toBeVisible();
  await expect(
    summaryCards.filter({ hasText: "New Items" }).first(),
  ).toBeVisible();
  await expect(
    summaryCards.filter({ hasText: "Items marked read" }).first(),
  ).toBeVisible();
  await expect(
    summaryCards.filter({ hasText: "Feeds needing attention" }).first(),
  ).toContainText("rate limited");

  const reading = summaryCards.filter({ hasText: "Reading activity" });
  const health = summaryCards.filter({ hasText: "Feed health" });
  const attention = summaryCards.filter({ hasText: "Needs attention" }).last();
  await expect(
    reading.getByRole("link", { name: "Alpha News" }),
  ).toHaveAttribute("href", "/app/feeds/e2e-feed-active");
  await expect(health).toContainText("Failed");
  await expect(health).toContainText("No recorded activity");
  await expect(health).toContainText("cycle completed");

  await expect(
    attention.getByRole("link", { name: "Beta Blog" }),
  ).toHaveAttribute("href", "/app/feeds/e2e-feed-failing");
  await expect(attention).toContainText("Rate limited");
  await expect(attention).toContainText("Auto-deactivated");
  await expect(attention).toContainText("manually paused");
});
