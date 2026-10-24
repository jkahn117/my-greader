import { test, expect } from "@playwright/test";
import { seed } from "./seed";

const reasons = [
  {
    id: "automatic-transient",
    reason: "automatic_transient",
    explanation: "Automatically deactivated after repeated transient errors.",
  },
  {
    id: "automatic-permanent",
    reason: "automatic_permanent",
    explanation: "Automatically deactivated after a permanent failure.",
  },
  {
    id: "legacy-null",
    reason: null,
    explanation:
      "Deactivated before Deactivation reasons were recorded — the cause is unknown.",
  },
] as const;

test.beforeEach(() => seed("seed-feeds.sql"));

test("explains automatic and legacy Deactivation reasons distinctly", async ({
  page,
}) => {
  for (const { id, reason, explanation } of reasons) {
    await page.route(`**/app/api/feeds/${id}`, (route) =>
      route.fulfill({
        json: {
          feedId: id,
          subscriptionId: `subscription-${id}`,
          title: id,
          feedUrl: `https://${id}.example.com/feed.xml`,
          htmlUrl: null,
          folder: null,
          status: "deactivated",
          lastSuccessfulAt: null,
          lastCheckedAt: null,
          nextCheckAt: null,
          lastNewItemAt: null,
          consecutiveErrors: 0,
          lastError: "Connection failed",
          checkIntervalMinutes: 30,
          deactivatedAt: 1_700_000_000_000,
          deactivatedReason: reason,
          legacyUncertain: reason === null,
          backloadComplete: false,
        },
      }),
    );
    await page.route(`**/app/api/feeds/${id}/attempts**`, (route) =>
      route.fulfill({
        json: {
          attempts: [],
          nextCursor: null,
          streaks: {
            problem: { count: 0, lowerBound: false },
            rateLimited: { count: 0, lowerBound: false },
          },
          problemGroups: { windowDays: 30, groups: [] },
          historyState: "empty",
          retentionDays: 90,
          generatedAt: 1_700_000_000_000,
        },
      }),
    );

    await page.goto(`/app/feeds/${id}`);
    await expect(page.getByText(explanation, { exact: true })).toBeVisible();
    if (reason === null) {
      await expect(
        page.getByText(/Automatically deactivated after/),
      ).toHaveCount(0);
    } else {
      await expect(
        page.getByText(/Deactivated before Deactivation reasons were recorded/),
      ).toHaveCount(0);
    }
  }
});
