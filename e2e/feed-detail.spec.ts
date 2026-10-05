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

test("feed detail loads directly and shows current state", async ({
  page,
}) => {
  await page.goto("/app/feeds/e2e-feed-failing");
  await expect(page.getByRole("heading", { name: "Beta Blog" })).toBeVisible();
  await expect(page.getByText("Failing", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Consecutive errors")).toBeVisible();
  await expect(page.getByText("Backoff")).toBeVisible();
  await expect(page.getByText("Backload")).toBeVisible();
});

test("deactivated feed shows its reason state and reactivates", async ({
  page,
}) => {
  await page.goto("/app/feeds/e2e-feed-dead");
  await expect(
    page.getByText("Deactivated", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(/Unknown — deactivated before reason tracking/),
  ).toBeVisible();

  await page.getByRole("button", { name: "Reactivate" }).click();
  await expect(page.getByRole("status")).toContainText("reactivated");
  await expect(
    page.getByRole("button", { name: "Deactivate" }),
  ).toBeVisible();
});

test("deactivate is keyboard operable and refreshes state", async ({
  page,
}) => {
  await page.goto("/app/feeds/e2e-feed-active");
  const button = page.getByRole("button", { name: "Deactivate" });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("deactivated");
  await expect(page.getByText("Manual (", { exact: false })).toBeVisible();
});

test("unsubscribed feed detail shows not-found", async ({ page }) => {
  await page.goto("/app/feeds/does-not-exist");
  await expect(page.getByText("Feed not found")).toBeVisible();
});

test("attempt history shows outcomes, expansion, and copy control", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/app/feeds/e2e-feed-active");
  await expect(page.getByText("Attempt history")).toBeVisible();
  await expect(
    page.getByLabel("Attempt outcome timeline"),
  ).toBeVisible();

  // Outcome badges and streak from seeded attempts (newest first).
  await expect(page.getByText("Failed", { exact: true })).toBeVisible();
  await expect(page.getByText("Rate limited", { exact: true })).toBeVisible();
  await expect(page.getByText("New items", { exact: true })).toBeVisible();
  await expect(page.getByText("Problem streak: 1")).toBeVisible();

  // Expand the newest attempt — diagnostics and copy control appear.
  await page
    .getByRole("button", { name: /Failed/ })
    .first()
    .click();
  await expect(page.getByText("HTTP status")).toBeVisible();
  await expect(page.getByText("HTTP 500")).toBeVisible();
  await expect(page.getByText("Parser")).toBeVisible();

  const copy = page.getByRole("button", { name: "Copy ID" });
  await copy.click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
});

test("attempt expansion is keyboard operable", async ({ page }) => {
  await page.goto("/app/feeds/e2e-feed-active");
  const row = page.getByRole("button", { name: /New items/ });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Items stored")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "First Article" }),
  ).toBeVisible();
});
