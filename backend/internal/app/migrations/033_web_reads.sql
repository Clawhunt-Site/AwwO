-- Web reads (webread_import.go): every "import from a web address" a member starts, kept for the daily allowance and
-- the audit trail. The address itself is kept only as a digest and its host; the page's text, its final address and
-- its provenance live in the knowledge source the read created (document_id).
--
-- A read is recorded before anything is fetched (status started) and settled after (ok or failed), so a failed or
-- refused read still counts: retrying cannot be used to probe sites for free. operation_id is the request's own
-- operation: a second request with it while the first is still reading is refused instead of fetching again. An API
-- restart fails what was still started (error_code interrupted).
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS web_reads (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id text,
  operation_id text NOT NULL,
  url_hash text NOT NULL,
  host text NOT NULL,
  status text NOT NULL CHECK (status IN ('started','ok','failed')),
  error_code text,
  bytes bigint,
  document_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS web_reads_tenant_day ON web_reads(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS web_reads_day ON web_reads(created_at);
CREATE INDEX IF NOT EXISTS web_reads_operation ON web_reads(tenant_id, operation_id);
