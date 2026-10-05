-- Seed data for the Access (API token) browser tests.
-- Deterministic: wipes the dev user's tokens first; touches only api_tokens.

INSERT OR REPLACE INTO users (id, email, created_at) VALUES ('dev-user-id', 'dev@localhost', 0);
DELETE FROM api_tokens WHERE user_id = 'dev-user-id';

INSERT INTO api_tokens (id, user_id, name, token_hash, created_at, last_used_at, revoked_at) VALUES
  ('e2e-tok-keep', 'dev-user-id', 'Seeded Keeper', 'e2e-hash-keep', 1000, NULL, NULL),
  ('e2e-tok-drop', 'dev-user-id', 'Seeded Doomed', 'e2e-hash-drop', 2000, 3000, NULL),
  ('e2e-tok-old', 'dev-user-id', 'Seeded Retired', 'e2e-hash-old', 500, NULL, 900);
