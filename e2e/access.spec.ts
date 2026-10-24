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

test("keeps keyboard focus predictable when cancelling token actions and reports failures", async ({
  page,
}) => {
  await page.goto("/app/access");

  await page.getByRole("button", { name: "Create API Token" }).click();
  const name = page.getByLabel("Token name");
  await expect(name).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const cancelCreate = page.getByRole("button", { name: "Cancel" });
  await expect(cancelCreate).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Create API Token" }),
  ).toBeFocused();

  await page.getByRole("button", { name: "Create API Token" }).click();
  await page.getByLabel("Token name").fill("Unavailable token");
  await page.route("**/app/api/tokens", (route) =>
    route.fulfill({ status: 500, body: "internal error with private details" }),
  );
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Token creation failed (500). Try again.",
  );
  await expect(page.getByLabel("Token name")).toBeFocused();
  await expect(page.getByText("private details")).toHaveCount(0);
  await page.unroute("**/app/api/tokens");

  const doomed = page.getByRole("row", { name: /Seeded Doomed/ });
  await doomed.getByRole("button", { name: "Revoke Seeded Doomed" }).click();
  const confirmation = page.getByRole("group", {
    name: "Confirm revoking Seeded Doomed",
  });
  const confirm = confirmation.getByRole("button", { name: "Confirm revoke" });
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  const cancelRevoke = confirmation.getByRole("button", { name: "Cancel" });
  await expect(cancelRevoke).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    doomed.getByRole("button", { name: "Revoke Seeded Doomed" }),
  ).toBeFocused();

  await doomed.getByRole("button", { name: "Revoke Seeded Doomed" }).click();
  await page.route("**/app/api/tokens/*", (route) =>
    route.fulfill({ status: 500, body: "internal error with private details" }),
  );
  await page.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Revoking “Seeded Doomed” failed (500).",
  );
  await expect(
    doomed.getByRole("button", { name: "Revoke Seeded Doomed" }),
  ).toBeFocused();
  await expect(page.getByText("private details")).toHaveCount(0);
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
