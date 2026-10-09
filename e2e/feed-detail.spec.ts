import { test, expect } from "@playwright/test";
import { seed } from "./seed";

test.beforeEach(() => seed("seed-feeds.sql"));

test("inspects Feed health and attempt details", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/app/feeds/e2e-feed-active");
  await expect(page.getByRole("heading", { name: "Alpha News" })).toBeVisible();
  await expect(page.getByRole("link", { name: "← Feeds" })).toBeVisible();
  await expect(page.getByText("Check history")).toBeVisible();
  await expect(page.getByText("Error breakdown")).toBeVisible();
  await expect(page.getByLabel("Check outcome timeline")).toBeVisible();
  await expect(page.getByText(/1 consecutive failed check/)).toBeVisible();

  const results = page.getByRole("table", { name: "Attempt results" });
  await results.getByRole("button", { name: /Failed · HTTP 500/ }).click();
  await expect(results.getByText("HTTP status")).toBeVisible();
  await expect(results.getByText("e2e-att-3", { exact: true })).toBeVisible();
  await expect(results.getByText("Parser not attempted").last()).toBeVisible();
  await results.getByRole("button", { name: "Copy full ID" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "e2e-att-3",
  );

  await page
    .getByLabel("Check outcome timeline")
    .getByRole("button", { name: /Rate limited/ })
    .click();
  await expect(page.getByText(/Selected: .* Rate limited/)).toBeVisible();
  await expect(page.getByText(/Feed server requested Backoff/)).toBeVisible();

  await page.getByRole("button", { name: "All results" }).click();
  await page.getByRole("menuitemradio", { name: "Problems" }).click();
  await expect(results.getByRole("button", { name: /New items/ })).toHaveCount(
    0,
  );
  await expect(
    results.getByRole("button", { name: /Failed · HTTP 500/ }),
  ).toBeVisible();
});

test("reactivates and manually deactivates a Feed", async ({ page }) => {
  await page.goto("/app/feeds/e2e-feed-dead");
  await expect(
    page.getByText("Deactivated", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(/Deactivated before Deactivation reasons were recorded/),
  ).toBeVisible();

  await page.getByRole("button", { name: "Feed actions" }).click();
  await page.getByRole("menuitem", { name: "Reactivate feed" }).click();
  await expect(page.getByRole("status")).toContainText("reactivated");

  await page.getByRole("button", { name: "Feed actions" }).click();
  await page.getByRole("menuitem", { name: "Deactivate feed" }).click();
  await expect(page.getByRole("status")).toContainText("deactivated");
  await expect(page.getByText("Polling is paused manually.")).toBeVisible();
});
