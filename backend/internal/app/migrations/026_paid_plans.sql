-- Paid plans (plans.go, billing.go, plan_sync.go). ClawHunt takes the payment; user_plans mirrors what an
-- account has paid for: the plan, the billing period AwwO charges against and the credits that period's paid
-- invoices bought, and the previous charged period with its credits and what was carried into it, so that what it
-- spent beyond them, counted when asked, comes off the current period's credits. A period stays the charged one until
-- ClawHunt reports the next one paid, so a renewal whose payment is pending or failing never grants credits that
-- were not paid for. One row per account that ever subscribed.
--
-- Every call and generation admitted under a plan names the account and the period it is charged to
-- (billed_user_id, billed_period_start). A period's spend is summed from those rows alone, so deleting a canvas
-- (which cascades its runs) never gives credits back and no call counts against two periods. A call holds
-- credit_reserve while it runs and is charged credit_charge once it settles; a generation is charged
-- credit_points once its provider accepted the task (provider_accepted), and nothing when its run ended before
-- that. Rows admitted on the free plan leave the billing columns NULL, which is also what keeps paid traffic out
-- of the free plan's route counts and ceilings.
--
-- New columns are nullable or have a constant default, so adding them rewrites no table. Each table's indexes
-- are built right after its columns, and tenants, which every request reads, is altered last, so its lock is
-- held only until the commit. The short lock timeout makes a busy table fail the deploy visibly instead of
-- queueing every query behind it.
SET LOCAL lock_timeout = '10s';
ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS billed_user_id text;
ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS billed_period_start timestamptz;
ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS credit_reserve integer;
ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS credit_charge integer;
-- A period's spend (paid calls only), today's default-model calls, and the calls running now.
CREATE INDEX IF NOT EXISTS model_invocations_billed_period ON model_invocations(billed_user_id, billed_period_start) WHERE billed_user_id IS NOT NULL AND credit_reserve IS NOT NULL;
CREATE INDEX IF NOT EXISTS model_invocations_billed_time ON model_invocations(billed_user_id, created_at) WHERE billed_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS model_invocations_billed_running ON model_invocations(billed_user_id) WHERE billed_user_id IS NOT NULL AND status = 'running';
ALTER TABLE media_generations ADD COLUMN IF NOT EXISTS billed_user_id text;
ALTER TABLE media_generations ADD COLUMN IF NOT EXISTS billed_period_start timestamptz;
ALTER TABLE media_generations ADD COLUMN IF NOT EXISTS credit_points integer;
ALTER TABLE media_generations ADD COLUMN IF NOT EXISTS provider_accepted boolean;
CREATE INDEX IF NOT EXISTS media_generations_billed_period ON media_generations(billed_user_id, billed_period_start) WHERE billed_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_generations_billed_time ON media_generations(billed_user_id, created_at) WHERE billed_user_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS user_plans (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('pro', 'max')),
  status text NOT NULL CHECK (status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  credits integer NOT NULL DEFAULT 0 CHECK (credits >= 0),
  prev_period_start timestamptz,
  prev_credits integer NOT NULL DEFAULT 0 CHECK (prev_credits >= 0),
  prev_carry integer NOT NULL DEFAULT 0 CHECK (prev_carry >= 0),
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  -- When the stored answer was asked for (the database's clock), and when a failed background read may retry.
  synced_at timestamptz NOT NULL DEFAULT now(),
  retry_after timestamptz,
  CHECK (period_end > period_start)
);
-- Accounts whose plan is read again from ClawHunt for a while after they open a checkout or the billing portal,
-- whether or not their browser comes back.
CREATE TABLE IF NOT EXISTS plan_watches (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  until timestamptz NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT '-infinity'
);
-- A workspace its owner could create only because a plan allowed more workspaces: it runs nothing while the
-- owner's plan does not allow it, so a lapsed or smaller plan does not keep multiplying the allowances.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS requires_plan boolean NOT NULL DEFAULT false;
