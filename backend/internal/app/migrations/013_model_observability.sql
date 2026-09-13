-- A canvas/run deletion must not erase the tenant's accounting history. The
-- immutable run_id remains a logical audit reference after the business object
-- is deleted; admission validates and locks the live tenant/run before insert.
ALTER TABLE model_invocations DROP CONSTRAINT model_invocations_tenant_id_run_id_fkey;
ALTER TABLE model_invocations ADD CONSTRAINT model_invocations_tenant_id_fkey
 FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE model_invocations
 ADD COLUMN turn_id text,
 ADD COLUMN agent_id text,
 ADD COLUMN runtime text NOT NULL DEFAULT 'pi' CHECK(runtime IN ('pi','openai-agents')),
 ADD COLUMN provider text NOT NULL DEFAULT '',
 ADD COLUMN model_id text NOT NULL DEFAULT '',
 ADD COLUMN provider_model text NOT NULL DEFAULT '',
 ADD COLUMN protocol text NOT NULL DEFAULT '',
 ADD COLUMN admission_status text NOT NULL DEFAULT 'unknown' CHECK(admission_status IN ('not_attempted','rejected_before_start','accepted','unknown')),
 ADD COLUMN admitted_at timestamptz,
 ADD COLUMN completed_at timestamptz,
 ADD COLUMN usage_status text NOT NULL DEFAULT 'unavailable' CHECK(usage_status IN ('reported','partial','unavailable','invalid','unknown')),
 ADD COLUMN usage_source text NOT NULL DEFAULT 'none' CHECK(usage_source IN ('provider_raw','sdk_normalized','none')),
 ADD COLUMN observability_version integer CHECK(observability_version >= 0),
 ADD COLUMN usage_reason text NOT NULL DEFAULT 'legacy_worker' CHECK(usage_reason IN ('none','legacy_worker','provider_missing','field_missing','transport_unknown','worker_lost','cancelled_after_admission','protocol_invalid','total_mismatch')),
 ADD COLUMN input_tokens bigint CHECK(input_tokens BETWEEN 0 AND 9007199254740991),
 ADD COLUMN output_tokens bigint CHECK(output_tokens BETWEEN 0 AND 9007199254740991),
 ADD COLUMN cached_input_tokens bigint CHECK(cached_input_tokens BETWEEN 0 AND 9007199254740991),
 ADD COLUMN cache_write_tokens bigint CHECK(cache_write_tokens BETWEEN 0 AND 9007199254740991),
 ADD COLUMN reasoning_tokens bigint CHECK(reasoning_tokens BETWEEN 0 AND 9007199254740991),
 ADD COLUMN provider_total_tokens bigint CHECK(provider_total_tokens BETWEEN 0 AND 9007199254740991),
 ADD COLUMN computed_total_tokens bigint CHECK(computed_total_tokens BETWEEN 0 AND 9007199254740991),
 ADD COLUMN queue_ms bigint CHECK(queue_ms >= 0),
 ADD COLUMN admission_ms bigint CHECK(admission_ms >= 0),
 ADD COLUMN setup_ms bigint CHECK(setup_ms >= 0),
 ADD COLUMN provider_ms bigint CHECK(provider_ms >= 0),
 ADD COLUMN provider_ttft_ms bigint CHECK(provider_ttft_ms >= 0),
 ADD COLUMN worker_total_ms bigint CHECK(worker_total_ms >= 0),
 ADD COLUMN worker_first_delta_ms bigint CHECK(worker_first_delta_ms >= 0),
 ADD COLUMN pricing_version text NOT NULL DEFAULT '',
 ADD COLUMN price_snapshot jsonb,
 ADD COLUMN estimated_cost_microusd bigint CHECK(estimated_cost_microusd >= 0),
 ADD COLUMN cost_status text NOT NULL DEFAULT 'unavailable' CHECK(cost_status IN ('not_incurred','estimated','unavailable','unknown','reconciled')),
 ADD COLUMN currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 ADD COLUMN request_id text NOT NULL DEFAULT '',
 ADD COLUMN trace_id text NOT NULL DEFAULT '',
 ADD COLUMN failure_class text NOT NULL DEFAULT 'none' CHECK(failure_class IN ('none','validation','authorization','quota','capacity','transport','timeout','cancelled','protocol','provider','worker','persistence','restart'));
-- Historical rows are facts with unavailable usage, never zero-token claims.
UPDATE model_invocations SET completed_at=updated_at WHERE status<>'running';
UPDATE model_invocations SET observability_version=0;
CREATE INDEX model_invocations_usage ON model_invocations(tenant_id,completed_at,id) WHERE status<>'running';
CREATE INDEX model_invocations_run_usage ON model_invocations(tenant_id,run_id,created_at,id);
-- No automatic retention deletion is enabled. This durable lower bound allows
-- future scoped cleanup to advance a tenant's boundary in the deletion transaction.
CREATE TABLE usage_retention_boundaries (
 tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
 retained_from timestamptz NOT NULL DEFAULT '1970-01-01 00:00:00+00'
);
