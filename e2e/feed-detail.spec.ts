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
