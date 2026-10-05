import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { apiTokens, users } from "../src/db/schema";
import { sha256 } from "../src/lib/crypto";
import { getDb } from "../src/lib/db";

const TOKEN = "rate-limit-test-token";

// Exercises real routing and API Token authentication, replacing only the native binding.
async function login(
  limiter: RateLimit | undefined,
  token = TOKEN,
  ip: string | null = "192.0.2.37",
  path = "/accounts/ClientLogin",
) {
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (ip !== null) headers.set("CF-Connecting-IP", ip);
  const request = new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams({ Email: "user@example.com", Passwd: token }),
  });
  const context = createExecutionContext();
  const response = await worker.fetch(
    request,
    { ...env, LOGIN_RATE_LIMITER: limiter },
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

// A real stored hash ensures limiter decisions are tested around actual authentication.
beforeEach(async () => {
  await env.DB.exec("DELETE FROM api_tokens");
  const db = getDb(env.DB);
  await db
    .insert(users)
    .values({
      id: "limiter-user",
      email: "user@example.com",
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  await db.insert(apiTokens).values({
    id: "limiter-token",
    userId: "limiter-user",
    name: "Limiter test",
    tokenHash: await sha256(TOKEN),
    createdAt: Date.now(),
  });
});

describe("ClientLogin native limiter", () => {
  it.each(["/accounts/ClientLogin", "/api/greader.php/accounts/ClientLogin"])(
    "passes the connecting IP and permits normal authentication at %s",
    async (path) => {
      const limit = vi
        .fn<RateLimit["limit"]>()
        .mockResolvedValue({ success: true });
      const response = await login({ limit }, TOKEN, "192.0.2.37", path);
      expect(limit).toHaveBeenCalledExactlyOnceWith({ key: "192.0.2.37" });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        `SID=none\nLSID=none\nAuth=${TOKEN}\n`,
      );
    },
  );

  it("uses the shared unknown key when the connecting IP header is missing", async () => {
    const limit = vi
      .fn<RateLimit["limit"]>()
      .mockResolvedValue({ success: true });
    const response = await login({ limit }, TOKEN, null);
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: "unknown" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`SID=none\nLSID=none\nAuth=${TOKEN}\n`);
  });

  it.each(["invalid", "revoked"])(
    "still rejects an %s API Token after an allow decision",
    async (kind) => {
      if (kind === "revoked") {
        await env.DB.prepare(
          "UPDATE api_tokens SET revoked_at = ? WHERE id = ?",
        )
          .bind(Date.now(), "limiter-token")
          .run();
      }
      const limit = vi
        .fn<RateLimit["limit"]>()
        .mockResolvedValue({ success: true });
      const response = await login(
        { limit },
        kind === "invalid" ? "invalid-token" : TOKEN,
      );
      expect(limit).toHaveBeenCalledExactlyOnceWith({ key: "192.0.2.37" });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("BadAuthentication");
    },
  );

  it("returns only Rate limited on a deny decision, even for a valid API Token", async () => {
    const limit = vi
      .fn<RateLimit["limit"]>()
      .mockResolvedValue({ success: false });
    const response = await login({ limit });
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: "192.0.2.37" });
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("Rate limited");
  });

  it("preserves optional-binding authentication when no limiter is supplied", async () => {
    const response = await login(undefined);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`SID=none\nLSID=none\nAuth=${TOKEN}\n`);
  });

  it("fails closed with a controlled response when the binding throws", async () => {
    const limit = vi
      .fn<RateLimit["limit"]>()
      .mockRejectedValue(new Error("sensitive platform failure"));
    const response = await login({ limit });
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: "192.0.2.37" });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Authentication unavailable");
  });
});
