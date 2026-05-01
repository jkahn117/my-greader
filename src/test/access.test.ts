// Access middleware tests.
// Verifies dev-mode bypass and JWT rejection paths.

import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../index";
import { getDb } from "../lib/db";
import { users } from "../db/schema";

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
});

// ---------------------------------------------------------------------------
// Dev mode bypass (DEV_MODE=true in vitest.config.ts)
// ---------------------------------------------------------------------------

describe("Access middleware (dev mode)", () => {
  it("auto-provisions dev user and grants access", async () => {
    const res = await fetch("/app/access");
    expect(res.status).toBe(200);

    // Dev user should have been created
    const db = getDb(env.DB);
    const user = await db.select().from(users).all();
    expect(user).toHaveLength(1);
    expect(user[0].id).toBe("dev-user-id");
    expect(user[0].email).toBe("dev@localhost");
  });

  it("is idempotent — multiple requests do not create duplicate users", async () => {
    await fetch("/app/access");
    await fetch("/app/access");

    const db = getDb(env.DB);
    const allUsers = await db.select().from(users).all();
    expect(allUsers).toHaveLength(1);
  });
});
