-- Durable transaction identities make a signed pagination snapshot exclude rows
-- whose creation/completion transaction commits after the first page, even when
-- its wall-clock timestamp is earlier than that page's cutoff.
ALTER TABLE model_invocations
 ADD COLUMN created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 ADD COLUMN completed_xid xid8;
UPDATE model_invocations SET completed_xid=pg_current_xact_id() WHERE status<>'running';

-- Upgrade runtime provenance from the immutable accepted configuration, never
-- from today's mutable agent definition. Legacy usage and money remain unknown.
WITH facts AS (
 SELECT i.id,
 COALESCE(NULLIF(t.config->>'runtime',''),NULLIF(r.execution_snapshot->'team'->>'runtime',''),NULLIF(r.execution_snapshot->>'runtime',''),'pi') AS runtime,
 COALESCE(NULLIF(t.config->>'model',''),NULLIF(r.execution_snapshot->>'model','')) AS explicit_model,
 t.id AS turn_id,COALESCE(t.member_id,s.agent_id) AS agent_id,r.execution_snapshot AS snapshot
 FROM model_invocations i JOIN runs r ON r.tenant_id=i.tenant_id AND r.id=i.run_id
 LEFT JOIN run_turns t ON t.tenant_id=i.tenant_id AND t.run_id=i.run_id AND t.id=i.id
 LEFT JOIN node_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id
 WHERE i.usage_reason='legacy_worker' AND i.observability_version=0
), catalogs AS (
 SELECT *,COALESCE(snapshot->'runtimeHealth'->runtime,snapshot->'health','{}'::jsonb) AS health FROM facts
), resolved AS (
 SELECT *,COALESCE(explicit_model,health->>'model','') AS model_id FROM catalogs
)
UPDATE model_invocations i SET runtime=f.runtime,model_id=f.model_id,turn_id=f.turn_id,agent_id=f.agent_id,
 provider=COALESCE((SELECT m->>'provider' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f.health->'models')='array' THEN f.health->'models' ELSE '[]'::jsonb END) m WHERE m->>'id'=f.model_id LIMIT 1),CASE WHEN f.health->>'model'=f.model_id THEN f.health->>'provider' END,'')
 FROM resolved f WHERE i.id=f.id;
