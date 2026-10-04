// Access-page JSON API tests — /app/api/tokens backed by D1.
// Covers generation, one-time raw token exposure, User isolation, hourly
// coarse last-use, revocation, and safe failures at the Worker request seam.

import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import worker from "../src/index";
import { getDb } from "../src/lib/db";
import { sha256 } from "../src/lib/crypto";
import { apiTokens, users } from "../src/db/schema";
import type {
  GenerateTokenResponse,
  RevokeTokenResponse,
  TokensResponse,
} from "../src/shared/dashboard-api";

const BASE = "http://localhost";
const HOUR_MS = 3_600_000;

async function fetch(path: string, init: RequestInit = {}): Promise<Response> {
  const req = new Request(`${BASE}${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function generate(body: unknown) {
  return fetch("/app/api/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function seedToken(opts: {
  id: string;
  userId?: string;
  name: string;
  raw?: string;
  lastUsedAt?: number | null;
  revokedAt?: number | null;
}) {
  await getDb(env.DB)
    .insert(apiTokens)
    .values({
      id: opts.id,
      userId: opts.userId ?? "dev-user-id",
      name: opts.name,
      tokenHash: await sha256(opts.raw ?? opts.id),
      createdAt: Date.now(),
      lastUsedAt: opts.lastUsedAt ?? null,
      revokedAt: opts.revokedAt ?? null,
    });
}

async function tokenRow(id: string) {
  return getDb(env.DB)
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.id, id))
    .get();
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM api_tokens");
  await env.DB.exec("DELETE FROM users");
  const db = getDb(env.DB);
  await db.insert(users).values([
    { id: "dev-user-id", email: "dev@localhost", createdAt: Date.now() },
    { id: "other-user", email: "other@example.com", createdAt: Date.now() },
  ]);
});

describe("GET /app/api/tokens", () => {
  it("lists only the User's tokens with state, never hashes", async () => {
    await seedToken({ id: "tok-a", name: "Phone", lastUsedAt: 1000 });
    await seedToken({ id: "tok-b", name: "Old", revokedAt: 2000 });
    await seedToken({ id: "tok-x", userId: "other-user", name: "Theirs" });

    const res = await fetch("/app/api/tokens");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(await sha256("tok-a"));
    expect(text).not.toMatch(/tokenHash|token_hash|rawToken/);

    const body = JSON.parse(text) as TokensResponse;
    expect(body.tokens.map((t) => t.name).sort()).toEqual(["Old", "Phone"]);
    const phone = body.tokens.find((t) => t.id === "tok-a")!;
    expect(phone.lastUsedAt).toBe(1000);
    expect(phone.revokedAt).toBeNull();
    expect(body.tokens.find((t) => t.id === "tok-b")!.revokedAt).toBe(2000);
    expect(body.lastUsedResolutionMinutes).toBe(60);
  });

  it("includes FreshRSS connection instructions for this deployment", async () => {
    const body = (await (
      await fetch("/app/api/tokens")
    ).json()) as TokensResponse;
    expect(body.connection).toEqual({
      mode: "FreshRSS",
      serverUrl: "http://localhost",
      username: "dev@localhost",
    });
  });
});

describe("POST /app/api/tokens", () => {
  it("returns the raw token once and stores only its hash", async () => {
    const res = await generate({ name: "  Current on iPhone  " });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as GenerateTokenResponse;
    expect(body.rawToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.token.name).toBe("Current on iPhone");
    expect(body.token).not.toHaveProperty("tokenHash");

    const row = await tokenRow(body.token.id);
    expect(row!.userId).toBe("dev-user-id");
    expect(row!.tokenHash).toBe(await sha256(body.rawToken));
    expect(row!.tokenHash).not.toBe(body.rawToken);

    // Subsequent reads never redisplay the raw value
    const listText = await (await fetch("/app/api/tokens")).text();
    expect(listText).toContain("Current on iPhone");
    expect(listText).not.toContain(body.rawToken);
    expect(listText).not.toContain(row!.tokenHash);
  });

  it("never writes the raw token to logs", async () => {
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) =>
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
          lines.push(args.map((a) => String(a)).join(" "));
        }),
    );
    try {
      const { rawToken } = (await (
        await generate({ name: "Logged" })
      ).json()) as GenerateTokenResponse;
      await fetch("/app/api/tokens");
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).not.toContain(rawToken);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("generated token authenticates GReader requests", async () => {
    const { rawToken } = (await (
      await generate({ name: "Reader" })
    ).json()) as GenerateTokenResponse;
    const info = await fetch("/reader/api/0/user-info", {
      headers: { Authorization: `GoogleLogin auth=${rawToken}` },
    });
    expect(info.status).toBe(200);
  });

  it.each([
    ["empty name", { name: "" }],
    ["whitespace name", { name: "   " }],
    ["too long name", { name: "x".repeat(101) }],
    ["missing name", {}],
    ["non-string name", { name: 42 }],
    ["malformed JSON", "{not json"],
  ])("rejects %s with a safe 400 and creates nothing", async (_, body) => {
    const res = await generate(body);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(JSON.parse(text)).toEqual({
      error: "name is required (max 100 characters)",
    });
    const rows = await getDb(env.DB).select().from(apiTokens).all();
    expect(rows).toHaveLength(0);
  });
});

describe("DELETE /app/api/tokens/:id", () => {
  it("revokes only the targeted token", async () => {
    await seedToken({ id: "tok-1", name: "One", raw: "raw-one" });
    await seedToken({ id: "tok-2", name: "Two", raw: "raw-two" });

    const res = await fetch("/app/api/tokens/tok-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RevokeTokenResponse;
    expect(body.token.id).toBe("tok-1");
    expect(body.token.revokedAt).not.toBeNull();
    expect(body.token).not.toHaveProperty("tokenHash");

    expect((await tokenRow("tok-1"))!.revokedAt).not.toBeNull();
    expect((await tokenRow("tok-2"))!.revokedAt).toBeNull();

    const revoked = await fetch("/reader/api/0/user-info", {
      headers: { Authorization: "GoogleLogin auth=raw-one" },
    });
    expect(revoked.status).toBe(401);
    const other = await fetch("/reader/api/0/user-info", {
      headers: { Authorization: "GoogleLogin auth=raw-two" },
    });
    expect(other.status).toBe(200);
  });

  it("returns 404 for another User's token and leaves it active", async () => {
    await seedToken({ id: "tok-x", userId: "other-user", name: "Theirs" });
    const res = await fetch("/app/api/tokens/tok-x", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "token not found" });
    expect((await tokenRow("tok-x"))!.revokedAt).toBeNull();
  });

  it("returns 404 for an unknown token", async () => {
    const res = await fetch("/app/api/tokens/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("keeps the original revocation time when revoked again", async () => {
    await seedToken({ id: "tok-r", name: "Gone", revokedAt: 5000 });
    const res = await fetch("/app/api/tokens/tok-r", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await tokenRow("tok-r"))!.revokedAt).toBe(5000);
  });
});

describe("coarse last-used tracking", () => {
  async function useToken(raw: string) {
    const res = await fetch("/reader/api/0/user-info", {
      headers: { Authorization: `GoogleLogin auth=${raw}` },
    });
    expect(res.status).toBe(200);
  }

  it("records first use, then refreshes at most hourly", async () => {
    await seedToken({ id: "tok-u", name: "Use", raw: "raw-use" });

    await useToken("raw-use");
    const first = (await tokenRow("tok-u"))!.lastUsedAt;
    expect(first).not.toBeNull();

    // Within the hour: no rewrite
    const recent = Date.now() - 10 * 60_000;
    await getDb(env.DB)
      .update(apiTokens)
      .set({ lastUsedAt: recent })
      .where(eq(apiTokens.id, "tok-u"));
    await useToken("raw-use");
    expect((await tokenRow("tok-u"))!.lastUsedAt).toBe(recent);

    // Older than an hour: refreshed
    const stale = Date.now() - 2 * HOUR_MS;
    await getDb(env.DB)
      .update(apiTokens)
      .set({ lastUsedAt: stale })
      .where(eq(apiTokens.id, "tok-u"));
    await useToken("raw-use");
    expect((await tokenRow("tok-u"))!.lastUsedAt).toBeGreaterThan(stale);

    const list = (await (
      await fetch("/app/api/tokens")
    ).json()) as TokensResponse;
    expect(list.tokens[0].lastUsedAt).toBeGreaterThan(stale);
  });
});
