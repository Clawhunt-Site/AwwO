-- Ultra, the third paid plan (plans.go planCatalog; the owner's 2026-11-11 「价格改为三档20刀-100刀-299刀」: Pro $20, Max
-- $100, Ultra $299). user_plans mirrors the plan an account has paid for, and migration 026 let it hold 'pro' or 'max'
-- alone, in a check it declared on the column without a name, which PostgreSQL named user_plans_plan_check. That check
-- is replaced here by one that takes 'ultra' as well. Nothing else changes: no row is written, and every row there is
-- passed the narrower check.
--
-- An API from before this migration reads a plan it does not know as no plan (scanPlan) and refuses to store one
-- (applyPlan), so it runs on this schema as it did, with an Ultra account on the free plan for as long as it serves.
--
-- Both statements can run again unchanged. Replacing a check takes the table's strongest lock and reads every row under
-- it; adding it NOT VALID and validating it afterwards would spare nothing here, since the migration is one transaction
-- and keeps that lock until it commits either way. user_plans is small (one row for each account that ever subscribed),
-- so the lock is held for a moment only, and the short timeout makes a busy table fail the deploy visibly instead of
-- queueing every admission behind it.
SET LOCAL lock_timeout = '5s';
ALTER TABLE user_plans DROP CONSTRAINT IF EXISTS user_plans_plan_check;
ALTER TABLE user_plans ADD CONSTRAINT user_plans_plan_check CHECK (plan IN ('pro', 'max', 'ultra'));
-- Another check that reads the plan, alone or with other columns, under any other name could still refuse Ultra, and
-- every Ultra payment would then fail to land without a word: such a database is refused until an operator has looked
-- at it. No migration makes one (044's check reads the gift columns only).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = 'user_plans'::regclass AND k.contype = 'c' AND k.conname <> 'user_plans_plan_check'
      AND (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = k.conrelid AND a.attname = 'plan') = ANY (k.conkey)) THEN
    RAISE EXCEPTION 'user_plans holds another check that reads its plan column: see that it takes ultra, by hand';
  END IF;
END $$;
