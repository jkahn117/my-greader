import { test, expect } from "@playwright/test";
import { seed } from "./seed";

test.beforeEach(() => seed("seed-tokens.sql"));

test("creates a token that is shown once and persists", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/app/access");
  await expect(
    page.getByRole("heading", { level: 1, name: "API Tokens" }),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /Seeded Keeper/ })).toContainText(
    "Never",
  );
  await expect(page.getByRole("row", { name: /Seeded Retired/ })).toContainText(
    "Revoked",
  );
  await expect(page.getByText(/e2e-hash-/)).toHaveCount(0);

  const instructions = page.getByRole("button", {
    name: "Current connection instructions",
  });
  await instructions.click();
  await expect(page.getByText("FreshRSS", { exact: true })).toBeVisible();
  await expect(page.getByText("http://localhost:5176")).toBeVisible();

  await page.getByRole("button", { name: "Create API Token" }).click();
  await page.getByLabel("Token name").fill("Playwright Reader");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const result = page.getByRole("region", { name: "New API Token" });
  await expect(result).toBeVisible();
  const raw = (await page.getByTestId("raw-token").textContent())!;
  expect(raw).toMatch(/^[0-9a-f]{64}$/);

  await page.getByRole("button", { name: "Copy token" }).click();
  await expect(result.getByRole("status")).toContainText("copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(raw);
  await expect(
    page.getByRole("row", { name: /Playwright Reader/ }),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("row", { name: /Playwright Reader/ }),
  ).toBeVisible();
  await expect(result).toHaveCount(0);
  expect(await page.content()).not.toContain(raw);
});

test("revokes one token and leaves the others active", async ({ page }) => {
  await page.goto("/app/access");
  const doomed = page.getByRole("row", { name: /Seeded Doomed/ });

  await page.getByRole("button", { name: "Revoke Seeded Doomed" }).click();
  await expect(
    page.getByRole("group", { name: "Confirm revoking Seeded Doomed" }),
  ).toContainText("Revoke “Seeded Doomed”?");
  await page.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Revoked “Seeded Doomed”.",
  );
  await expect(doomed).toContainText("Revoked");
  await expect(
    page.getByRole("button", { name: "Revoke Seeded Keeper" }),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByRole("row", { name: /Seeded Doomed/ })).toContainText(
    "Revoked",
  );
  await expect(
    page.getByRole("button", { name: "Revoke Seeded Keeper" }),
  ).toBeVisible();
});
