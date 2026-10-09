import { expect, test } from "@playwright/test";
import { seed } from "./seed";

test.beforeEach(() => seed("seed-feeds.sql"));

test("nav exposes Overview, Feeds, Reading, Access and redirects /app", async ({
  page,
}) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/app\/overview$/);

  const nav = page.getByRole("navigation", { name: "Dashboard" });
  for (const label of ["Overview", "Feeds", "Reading", "Access"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
  await expect(nav.getByRole("link", { name: "Overview" })).toHaveCSS(
    "font-weight",
    "700",
  );
});

test("overview summary cards appear in the required order", async ({
  page,
}) => {
  await page.goto("/app/overview");
  const cards = page.locator("[data-slot='card']");
  await expect(cards.nth(0)).toContainText("Your Feeds");
  await expect(cards.nth(1)).toContainText("New Items");
  await expect(cards.nth(2)).toContainText("Items marked read");
  await expect(cards.nth(3)).toContainText("Feeds needing attention");
  await expect(cards.nth(3)).toContainText("rate limited");
});

test("summary cards share one row at laptop widths", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("/app/overview");
  const cards = page.locator("[data-slot='card']");
  const boxes = await Promise.all(
    [0, 1, 2, 3].map((index) => cards.nth(index).boundingBox()),
  );
  expect(boxes.every((box) => box !== null)).toBe(true);
  expect(new Set(boxes.map((box) => box!.y)).size).toBe(1);
});

test("overview panels: reading, feed health, needs attention — names and values", async ({
  page,
}) => {
  await page.goto("/app/overview");

  const reading = page.locator("[data-slot='card']", {
    hasText: "Reading activity",
  });
  const health = page.locator("[data-slot='card']", {
    hasText: "Feed health",
  });
  // "Needs attention" also matches the summary stat card — take the panel.
  const attention = page
    .locator("[data-slot='card']", { hasText: "Needs attention" })
    .last();
  await expect(reading).toBeVisible();
  await expect(health).toBeVisible();
  await expect(attention).toBeVisible();

  // Reading panel: violet chart + per-feed top list; Alpha News tops it.
  await expect(reading).toContainText("Items marked read");
  await expect(
    reading.getByRole("link", { name: "Alpha News" }),
  ).toHaveAttribute("href", "/app/feeds/e2e-feed-active");

  // Feed health: latest attempt buckets — Beta/Gamma have no recorded
  // attempts; Alpha's latest is the seeded 500 error.
  await expect(health).toContainText("Failed");
  await expect(health).toContainText("No recorded activity");
  await expect(health).toContainText("Analytics Engine");
  // Latest cycle lifecycle from the seeded run.
  await expect(health).toContainText("cycle completed");

  // Needs attention links to feed detail with kind pills; failing +
  // rate-limited + auto-deactivated seeds, plus the paused footnote.
  const betaLink = attention.getByRole("link", { name: "Beta Blog" });
  await expect(betaLink).toHaveAttribute("href", "/app/feeds/e2e-feed-failing");
  await expect(
    attention.getByRole("link", { name: "Gamma Gazette" }),
  ).toBeVisible();
  await expect(
    attention.getByRole("link", { name: "Delta Daily" }),
  ).toHaveAttribute("href", "/app/feeds/e2e-feed-limited");
  await expect(attention).toContainText("Rate limited");
  await expect(attention).toContainText("Auto-deactivated");
  await expect(attention).toContainText("manually paused");
});

test("overview panels stack reading → health → attention on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto("/app/overview");

  const y = async (name: string) =>
    (await page
      .locator("[data-slot='card']", { hasText: name })
      .last()
      .boundingBox())!.y;

  const readingY = await y("Reading activity");
  const healthY = await y("Feed health");
  const attentionY = await y("Needs attention");
  expect(readingY).toBeLessThan(healthY);
  expect(healthY).toBeLessThan(attentionY);
});

test("deep-link reload resolves a client route", async ({ page }) => {
  await page.goto("/app/reading");
  await expect(page.getByRole("heading", { name: "Reading" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Reading" })).toBeVisible();
});

test("dashboard stylesheet is served and applies the layout", async ({
  page,
  request,
}) => {
  const stylesheet = await request.get("/styles.css");
  expect(stylesheet.ok()).toBeTruthy();
  expect(stylesheet.headers()["content-type"]).toContain("text/css");
  await page.goto("/app/overview");
  const card = page.locator("[data-slot='card']").first();
  await expect(card).toBeVisible();
  await expect(card).toHaveCSS("display", "flex");
});

test("dashboard JSON endpoint is not intercepted by the SPA fallback", async ({
  request,
}) => {
  const res = await request.get("/app/api/overview");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["content-type"]).toContain("application/json");
  const body = await res.json();
  expect(body).toHaveProperty("feedCount");
  expect(body).toHaveProperty("newItemsLast7Days");
  expect(body).toHaveProperty("markedReadLast7Days");
  expect(body).toHaveProperty("attention");
  expect(body).toHaveProperty("latestCycle");
});
