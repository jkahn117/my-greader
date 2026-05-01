// Token management UI handler tests.
// Tests run against the real Worker + in-memory D1 via @cloudflare/vitest-pool-workers.
// Access middleware is bypassed via DEV_MODE=true (set in vitest.config.ts).

import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../index";
import { getDb } from "../lib/db";
import { apiTokens, users } from "../db/schema";
import { sha256 } from "../lib/crypto";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://localhost";

async function fetch(path: string, init: RequestInit = {}): Promise<Response> {
  const req = new Request(`${BASE}${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ---------------------------------------------------------------------------
// Reset DB between tests
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await env.DB.exec("DELETE FROM api_tokens");
  await env.DB.exec("DELETE FROM users");

  const db = getDb(env.DB);
  await db
    .insert(users)
    .values({ id: "dev-user-id", email: "dev@localhost", createdAt: Date.now() });
});

// ---------------------------------------------------------------------------
// GET /app/access — token list page
// ---------------------------------------------------------------------------

describe("GET /app/access", () => {
  it("returns 200 with HTML", async () => {
    const res = await fetch("/app/access");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("shows existing tokens", async () => {
    const db = getDb(env.DB);
    await db.insert(apiTokens).values({
      id: "tok-1",
      userId: "dev-user-id",
      name: "My Test Token",
      tokenHash: await sha256("dummy"),
      createdAt: Date.now(),
    });

    const res = await fetch("/app/access");
    const html = await res.text();
    expect(html).toContain("My Test Token");
  });

  it("does not show revoked tokens", async () => {
    const db = getDb(env.DB);
    await db.insert(apiTokens).values({
      id: "tok-revoked",
      userId: "dev-user-id",
      name: "Revoked Token",
      tokenHash: await sha256("revoked"),
      createdAt: Date.now(),
      revokedAt: Date.now(),
    });

    const res = await fetch("/app/access");
    const html = await res.text();
    expect(html).not.toContain("Revoked Token");
  });
});

// ---------------------------------------------------------------------------
// POST /tokens/generate
// ---------------------------------------------------------------------------

describe("POST /tokens/generate", () => {
  it("creates a new token and returns reveal HTML", async () => {
    const res = await fetch("/tokens/generate", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Current on iPhone" }).toString(),
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    // The reveal fragment should contain a 64-char hex token
    expect(html).toMatch(/[0-9a-f]{64}/);

    // Verify token was stored in DB
    const db = getDb(env.DB);
    const tokens = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, "dev-user-id"))
      .all();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].name).toBe("Current on iPhone");
    expect(tokens[0].revokedAt).toBeNull();
  });

  it("rejects empty name", async () => {
    const res = await fetch("/tokens/generate", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "" }).toString(),
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("required");

    // No token should have been created
    const db = getDb(env.DB);
    const tokens = await db.select().from(apiTokens).all();
    expect(tokens).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DELETE /tokens/:id — revoke
// ---------------------------------------------------------------------------

describe("DELETE /tokens/:id", () => {
  it("revokes a token by setting revokedAt", async () => {
    const db = getDb(env.DB);
    await db.insert(apiTokens).values({
      id: "tok-to-revoke",
      userId: "dev-user-id",
      name: "Temp Token",
      tokenHash: await sha256("temp"),
      createdAt: Date.now(),
    });

    const res = await fetch("/tokens/tok-to-revoke", { method: "DELETE" });
    expect(res.status).toBe(200);

    // Verify revokedAt is set
    const row = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, "tok-to-revoke"))
      .get();
    expect(row).toBeTruthy();
    expect(row!.revokedAt).not.toBeNull();
  });

  it("does not revoke another user's token", async () => {
    // Seed another user and their token
    const db = getDb(env.DB);
    await db
      .insert(users)
      .values({ id: "other-user", email: "other@example.com", createdAt: Date.now() });
    await db.insert(apiTokens).values({
      id: "other-tok",
      userId: "other-user",
      name: "Other Token",
      tokenHash: await sha256("other"),
      createdAt: Date.now(),
    });

    // Try to revoke as dev-user-id (should have no effect)
    await fetch("/tokens/other-tok", { method: "DELETE" });

    const row = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, "other-tok"))
      .get();
    expect(row!.revokedAt).toBeNull();
  });
});
