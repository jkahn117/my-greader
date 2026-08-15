import { Hono } from "hono";
import { createLogger } from "../lib/logger";
import { parseOpml } from "../lib/opml";
import { triggerFeedPollingWorkflow } from "./cron";
import {
  createSubscriptionLifecycle,
  type SubObserver,
} from "../feed/subscriptions";
import { ImportResult } from "../views/import";
import { SubscriptionListContent } from "../views/feeds";

import type { Variables } from "../types/context";

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

  const noop: SubObserver = { publish: () => {} };
  const lifecycle = createSubscriptionLifecycle(c.env.DB, noop);

  let imported = 0;
  let duplicates = 0;
  const errors: string[] = [];
  let newFeeds = 0;

  for (const parsed of parsedList) {
    try {
      const result = await lifecycle.subscribe(userId, parsed.feedUrl, {
        title: parsed.title ?? undefined,
        folder: parsed.folder ?? undefined,
        feedTitle: parsed.title ?? undefined,
        feedHtmlUrl: parsed.htmlUrl ?? undefined,
      });
      if (result.created) {
        imported++;
        newFeeds++;
      } else {
        duplicates++;
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
  if (newFeeds > 0) {
    c.executionCtx.waitUntil(triggerFeedPollingWorkflow(c.env));
  }

  // Re-query the updated subscription list for OOB swap
  const updatedSubs = await lifecycle.list(userId);

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
