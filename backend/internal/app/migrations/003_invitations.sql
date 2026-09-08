CREATE TABLE tenant_invites (
 id text PRIMARY KEY,
 tenant_id text NOT NULL REFERENCES tenants(id),
 created_by text NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK (role IN ('reader','member','admin')),
 token_hash text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 accepted_by text REFERENCES users(id),
 accepted_at timestamptz,
 CHECK ((accepted_by IS NULL) = (accepted_at IS NULL)),
 CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX tenant_invites_tenant_time ON tenant_invites(tenant_id,created_at DESC,id DESC);
