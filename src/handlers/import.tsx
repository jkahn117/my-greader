import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import { parseOpml } from "../lib/opml";
import { fetchAndStoreFeed, triggerFeedPollingWorkflow } from "./cron";
import { feeds, subscriptions } from "../db/schema";
import { selectUserSubscriptions } from "../db/queries";
import { ImportResult } from "../views/import";
import { SubscriptionListContent } from "../views/feeds";

type Variables = { userId: string; email: string };

const handler = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /import — parse an OPML upload and bulk-subscribe
// ---------------------------------------------------------------------------

handler.post("/import", async (c) => {
  const userId = c.get("userId");
  const logger = createLogger({ path: "/import", userId });

  // Parse multipart upload
  const body = await c.req.parseBody();
  const file = body["opml"];

  if (!file || typeof file === "string") {
    return c.html(
      <p class="text-sm text-destructive">Please upload an OPML file.</p>,
    );
  }

  const xml = await (file as File).text();
  const parsedList = parseOpml(xml);

  if (parsedList.length === 0) {
    return c.html(
      <p class="text-sm text-destructive">
        No feeds found in the uploaded file.
      </p>,
    );
  }

  const db = getDb(c.env.DB);

  let imported = 0;
  let duplicates = 0;
  const errors: string[] = [];
  const newFeedRows: Parameters<typeof fetchAndStoreFeed>[0][] = [];

  for (const parsed of parsedList) {
    try {
      // Upsert the canonical feed row (shared across all users)
      await db
        .insert(feeds)
        .values({
          id: crypto.randomUUID(),
          feedUrl: parsed.feedUrl,
          title: parsed.title,
          htmlUrl: parsed.htmlUrl,
        })
        .onConflictDoNothing();

      const feed = await db
        .select()
        .from(feeds)
        .where(eq(feeds.feedUrl, parsed.feedUrl))
        .get();

      if (!feed) {
        // Should not happen, but guards the type narrowing below
        errors.push(parsed.feedUrl);
        continue;
      }

      // Check for an existing subscription for this user + feed,
      // create if one does not exist
      const result = await db
        .insert(subscriptions)
        .values({
          id: crypto.randomUUID(),
          userId,
          feedId: feed.id,
          title: parsed.title,
          folder: parsed.folder,
        })
        .onConflictDoNothing();

      if (result.meta.changes === 0) {
        duplicates++;
      } else {
        imported++;
        newFeedRows.push(feed);
      }
    } catch (err) {
      logger.error("error importing feed", {
        feedUrl: parsed.feedUrl,
        err: String(err),
      });
      errors.push(parsed.feedUrl);
    }
  }

  logger.info("OPML import complete", {
    imported,
    duplicates,
    errors: errors.length,
  });

  // Immediately fetch each newly added feed using workflow
  if (newFeedRows.length > 0) {
    c.executionCtx.waitUntil(triggerFeedPollingWorkflow(c.env));
  }

  // Re-query the updated subscription list for OOB swap
  const updatedSubs = await selectUserSubscriptions(db, userId);

  // Return the import summary + OOB update that refreshes the subscription table
  return c.html(
    <>
      <ImportResult
        imported={imported}
        duplicates={duplicates}
        errors={errors}
      />
      <SubscriptionListContent subs={updatedSubs} oob />
    </>,
  );
});

export { handler as importHandler };
