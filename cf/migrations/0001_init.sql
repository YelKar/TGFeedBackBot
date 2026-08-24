CREATE TABLE IF NOT EXISTS post (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  admin_msg_id INTEGER,
  publish_at INTEGER,
  sequence_number INTEGER
);

CREATE INDEX IF NOT EXISTS idx_post_admin_msg ON post (admin_msg_id);
CREATE INDEX IF NOT EXISTS idx_post_status_publish ON post (status, publish_at);
CREATE INDEX IF NOT EXISTS idx_post_user_created ON post (user_id, created_at);

CREATE TABLE IF NOT EXISTS vote (
  post_id TEXT NOT NULL,
  admin_id INTEGER NOT NULL,
  admin_username TEXT,
  vote INTEGER NOT NULL,
  PRIMARY KEY (post_id, admin_id)
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocked_user (
  id INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS dialogue (
  user_msg_id INTEGER PRIMARY KEY,
  admin_msg_id INTEGER NOT NULL,
  post_id TEXT NOT NULL
);
