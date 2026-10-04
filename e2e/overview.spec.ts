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
