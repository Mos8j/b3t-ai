-- Login sessions. Only a keyed hash of each session token is stored, never the token itself.
CREATE TABLE user_session (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX user_session_user ON user_session (user_id);
ALTER TABLE app_user ADD COLUMN disabled_at timestamptz;
