-- Migration 005: product analytics events table
-- Run with: wrangler d1 execute chaptr-db --remote --file=worker/migrations/005_events.sql

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  device_id TEXT,
  name TEXT NOT NULL,
  props TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name_date ON events(name, created_at);
CREATE INDEX IF NOT EXISTS idx_events_user_date ON events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_device_date ON events(device_id, created_at);
