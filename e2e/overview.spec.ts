import { expect, test } from "@playwright/test";

test("nav exposes Overview, Feeds, Reading, Access and redirects /app", async ({
  page,
}) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/app\/overview$/);

  const nav = page.getByRole("navigation", { name: "Dashboard" });
  for (const label of ["Overview", "Feeds", "Reading", "Access"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
});

test("overview summary cards appear in the required order", async ({
  page,
}) => {
  await page.goto("/app/overview");
  const cards = page.locator("[data-slot='card']");
  await expect(cards.nth(0)).toContainText("Feeds");
  await expect(cards.nth(1)).toContainText("New items");
  await expect(cards.nth(2)).toContainText("Items marked read");
  await expect(cards.nth(3)).toContainText("Needs attention");
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

  // Reading panel: one item marked read in window; Alpha News tops the list.
  await expect(reading).toContainText("Most marked read");
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

  // Needs attention links to feed detail; failing + deactivated seeds.
  const betaLink = attention.getByRole("link", { name: "Beta Blog" });
  await expect(betaLink).toHaveAttribute(
    "href",
    "/app/feeds/e2e-feed-failing",
  );
  await expect(
    attention.getByRole("link", { name: "Gamma Gazette" }),
  ).toBeVisible();
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
  await expect(
    page.getByRole("heading", { name: "Reading" }),
  ).toBeVisible();
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
  expect(body).toHaveProperty("feedsNeedingAttention");
});
