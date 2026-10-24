import { expect, test } from "@playwright/test";

test("serves the dashboard stylesheet with the application shell", async ({
  page,
}) => {
  const stylesheet = page.waitForResponse(
    (response) =>
      response.url().endsWith("/styles.css") &&
      response.request().resourceType() === "stylesheet",
  );

  await page.goto("/app/overview");

  const response = await stylesheet;
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("text/css");
  expect(await response.text()).toContain(".min-h-screen{min-height:100vh}");
  await expect(
    page.locator('link[rel="stylesheet"][href="/styles.css"]'),
  ).toHaveCount(1);
});
