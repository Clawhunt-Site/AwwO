CREATE TABLE user_connections (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider text NOT NULL,
 runtime text NOT NULL CHECK(runtime IN ('pi','openai-agents')),
 name text NOT NULL,
 secret bytea NOT NULL,
 models jsonb NOT NULL CHECK(jsonb_typeof(models)='array'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_connections_owner ON user_connections(user_id,created_at);
ALTER TABLE auth_sessions ADD COLUMN id text NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text);
CREATE UNIQUE INDEX auth_sessions_id ON auth_sessions(id);
CREATE TABLE password_resets (
 token_hash text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_owner ON password_resets(user_id);
