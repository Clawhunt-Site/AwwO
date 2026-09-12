-- Stored file deliverables. A `file` output field used to be a bare reference string, which
-- promised a file without ever holding one; an artifact row is the actual retrievable bytes.
--
-- Ownership: every artifact belongs to exactly one tenant and canvas, enforced by the composite
-- foreign key, so a download can be authorized by tenant membership alone and can never be read
-- across tenants. `run_id`/`node_id`/`field_id` record which run produced it (provenance only,
-- no foreign key, so settling a run never has to rewrite artifact rows).
--
-- Retention: artifacts are deleted with their canvas (ON DELETE CASCADE) and therefore with their
-- tenant. There is no independent lifetime to leak or to garbage-collect separately.
CREATE TABLE artifacts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  canvas_id text NOT NULL,
  run_id text NOT NULL DEFAULT '',
  node_id text NOT NULL DEFAULT '',
  field_id text NOT NULL DEFAULT '',
  name text NOT NULL,
  size integer NOT NULL CHECK(size >= 0),
  sha256 text NOT NULL,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,canvas_id) REFERENCES canvases(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,id)
);
CREATE INDEX artifacts_canvas ON artifacts(tenant_id,canvas_id,created_at DESC);
