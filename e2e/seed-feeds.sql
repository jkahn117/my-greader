-- Seed data for the feeds-workspace browser tests.
-- Deterministic: wipes rows belonging to the dev user first.

DELETE FROM subscriptions WHERE user_id = 'dev-user-id';
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
