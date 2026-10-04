-- Seed data for the feeds-workspace browser tests.
-- Deterministic: wipes rows belonging to the dev user first.

DELETE FROM subscriptions WHERE user_id = 'dev-user-id';
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
