-- Workspace skills (skills.go): reusable method guidance a member writes or imports as a SKILL.md file and attaches
-- to canvas nodes. Built-in skills ship in the binary and have no rows. A skill row holds its current text; every
-- version is also kept in tenant_skill_revisions, so a run's frozen copy can always be traced to the text it cited.
-- Archiving keeps both (runs cite them); a deleted workspace removes them with it.
--
-- Two new tables and no change to existing ones; the short lock timeout makes a busy deploy fail visibly instead of
-- queueing every query behind it.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS tenant_skills (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64 AND name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  category text NOT NULL,
  applies text[] NOT NULL DEFAULT '{}',
  body text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 12288),
  content_hash text NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  archived boolean NOT NULL DEFAULT false,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_skills_live_name ON tenant_skills(tenant_id, name) WHERE NOT archived;
CREATE TABLE IF NOT EXISTS tenant_skill_revisions (
  tenant_id text NOT NULL,
  skill_id text NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  title text NOT NULL,
  description text NOT NULL,
  body text NOT NULL,
  content_hash text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, skill_id, version),
  FOREIGN KEY (tenant_id, skill_id) REFERENCES tenant_skills(tenant_id, id) ON DELETE CASCADE
);
