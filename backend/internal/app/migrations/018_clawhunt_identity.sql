CREATE TABLE external_identities (
 issuer text NOT NULL, subject text NOT NULL,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(issuer,subject), UNIQUE(issuer,user_id)
);
CREATE TABLE identity_flows (
 state_hash text PRIMARY KEY, browser_hash text NOT NULL,
 verifier text NOT NULL DEFAULT '',
 invite text NOT NULL DEFAULT '',
 identity jsonb, grant_secret bytea,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_flows_expiry ON identity_flows(expires_at);
ALTER TABLE auth_sessions ADD COLUMN sso_issuer text;
ALTER TABLE auth_sessions ADD COLUMN sso_subject text;
ALTER TABLE auth_sessions ADD COLUMN sso_grant bytea;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_sso_complete CHECK (
 (sso_issuer IS NULL AND sso_subject IS NULL AND sso_grant IS NULL) OR
 (sso_issuer IS NOT NULL AND sso_subject IS NOT NULL AND sso_grant IS NOT NULL)
);
