-- Fixtures for the isolated local browser-test database. Reseed before each test.
-- Reading receipts are relative to now so window assertions stay stable.

DELETE FROM subscriptions;
DELETE FROM item_state;
DELETE FROM items;
DELETE FROM feed_poll_attempts;
DELETE FROM cycle_runs;
DELETE FROM feeds;
INSERT INTO users (id, email, created_at) VALUES ('dev-user-id', 'dev@localhost', 0) ON CONFLICT DO NOTHING;

INSERT INTO feeds (id, feed_url, title, consecutive_errors, last_error, last_successful_poll_at, initial_backload_completed_at, check_interval_minutes)
VALUES
  ('e2e-feed-active', 'https://alpha.example.com/feed.xml', 'Alpha News', 0, NULL, unixepoch() * 1000 - 21600000, unixepoch() * 1000 - 21600000, 240),
  ('e2e-feed-failing', 'https://beta.example.com/feed.xml', 'Beta Blog', 3, 'HTTP 500', NULL, NULL, 240),
  ('e2e-feed-dead', 'https://gamma.example.com/feed.xml', 'Gamma Gazette', 0, NULL, NULL, NULL, 240),
  ('e2e-feed-limited', 'https://delta.example.com/feed.xml', 'Delta Daily', 0, NULL, unixepoch() * 1000 - 90000000, unixepoch() * 1000 - 90000000, 240),
  ('e2e-feed-paused', 'https://epsilon.example.com/feed.xml', 'Epsilon Echo', 0, NULL, unixepoch() * 1000 - 259200000, unixepoch() * 1000 - 259200000, 240);

UPDATE feeds SET deactivated_at = unixepoch() * 1000 - 604800000, deactivation_reason = 'legacy_unknown' WHERE id = 'e2e-feed-dead';
UPDATE feeds SET deactivated_at = unixepoch() * 1000 - 172800000, deactivation_reason = 'manual' WHERE id = 'e2e-feed-paused';

INSERT INTO subscriptions (id, user_id, feed_id, folder) VALUES
  ('e2e-sub-1', 'dev-user-id', 'e2e-feed-active', 'Tech'),
  ('e2e-sub-2', 'dev-user-id', 'e2e-feed-failing', NULL),
  ('e2e-sub-3', 'dev-user-id', 'e2e-feed-dead', 'Tech'),
  ('e2e-sub-4', 'dev-user-id', 'e2e-feed-limited', NULL),
  ('e2e-sub-5', 'dev-user-id', 'e2e-feed-paused', NULL);

INSERT INTO cycle_runs (id, ran_at, started_at, completed_at, checked_feeds, selected_feeds, status, outcome, trigger_reason) VALUES
  ('e2e-run-1', unixepoch() * 1000, unixepoch() * 1000 - 1000, unixepoch() * 1000, 1, 1, 'completed', 'completed', 'scheduled');

INSERT INTO feed_poll_attempts (id, feed_id, cycle_run_id, started_at, completed_at, outcome, http_status, error_class, diagnostic, parser_status, new_items) VALUES
  ('e2e-att-1', 'e2e-feed-active', 'e2e-run-1', unixepoch() * 1000 - 21600000, unixepoch() * 1000 - 21599800, 'new_items', 200, NULL, NULL, 'success', 2),
  ('e2e-att-2', 'e2e-feed-active', 'e2e-run-1', unixepoch() * 1000 - 14400000, unixepoch() * 1000 - 14399800, 'rate_limited', 429, NULL, 'HTTP 429 (rate limited)', 'not_attempted', 0),
  ('e2e-att-3', 'e2e-feed-active', 'e2e-run-1', unixepoch() * 1000 - 7200000, unixepoch() * 1000 - 7199600, 'failed', 500, 'http', 'HTTP 500', 'not_attempted', 0),
  ('e2e-att-4', 'e2e-feed-limited', 'e2e-run-1', unixepoch() * 1000 - 3600000, unixepoch() * 1000 - 3599800, 'rate_limited', 429, NULL, 'HTTP 429 (rate limited)', 'not_attempted', 0);

INSERT INTO items (id, feed_id, title, url, first_ingestion_attempt_id) VALUES
  ('e2e-item-1', 'e2e-feed-active', 'First Article', 'https://alpha.example.com/1', 'e2e-att-1'),
  ('e2e-item-2', 'e2e-feed-active', 'Second Article', 'https://alpha.example.com/2', 'e2e-att-1');

-- Alpha read 1h and 3h ago, Beta 2 days ago, Gamma 10 days ago.
-- The other User's receipt must never reach the dev User's totals.
INSERT INTO users (id, email, created_at) VALUES ('e2e-other-user', 'e2e-other@example.com', 0) ON CONFLICT DO NOTHING;
INSERT INTO subscriptions (id, user_id, feed_id, folder) VALUES
  ('e2e-sub-other', 'e2e-other-user', 'e2e-feed-active', NULL);

INSERT INTO items (id, feed_id, title, url) VALUES
  ('e2e-read-1', 'e2e-feed-active', 'Read One', 'https://alpha.example.com/r1'),
  ('e2e-read-2', 'e2e-feed-active', 'Read Two', 'https://alpha.example.com/r2'),
  ('e2e-read-3', 'e2e-feed-failing', 'Read Three', 'https://beta.example.com/r3'),
  ('e2e-read-4', 'e2e-feed-dead', 'Read Four', 'https://gamma.example.com/r4');

INSERT INTO item_state (item_id, user_id, is_read, is_starred, read_at) VALUES
  ('e2e-read-1', 'dev-user-id', 1, 1, unixepoch() * 1000 - 3600000),
  ('e2e-read-2', 'dev-user-id', 1, 0, unixepoch() * 1000 - 3 * 3600000),
  ('e2e-read-3', 'dev-user-id', 1, 0, unixepoch() * 1000 - 2 * 86400000),
  ('e2e-read-4', 'dev-user-id', 1, 0, unixepoch() * 1000 - 10 * 86400000),
  ('e2e-read-1', 'e2e-other-user', 1, 0, unixepoch() * 1000 - 3600000);
