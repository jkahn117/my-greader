import { test, expect } from "@playwright/test";
import { seed } from "./seed";

test.beforeEach(() => seed("seed-feeds.sql"));

test("feed detail loads directly and shows current state", async ({ page }) => {
  await page.goto("/app/feeds/e2e-feed-failing");
  await expect(page.getByRole("heading", { name: "Beta Blog" })).toBeVisible();
  await expect(
    page.getByText("Failing", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "← Feeds" })).toBeVisible();
  await expect(page.getByText("HTTP 500 on the last 3 checks.")).toBeVisible();
  await expect(page.getByText("Current backoff")).toBeVisible();
  await expect(page.getByText("Next eligible")).toBeVisible();
  await expect(page.getByText("Backload")).toBeVisible();
  await expect(page.getByText("No checks recorded yet.").first()).toBeVisible();
});

test("rate-limited feed summarizes 429 evidence and groups it", async ({
  page,
}) => {
  await page.goto("/app/feeds/e2e-feed-limited");
  await expect(
    page.getByText("HTTP 429 on the last check. Backoff is active."),
  ).toBeVisible();
  await expect(page.getByText("HTTP 429 · rate limited")).toBeVisible();
  await expect(
    page.getByText(/1 consecutive rate-limited check/),
  ).toBeVisible();
});

test("deactivated feed shows its reason state and reactivates", async ({
  page,
}) => {
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
  await expect(
    page.getByRole("menuitem", { name: "Deactivate feed" }),
  ).toBeVisible();
});

test("deactivate is keyboard operable and refreshes state", async ({
  page,
}) => {
  await page.goto("/app/feeds/e2e-feed-active");
  const button = page.getByRole("button", { name: "Feed actions" });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "Deactivate feed" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("deactivated");
  await expect(page.getByText("Polling is paused manually.")).toBeVisible();
  await expect(button).toBeFocused();
});

test("unsubscribed feed detail shows not-found", async ({ page }) => {
  await page.goto("/app/feeds/does-not-exist");
  await expect(page.getByText("Feed not found")).toBeVisible();
});

test("legacy feed history is reported as unknown, not empty", async ({
  page,
}) => {
  await page.goto("/app/feeds/e2e-feed-paused");
  await expect(page.getByText("Polling is paused manually.")).toBeVisible();
  await expect(
    page.getByText(/checked before attempt history was recorded/).first(),
  ).toBeVisible();
});

test("results show outcomes, expansion, and copy controls", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/app/feeds/e2e-feed-active");
  await expect(page.getByText("Check history")).toBeVisible();
  await expect(page.getByText("Error breakdown")).toBeVisible();
  await expect(page.getByLabel("Check outcome timeline")).toBeVisible();
  await expect(page.getByText(/1 consecutive failed check/)).toBeVisible();

  const results = page.getByRole("table", { name: "Attempt results" });
  await expect(
    results.getByRole("button", { name: /Failed · HTTP 500/ }),
  ).toBeVisible();
  await expect(
    results.getByRole("button", { name: /Rate limited · HTTP 429/ }),
  ).toBeVisible();

  await results.getByRole("button", { name: /Failed · HTTP 500/ }).click();
  await expect(results.getByText("HTTP status")).toBeVisible();
  await expect(results.getByText("e2e-att-3", { exact: true })).toBeVisible();
  await expect(results.getByText("Parser not attempted").last()).toBeVisible();

  await results.getByRole("button", { name: "Copy full ID" }).click();
  await expect(results.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "e2e-att-3",
  );
});

test("selecting a check in the strip opens its result", async ({ page }) => {
  await page.goto("/app/feeds/e2e-feed-active");
  await page
    .getByLabel("Check outcome timeline")
    .getByRole("button", { name: /Rate limited/ })
    .click();
  await expect(page.getByText(/Selected: .* Rate limited/)).toBeVisible();
  await expect(page.getByText(/Feed server requested Backoff/)).toBeVisible();
});

test("results filter narrows to problems", async ({ page }) => {
  await page.goto("/app/feeds/e2e-feed-active");
  const results = page.getByRole("table", { name: "Attempt results" });
  await expect(
    results.getByRole("button", { name: /New items/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "All results" }).click();
  await page.getByRole("menuitemradio", { name: "Problems" }).click();
  await expect(results.getByRole("button", { name: /New items/ })).toHaveCount(
    0,
  );
  await expect(
    results.getByRole("button", { name: /Failed · HTTP 500/ }),
  ).toBeVisible();
});

test("result expansion is keyboard operable", async ({ page }) => {
  await page.goto("/app/feeds/e2e-feed-active");
  const row = page
    .getByRole("table", { name: "Attempt results" })
    .getByRole("button", { name: /New items/ });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Items stored")).toBeVisible();
  await expect(page.getByRole("link", { name: "First Article" })).toBeVisible();
});
