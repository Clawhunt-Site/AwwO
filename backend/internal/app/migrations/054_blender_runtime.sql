-- The Blender workstation runtime (runtime_workers.go runtimeBlender): a node's Agent may run on it, and each of its model
-- calls is recorded under it. Both checks are replaced as a whole, as 034 replaced them for the sandbox, so running this
-- again leaves the same constraints.
SET LOCAL lock_timeout = '10s';
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_runtime_check;
ALTER TABLE agents ADD CONSTRAINT agents_runtime_check CHECK (runtime IN ('pi', 'openai-agents', 'sandbox', 'blender'));
ALTER TABLE model_invocations DROP CONSTRAINT IF EXISTS model_invocations_runtime_check;
-- NOT VALID: every row already meets the narrower check this replaces, so the call log is not scanned under the lock.
ALTER TABLE model_invocations ADD CONSTRAINT model_invocations_runtime_check CHECK (runtime IN ('pi', 'openai-agents', 'sandbox', 'blender')) NOT VALID;
