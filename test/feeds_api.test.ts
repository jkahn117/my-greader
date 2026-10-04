// Subscription workspace API tests (list, import, sync).
// Asserts status + JSON contract + persisted state through the request seam.

import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { getDb } from "../src/lib/db";
import { feeds, subscriptions, users } from "../src/db/schema";
import type {
  FeedsResponse,
  ImportResponse,
  SyncResponse,
} from "../src/shared/dashboard-api";

const BASE = "http://localhost";

async function fetchApi(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const req = new Request(`${BASE}${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedUser(id = "dev-user-id", email = "dev@localhost") {
  const db = getDb(env.DB);
  await db.insert(users).values({ id, email, createdAt: Date.now() });
}

async function seedFeedAndSub(opts: {
  userId?: string;
  feedUrl: string;
  title: string;
  folder?: string | null;
  deactivatedAt?: number | null;
  deactivatedReason?: string | null;
  consecutiveErrors?: number;
  lastStatus?: string | null;
  lastFetchedAt?: number | null;
  lastSuccessfulAt?: number | null;
}) {
  const db = getDb(env.DB);
  const feedId = crypto.randomUUID();
  await db.insert(feeds).values({
    id: feedId,
    feedUrl: opts.feedUrl,
    title: opts.title,
    htmlUrl: `https://${new URL(opts.feedUrl).hostname}`,
    deactivatedAt: opts.deactivatedAt ?? null,
    deactivatedReason: opts.deactivatedReason ?? null,
    consecutiveErrors: opts.consecutiveErrors ?? 0,
    lastStatus: opts.lastStatus ?? null,
    lastFetchedAt: opts.lastFetchedAt ?? null,
    lastSuccessfulAt: opts.lastSuccessfulAt ?? null,
    checkIntervalMinutes: 240,
  });
  await db.insert(subscriptions).values({
    id: crypto.randomUUID(),
    userId: opts.userId ?? "dev-user-id",
    feedId,
    folder: opts.folder ?? null,
  });
  return feedId;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM users");
  await seedUser();
});

describe("GET /app/api/feeds", () => {
  it("returns only the authenticated user's subscriptions", async () => {
    const mine = await seedFeedAndSub({
      feedUrl: "https://mine.example.com/feed",
      title: "Mine",
    });
    await seedUser("other-user", "other@localhost");
    await seedFeedAndSub({
      userId: "other-user",
      feedUrl: "https://theirs.example.com/feed",
      title: "Theirs",
    });

    const res = await fetchApi("/app/api/feeds");
    expect(res.status).toBe(200);
    const body = (await res.json()) as FeedsResponse;
    expect(body.feeds.map((f) => f.feedId)).toEqual([mine]);
  });

  it("classifies status and exposes separate health facts", async () => {
    const now = Date.now();
    await seedFeedAndSub({
      feedUrl: "https://ok.example.com/feed",
      title: "OK",
      lastFetchedAt: now - 30_000,
      lastSuccessfulAt: now - 30_000,
      lastStatus: "ok",
    });
    await seedFeedAndSub({
      feedUrl: "https://limited.example.com/feed",
      title: "Limited",
      lastFetchedAt: now - 30_000,
      lastStatus: "rate_limited",
    });
    await seedFeedAndSub({
      feedUrl: "https://broken.example.com/feed",
      title: "Broken",
      lastFetchedAt: now - 30_000,
      lastStatus: "error",
      consecutiveErrors: 2,
    });
    await seedFeedAndSub({
      feedUrl: "https://dead.example.com/feed",
      title: "Dead",
      deactivatedAt: now - 60_000,
      // deactivatedReason intentionally null → legacy uncertain
    });
    await seedFeedAndSub({
      feedUrl: "https://fresh.example.com/feed",
      title: "Fresh",
    });

    const res = await fetchApi("/app/api/feeds");
    const body = (await res.json()) as FeedsResponse;
    const byStatus = new Map(body.feeds.map((f) => [f.title, f]));

    expect(byStatus.get("OK")?.status).toBe("active");
    expect(byStatus.get("OK")?.lastSuccessfulAt).not.toBeNull();
    expect(byStatus.get("OK")?.nextCheckAt).not.toBeNull();
    expect(byStatus.get("Limited")?.status).toBe("rate_limited");
    expect(byStatus.get("Broken")?.status).toBe("failing");
    expect(byStatus.get("Dead")?.status).toBe("deactivated");
    expect(byStatus.get("Dead")?.legacyUncertain).toBe(true);
    expect(byStatus.get("Fresh")?.status).toBe("new");
  });

  it("reports folders for filtering", async () => {
    await seedFeedAndSub({
      feedUrl: "https://a.example.com/feed",
      title: "A",
      folder: "Tech",
    });
    const res = await fetchApi("/app/api/feeds");
    const body = (await res.json()) as FeedsResponse;
    expect(body.folders).toEqual(["Tech"]);
  });
});

