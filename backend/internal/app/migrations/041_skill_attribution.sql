-- Where a workspace skill came from (skill_registry.go): a skill imported from the skills.sh registry records its entry
-- there, its source repository and the license known when it was imported, shown beside the skill as a built-in's
-- attribution is. NULL for a skill a member wrote or uploaded as a file.
--
-- One nullable column without a default on an existing table, so nothing is rewritten; the short lock timeout makes a
-- busy deploy fail visibly instead of queueing every query behind it.
SET LOCAL lock_timeout = '10s';
ALTER TABLE tenant_skills ADD COLUMN IF NOT EXISTS attribution text CHECK (attribution IS NULL OR length(attribution) BETWEEN 1 AND 1024);
