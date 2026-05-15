-- Chaptr V2 — Phase 1A snapshot-sync schema.
-- Run with: npx wrangler d1 execute chaptr-db --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT,
  display_name TEXT,
  avatar_hue INTEGER,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;

-- Phase 2B — directed follow graph. (follower_id) follows (followee_id).
CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL,
  followee_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  FOREIGN KEY (follower_id) REFERENCES users(id),
  FOREIGN KEY (followee_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

CREATE TABLE IF NOT EXISTS snapshots (
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);

-- Phase 2A — first cross-user table. Reviews can be private, friends-only,
-- or public. Public reviews are readable without auth; private are scoped
-- to the author.
CREATE TABLE IF NOT EXISTS reviews (
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  rating REAL,
  text TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, book_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_book_public ON reviews(book_id, visibility);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id, updated_at DESC);
