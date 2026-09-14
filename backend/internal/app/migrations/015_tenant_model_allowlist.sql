-- Per-tenant model entitlement. NULL is "unrestricted": every model a worker
-- advertises stays selectable, so every workspace that exists today keeps exactly
-- the behaviour it has now. A non-NULL array is authoritative and exhaustive for
-- that workspace, which is why an empty array blocks every model instead of
-- meaning "no opinion" -- an operator narrowing a list can never widen access.
--
-- The array filters what a worker advertises; it is not a registry. An id listed
-- here that no worker publishes is simply never offered and never runs, so
-- retiring a model needs no migration and nothing is foreign-keyed to one.
--
-- A CHECK cannot contain a subquery, so the per-element test runs over the joined
-- text. The join alone is ambiguous -- one element containing a comma is
-- indistinguishable from two elements -- so the cardinality identity is what
-- makes it exact. That identity also rejects NULL elements, which array_to_string
-- would otherwise skip. The element shape mirrors what probeRuntime accepts from
-- a worker (non-empty, at most 200 characters) rather than one worker's narrower
-- profile grammar, minus the characters that cannot be an id at all; the Go
-- normalizer is the stricter of the two and is what the API enforces.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS allowed_models text[];
DO $$ BEGIN
 ALTER TABLE tenants ADD CONSTRAINT tenants_allowed_models_shape CHECK (
  allowed_models IS NULL
  OR cardinality(allowed_models) = 0
  OR (array_ndims(allowed_models) = 1
      AND cardinality(allowed_models) <= 64
      AND cardinality(allowed_models) = cardinality(string_to_array(array_to_string(allowed_models, ','), ','))
      AND array_to_string(allowed_models, ',') ~ '^[^,[:space:][:cntrl:]]{1,200}(,[^,[:space:][:cntrl:]]{1,200})*$')
 );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