describe("POST /app/api/import", () => {
  const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <body>
    <outline text="Tech">
      <outline type="rss" text="Tech Blog" xmlUrl="https://tech.example.com/feed.xml"/>
    </outline>
    <outline type="rss" text="Unfiled" xmlUrl="https://unfiled.example.com/feed.xml"/>
  </body>
</opml>`;

  it("imports feeds and counts duplicates separately", async () => {
    await seedFeedAndSub({
      feedUrl: "https://tech.example.com/feed.xml",
      title: "Tech Blog",
    });

    const form = new FormData();
    form.set("opml", new File([opml], "feeds.opml", { type: "text/xml" }));
    const res = await fetchApi("/app/api/import", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportResponse;
    expect(body).toEqual({ imported: 1, duplicates: 1, errors: [] });

    const db = getDb(env.DB);
    const subs = await db.select().from(subscriptions).all();
    expect(subs).toHaveLength(2);
    // the duplicate keeps its existing (null) folder; only the new sub gets "Tech"
    expect(subs.map((s) => s.folder).sort()).toEqual([null, null].sort());
  });

  it("rejects a missing file with a safe error", async () => {
    const res = await fetchApi("/app/api/import", {
      method: "POST",
      body: new FormData(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});

describe("feed detail + deactivation", () => {
  it("returns current-state detail for an owned feed", async () => {
    const feedId = await seedFeedAndSub({
      feedUrl: "https://ok.example.com/feed",
      title: "OK",
      lastFetchedAt: Date.now() - 30_000,
      lastSuccessfulAt: Date.now() - 30_000,
      lastStatus: "ok",
    });
    const res = await fetchApi(`/app/api/feeds/${feedId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      feedId: string;
      backloadComplete: boolean;
    };
    expect(body.feedId).toBe(feedId);
    expect(body.backloadComplete).toBe(true);
  });

  it("rejects reads and mutations for feeds the user doesn't own", async () => {
    await seedUser("other-user", "other@localhost");
    const theirs = await seedFeedAndSub({
      userId: "other-user",
      feedUrl: "https://theirs.example.com/feed",
      title: "Theirs",
    });
    for (const method of ["GET", "POST"]) {
      const res = await fetchApi(
        `/app/api/feeds/${theirs}${method === "POST" ? "/deactivate" : ""}`,
        { method },
      );
      expect(res.status, `${method}`).toBe(404);
    }
  });

  it("reports each deactivation reason plus legacy-uncertain", async () => {
    const now = Date.now();
    const cases: Array<[string | null, boolean]> = [
      ["transient", false],
      ["permanent", false],
      ["manual", false],
      [null, true], // pre-migration deactivation
    ];
    for (const [reason, legacy] of cases) {
      const feedId = await seedFeedAndSub({
        feedUrl: `https://${reason ?? "legacy"}.example.com/feed`,
        title: `R-${reason ?? "legacy"}`,
        deactivatedAt: now,
        deactivatedReason: reason,
      });
      const res = await fetchApi(`/app/api/feeds/${feedId}`);
      const body = (await res.json()) as {
        deactivatedReason: string | null;
        legacyUncertain: boolean;
      };
      expect(body.deactivatedReason).toBe(reason);
      expect(body.legacyUncertain).toBe(legacy);
    }
  });

  it("deactivates and reactivates an owned feed", async () => {
    const feedId = await seedFeedAndSub({
      feedUrl: "https://toggle.example.com/feed",
      title: "Toggle",
    });

    const off = await fetchApi(`/app/api/feeds/${feedId}/deactivate`, {
      method: "POST",
    });
    expect(off.status).toBe(200);
    const offBody = (await off.json()) as {
      deactivatedReason: string | null;
      status: string;
    };
    expect(offBody.deactivatedReason).toBe("manual");
    expect(offBody.status).toBe("deactivated");

    const on = await fetchApi(`/app/api/feeds/${feedId}/reactivate`, {
      method: "POST",
    });
    expect(on.status).toBe(200);
    const onBody = (await on.json()) as {
      deactivatedAt: number | null;
      deactivatedReason: string | null;
      consecutiveErrors: number;
    };
    expect(onBody.deactivatedAt).toBeNull();
    expect(onBody.deactivatedReason).toBeNull();
    expect(onBody.consecutiveErrors).toBe(0);
  });

  it("returns 404 when mutating a nonexistent feed", async () => {
    const res = await fetchApi(`/app/api/feeds/nope/deactivate`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /app/api/feeds/sync", () => {
  it("normal sync respects due-time eligibility", async () => {
    const now = Date.now();
    // checked a minute ago with a 4h interval — not due
    await seedFeedAndSub({
      feedUrl: "https://recent.example.com/feed",
      title: "Recent",
      lastFetchedAt: now - 60_000,
      lastSuccessfulAt: now - 60_000,
    });

    const res = await fetchApi("/app/api/feeds/sync", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncResponse;
    expect(body.triggered).toBe(true);
    expect(body.forced).toBe(false);
    expect(body.eligible).toBe(0);
  });

  it("forced sync bypasses due time but still excludes deactivated feeds", async () => {
    const now = Date.now();
    await seedFeedAndSub({
      feedUrl: "https://recent.example.com/feed",
      title: "Recent",
      lastFetchedAt: now - 60_000,
      lastSuccessfulAt: now - 60_000,
    });
    await seedFeedAndSub({
      feedUrl: "https://dead.example.com/feed",
      title: "Dead",
      deactivatedAt: now - 60_000,
      deactivatedReason: "manual",
    });
    // feed with no subscriber — never eligible
    await getDb(env.DB).insert(feeds).values({
      id: crypto.randomUUID(),
      feedUrl: "https://orphan.example.com/feed",
      title: "Orphan",
    });

    const res = await fetchApi("/app/api/feeds/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncResponse;
    expect(body.triggered).toBe(true);
    expect(body.forced).toBe(true);
    expect(body.eligible).toBe(1); // only the active subscribed feed
  });

  it("rejects a malformed body", async () => {
    const res = await fetchApi("/app/api/feeds/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});
