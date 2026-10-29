-- The Agent market's monthly statements (market_settle.go, market_admin.go; docs/awwo-agent-market.md; owner
-- 2026-10-29: 「不要自动转账，按照次数累计解决，一个月一次统计完整的调用次数」). Nothing is transferred by itself: once
-- a calendar month (UTC) has ended, the settlement job gathers each author's earnings made final during it into one
-- statement, its calls counted, and a platform administrator approves the statement before it is sent to the author's
-- ClawHunt wallet. A statement is a market_payouts row: 'review' until it is approved, then 'pending' until ClawHunt
-- says it credited it ('sent'), and 'held' while the author's ClawHunt account cannot receive it. Its id, the
-- reference ClawHunt credits once, is made from the author and the month, so a month is never credited twice.
--
-- An author may now have a statement waiting for review while the next month's is made, so the one-open-payout index
-- of the transfers that went out by themselves goes, and a check keeps any other kind of row out, an older API's too.
-- Every change is conditional and the migration runs again harmlessly; market_payouts and market_agent_calls are small
-- (transfers were never on), so the new checks and index take their locks for a moment only.
SET LOCAL lock_timeout = '5s';
ALTER TABLE market_payouts ADD COLUMN IF NOT EXISTS period_month date;
-- A transfer from before statements that is still on its way (transfers by themselves, never on in production) would
-- be neither sent nor approvable after this: such a database is refused until an operator settles them. The column
-- just added sets them apart from statements, also when this runs again.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM market_payouts WHERE status IN ('pending','held') AND period_month IS NULL) THEN
    RAISE EXCEPTION 'market_payouts holds transfers from before monthly statements still on their way: settle them first';
  END IF;
END $$;
ALTER TABLE market_payouts ADD COLUMN IF NOT EXISTS calls integer NOT NULL DEFAULT 0;
ALTER TABLE market_payouts ADD COLUMN IF NOT EXISTS credits bigint NOT NULL DEFAULT 0;
ALTER TABLE market_payouts ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE market_payouts ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE market_payouts DROP CONSTRAINT IF EXISTS market_payouts_status_check;
ALTER TABLE market_payouts ADD CONSTRAINT market_payouts_status_check CHECK (status IN ('review','pending','sent','held','failed'));
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'market_payouts'::regclass AND conname = 'market_payouts_statement_check') THEN
    ALTER TABLE market_payouts ADD CONSTRAINT market_payouts_statement_check CHECK (calls >= 0 AND credits >= 0
      AND (period_month IS NULL OR period_month = date_trunc('month', period_month)::date));
  END IF;
  -- Every row written from now on is a monthly statement, and none is on its way or sent without an administrator's
  -- approval: an API older than this migration, started again by a rollback, can make no transfer of its own (it made
  -- them without a month or an approval). NOT VALID: rows from before are not read again, only kept from changing.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'market_payouts'::regclass AND conname = 'market_payouts_approved_statement_check') THEN
    ALTER TABLE market_payouts ADD CONSTRAINT market_payouts_approved_statement_check
      CHECK (period_month IS NOT NULL AND (status IN ('review','failed') OR approved_at IS NOT NULL)) NOT VALID;
  END IF;
END $$;
DROP INDEX IF EXISTS market_payouts_one_open;
CREATE UNIQUE INDEX IF NOT EXISTS market_payouts_statement ON market_payouts(author_user_id, period_month) WHERE period_month IS NOT NULL;
-- A statement's calls, which its review lists by Agent.
CREATE INDEX IF NOT EXISTS market_calls_payout ON market_agent_calls(payout_id) WHERE payout_id IS NOT NULL;
