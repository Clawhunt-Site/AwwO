-- Gifted credits (plans.go, billing.go; owner 2026-10-25: 「东西还没做出来，给他再送两倍20刀的量」). Credits the
-- operator gives an account beyond what it paid: goodwill while AwwO is in its beta, or compensation for runs that
-- failed. ClawHunt only ever reports what was paid, so a gift lives here alone — applyPlan writes gift_credits at a
-- period roll-over and nowhere else, and a plan sync therefore never takes a gift away. A gift belongs to the
-- charged period it was given for, as that period's paid credits do: the paid credits are spent first, a renewal
-- clears it (the operator grants another if there is to be one), and prev_gift keeps the previous period's gift,
-- against which, with its credits, an overspend is measured (withCarry). Both are what a period was given, never a
-- leftover worked out from a spend that keeps moving after the period ends. gift_note says what it was for, for the
-- operator who reads the row later.
--
-- Both columns have a constant default, so adding them rewrites no table, and one small table changes.
SET LOCAL lock_timeout = '10s';
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS gift_credits integer NOT NULL DEFAULT 0;
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS prev_gift integer NOT NULL DEFAULT 0;
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS gift_note text NOT NULL DEFAULT '';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'user_plans'::regclass AND conname = 'user_plans_gift_credits_check') THEN
    ALTER TABLE user_plans ADD CONSTRAINT user_plans_gift_credits_check CHECK (gift_credits >= 0 AND prev_gift >= 0);
  END IF;
END $$;
