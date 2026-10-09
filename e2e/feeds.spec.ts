import { test, expect } from "@playwright/test";
import { seed } from "./seed";

test.beforeEach(() => seed("seed-feeds.sql"));

test("lists, sorts, and filters Subscriptions", async ({ page }) => {
  await page.goto("/app/feeds");
  await expect(page.getByRole("link", { name: "Alpha News" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Beta Blog" })).toBeVisible();

  await expect(
    page
      .getByRole("row", { name: /Beta Blog/ })
      .getByRole("cell", { name: "Failing", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("row", { name: /Gamma Gazette/ })
      .getByRole("cell", { name: "Deactivated", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("row", { name: /Delta Daily/ })
      .getByRole("cell", { name: "Rate limited", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("row", { name: /Epsilon Echo/ })
      .getByRole("cell", { name: "Paused", exact: true }),
  ).toBeVisible();

  const titles = await page
    .getByRole("table")
    .getByRole("link")
    .filter({ hasText: /\S/ })
    .allTextContents();
  expect(titles).toEqual([
    "Beta Blog",
    "Alpha News",
    "Gamma Gazette",
    "Delta Daily",
    "Epsilon Echo",
  ]);

  await page.getByLabel("Search subscriptions").fill("beta");
  await expect(page.getByRole("link", { name: "Beta Blog" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Alpha News" })).toHaveCount(0);

  await page.getByLabel("Search subscriptions").fill("");
  await page.getByLabel("Filter by status").selectOption("deactivated");
  await expect(page.getByRole("link", { name: "Gamma Gazette" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Alpha News" })).toHaveCount(0);

  await page.getByLabel("Filter by status").selectOption("paused");
  await page.getByLabel("Filter by folder").selectOption("Tech");
  await expect(
    page.getByText("No subscriptions match the current filters"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("link", { name: "Alpha News" })).toBeVisible();

  await page.getByRole("link", { name: "Alpha News" }).click();
  await expect(page).toHaveURL(/\/app\/feeds\/e2e-feed-active$/);
});

test("imports OPML and reports outcomes", async ({ page }) => {
  await page.goto("/app/feeds");
  const opml = `<?xml version="1.0"?><opml version="2.0"><body>
    <outline type="rss" text="New One" xmlUrl="https://newone.example.com/feed.xml"/>
    <outline type="rss" text="Alpha" xmlUrl="https://alpha.example.com/feed.xml"/>
  </body></opml>`;
  await page.getByLabel("OPML file").setInputFiles({
    name: "feeds.opml",
    mimeType: "text/xml",
    buffer: Buffer.from(opml),
  });
  await expect(page.getByRole("status")).toContainText("1 imported");
  await expect(page.getByRole("status")).toContainText("1 duplicate");
  await expect(page.getByRole("link", { name: "New One" })).toBeVisible();
});

test("starts a forced sync or reports no eligible Feeds", async ({ page }) => {
  await page.goto("/app/feeds");
  await page.getByRole("button", { name: "Sync now" }).click();
  await page
    .getByRole("menuitem", { name: "Force sync (ignore eligibility)" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    /Sync started|Nothing eligible/,
  );
});
