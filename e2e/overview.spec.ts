import { expect, test } from "@playwright/test";
import { seed } from "./seed";

test.beforeEach(() => seed("seed-feeds.sql"));

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
