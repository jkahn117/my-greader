-- Supplement the normal Feed fixture with an invalid URL accepted by older clients.
INSERT INTO feeds (id, feed_url) VALUES ('e2e-feed-invalid', 'example.com/feed');
INSERT INTO subscriptions (id, user_id, feed_id)
VALUES ('e2e-sub-invalid', 'dev-user-id', 'e2e-feed-invalid');
