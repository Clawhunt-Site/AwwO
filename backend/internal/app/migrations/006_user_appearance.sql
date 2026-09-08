-- Account preferences belong to the authenticated user across their workspaces.
CREATE TABLE IF NOT EXISTS user_appearance (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_preset text NOT NULL,
  custom jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0)
);
