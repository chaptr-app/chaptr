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

-- Phase 3A — "time-honest ratings". One row per (user, book) recording how
-- many minutes a user spent on a book before marking it Read. Aggregated
-- anonymously to surface "Avg reader finished in 6.2 hrs".
CREATE TABLE IF NOT EXISTS book_finishes (
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  total_minutes INTEGER NOT NULL,
  finished_at TEXT NOT NULL,
  PRIMARY KEY (user_id, book_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_finishes_book ON book_finishes(book_id);

-- Phase 3E — shared custom shelves. Private shelves live only in the client's
-- snapshot; friends + public are mirrored here so other users can read them.
CREATE TABLE IF NOT EXISTS custom_shelves (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  books TEXT NOT NULL,                -- JSON array of bookIds
  visibility TEXT NOT NULL DEFAULT 'public',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_shelves_owner_vis ON custom_shelves(owner_id, visibility);

-- Phase V3 — collaborative shelves. Each row is an editor on someone else's shelf.
-- The owner's row in custom_shelves still holds the source of truth.
CREATE TABLE IF NOT EXISTS shelf_members (
  shelf_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',  -- 'editor' for now
  added_at TEXT NOT NULL,
  PRIMARY KEY (shelf_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sm_user ON shelf_members(user_id);

-- Phase 4 — reading buddies. Two-person pair reads with a shared message thread.
CREATE TABLE IF NOT EXISTS pair_reads (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  inviter_id TEXT NOT NULL,
  invitee_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pair_inviter ON pair_reads(inviter_id, status);
CREATE INDEX IF NOT EXISTS idx_pair_invitee ON pair_reads(invitee_id, status);

CREATE TABLE IF NOT EXISTS pair_read_messages (
  id TEXT PRIMARY KEY,
  pair_read_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (pair_read_id) REFERENCES pair_reads(id)
);
CREATE INDEX IF NOT EXISTS idx_pr_messages_pair ON pair_read_messages(pair_read_id, created_at);

-- Phase V3 — friend challenges with leaderboard
CREATE TABLE IF NOT EXISTS friend_challenges (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                 -- 'books' | 'hours'
  target INTEGER NOT NULL,
  deadline TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fc_owner ON friend_challenges(owner_id);

CREATE TABLE IF NOT EXISTS friend_challenge_members (
  challenge_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited',   -- 'invited' | 'joined' | 'declined'
  joined_at TEXT NOT NULL,
  PRIMARY KEY (challenge_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_fcm_user ON friend_challenge_members(user_id, status);
