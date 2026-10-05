-- Seed data for the feeds-workspace and reading browser tests.
-- Deterministic: wipes rows belonging to the dev user first. Reading
-- receipts are relative to now so window assertions stay stable.

DELETE FROM subscriptions WHERE user_id = 'dev-user-id' OR id LIKE 'e2e-%';
DELETE FROM item_state WHERE user_id = 'dev-user-id' OR item_id LIKE 'e2e-%';
DELETE FROM cycle_runs;
DELETE FROM feed_attempts WHERE feed_id LIKE 'e2e-%';
DELETE FROM items WHERE feed_id LIKE 'e2e-%';
DELETE FROM feeds WHERE id LIKE 'e2e-%';
INSERT OR REPLACE INTO users (id, email, created_at) VALUES ('dev-user-id', 'dev@localhost', 0);

INSERT INTO feeds (id, feed_url, title, consecutive_errors, last_status, last_fetched_at, last_successful_at, check_interval_minutes)
VALUES
  ('e2e-feed-active', 'https://alpha.example.com/feed.xml', 'Alpha News', 0, 'ok', 1000, 1000, 240),
  ('e2e-feed-failing', 'https://beta.example.com/feed.xml', 'Beta Blog', 3, 'error', 1000, NULL, 240),
  ('e2e-feed-dead', 'https://gamma.example.com/feed.xml', 'Gamma Gazette', 0, NULL, NULL, NULL, 240);

UPDATE feeds SET deactivated_at = 2000 WHERE id = 'e2e-feed-dead';

INSERT INTO subscriptions (id, user_id, feed_id, folder) VALUES
  ('e2e-sub-1', 'dev-user-id', 'e2e-feed-active', 'Tech'),
  ('e2e-sub-2', 'dev-user-id', 'e2e-feed-failing', NULL),
  ('e2e-sub-3', 'dev-user-id', 'e2e-feed-dead', 'Tech');

INSERT INTO feed_attempts (id, feed_id, cycle_run_id, started_at, finished_at, status, http_status, error_kind, error_message, parser_state, items_added, duration_ms) VALUES
  ('e2e-att-1', 'e2e-feed-active', 'run-1', 1000, 1200, 'ok', 200, NULL, NULL, 'success', 2, 200),
  ('e2e-att-2', 'e2e-feed-active', 'run-1', 2000, 2300, 'rate_limited', 429, NULL, 'HTTP 429 (rate limited)', 'not_attempted', NULL, 300),
  ('e2e-att-3', 'e2e-feed-active', 'run-2', 3000, 3400, 'error', 500, 'http', 'HTTP 500', 'not_attempted', NULL, 400);

INSERT OR REPLACE INTO items (id, feed_id, title, url, attempt_id) VALUES
  ('e2e-item-1', 'e2e-feed-active', 'First Article', 'https://alpha.example.com/1', 'e2e-att-1'),
  ('e2e-item-2', 'e2e-feed-active', 'Second Article', 'https://alpha.example.com/2', 'e2e-att-1');

INSERT INTO cycle_runs (id, ran_at, checked_feeds) VALUES
  ('e2e-run-1', unixepoch() * 1000, 3);

-- Reading fixtures: Alpha read 1h and 3h ago, Beta 2 days ago, Gamma
-- (deactivated) 10 days ago — outside 7d, inside 14d. The other user's
-- receipt on an Alpha item must never reach the dev user's totals.
INSERT OR REPLACE INTO users (id, email, created_at) VALUES ('e2e-other-user', 'e2e-other@example.com', 0);
INSERT INTO subscriptions (id, user_id, feed_id, folder) VALUES
  ('e2e-sub-other', 'e2e-other-user', 'e2e-feed-active', NULL);

INSERT OR REPLACE INTO items (id, feed_id, title, url) VALUES
  ('e2e-read-1', 'e2e-feed-active', 'Read One', 'https://alpha.example.com/r1'),
  ('e2e-read-2', 'e2e-feed-active', 'Read Two', 'https://alpha.example.com/r2'),
  ('e2e-read-3', 'e2e-feed-failing', 'Read Three', 'https://beta.example.com/r3'),
  ('e2e-read-4', 'e2e-feed-dead', 'Read Four', 'https://gamma.example.com/r4');

INSERT OR REPLACE INTO item_state (item_id, user_id, is_read, is_starred, read_at) VALUES
  ('e2e-read-1', 'dev-user-id', 1, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 3600000),
  ('e2e-read-2', 'dev-user-id', 1, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 3 * 3600000),
  ('e2e-read-3', 'dev-user-id', 1, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2 * 86400000),
  ('e2e-read-4', 'dev-user-id', 1, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 10 * 86400000),
  ('e2e-read-1', 'e2e-other-user', 1, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 3600000);
