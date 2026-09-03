ALTER TABLE post ADD COLUMN media TEXT;

CREATE TABLE IF NOT EXISTS media_group_items (
  group_id TEXT NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  file_id TEXT NOT NULL,
  caption TEXT,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_group_items ON media_group_items (group_id);
