import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const seedFile = fileURLToPath(new URL("./seed-tokens.sql", import.meta.url));

// Each test reseeds so generation/revocation never leak between tests.
test.beforeEach(() => {
  execSync(
    `pnpm exec wrangler d1 execute rss-reader --local --file ${seedFile}`,
    { stdio: "pipe", env: process.env },
  );
});

test("lists tokens with state and shows connection instructions", async ({
  page,
}) => {
  await page.goto("/app/access");
  await expect(page.getByText("Connect a reader")).toBeVisible();
  await expect(page.getByText("FreshRSS", { exact: true })).toBeVisible();
  await expect(page.getByText("http://localhost:5176")).toBeVisible();
  await expect(page.getByText("dev@localhost")).toBeVisible();

  const keeper = page.getByRole("row", { name: /Seeded Keeper/ });
  await expect(keeper).toContainText("Active");
  await expect(keeper).toContainText("Never");
  await expect(page.getByRole("row", { name: /Seeded Retired/ })).toContainText(
    "Revoked",
  );
  await expect(page.getByText(/e2e-hash-/)).toHaveCount(0);
});

test("generates a token shown once, copies it, and hides it on reload", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/app/access");

  const name = page.getByLabel("Token name");
  await name.focus();
  await name.fill("Playwright Reader");
  await page.keyboard.press("Enter");

  const result = page.getByRole("region", { name: "New API token" });
  await expect(result).toBeVisible();
  const raw = (await page.getByTestId("raw-token").textContent())!;
  expect(raw).toMatch(/^[0-9a-f]{64}$/);

  // focus lands on the copy control for keyboard users
  const copy = page.getByRole("button", { name: "Copy token" });
  await expect(copy).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(result.getByRole("status")).toContainText("copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(raw);

  // route data refreshed with the new token
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

test("copy falls back to selecting the token when clipboard is denied", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });
  await page.goto("/app/access");
  await page.getByLabel("Token name").fill("No Clipboard");
  await page.getByRole("button", { name: "Generate" }).click();
  await page.getByRole("button", { name: "Copy token" }).click();
  await expect(page.getByText(/Copy failed/)).toBeVisible();
  const raw = await page.getByTestId("raw-token").textContent();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    raw,
  );
});

test("invalid name shows safe error feedback and creates nothing", async ({
  page,
}) => {
  await page.goto("/app/access");
  const name = page.getByLabel("Token name");
  await name.fill("   ");
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Enter a token name (1–100 characters).",
  );
  await expect(name).toBeFocused();
  await expect(page.getByRole("region", { name: "New API token" })).toHaveCount(
    0,
  );
});

test("server failure shows safe error feedback without a token", async ({
  page,
}) => {
  await page.route("**/app/api/tokens", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "failed to generate token" }),
        })
      : route.continue(),
  );
  await page.goto("/app/access");
  await page.getByLabel("Token name").fill("Will Fail");
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Token generation failed (500)",
  );
  await expect(page.getByRole("region", { name: "New API token" })).toHaveCount(
    0,
  );
});

test("revocation confirms the token by keyboard and leaves others", async ({
  page,
}) => {
  await page.goto("/app/access");
  const doomed = page.getByRole("row", { name: /Seeded Doomed/ });

  // cancel returns focus to the Revoke control
  await page.getByRole("button", { name: "Revoke Seeded Doomed" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("group", { name: "Confirm revoking Seeded Doomed" }),
  ).toContainText("Revoke “Seeded Doomed”?");
  await expect(
    page.getByRole("button", { name: "Confirm revoke" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByRole("button", { name: "Revoke Seeded Doomed" }),
  ).toBeFocused();

  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // Confirm revoke has focus
  await expect(page.getByRole("status")).toContainText(
    "Revoked “Seeded Doomed”.",
  );
  await expect(doomed).toContainText("Revoked");
  await expect(page.getByRole("row", { name: /Seeded Keeper/ })).toContainText(
    "Active",
  );

  await page.reload();
  await expect(
    page.getByRole("row", { name: /Seeded Doomed/ }),
  ).toContainText("Revoked");
  await expect(page.getByRole("row", { name: /Seeded Keeper/ })).toContainText(
    "Active",
  );
});

test("failed revocation shows safe feedback and keeps the token", async ({
  page,
}) => {
  await page.route("**/app/api/tokens/*", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "failed to revoke token" }),
    }),
  );
  await page.goto("/app/access");
  await page.getByRole("button", { name: "Revoke Seeded Keeper" }).click();
  await page.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Revoking “Seeded Keeper” failed (500).",
  );
  await expect(page.getByRole("row", { name: /Seeded Keeper/ })).toContainText(
    "Active",
  );
});
