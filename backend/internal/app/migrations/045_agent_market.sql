-- The Agent market (market.go, market_use.go, market_settle.go; docs/awwo-agent-market.md). An author publishes an
-- Agent: hidden instructions, up to four frozen skills, a recommended model and a price per call in credits. A
-- platform administrator approves each version before it lists, and callers use it on canvas nodes.
--
-- market_agents and market_agent_versions hold what is published. A version is never edited once submitted; a new
-- price is a new version. market_agent_calls records every run of a node that used a market Agent: the fee it holds
-- and settles, the outcome the ranking reads, and the author's earning once the caller's billing period has closed.
-- It names workspaces, runs and accounts by value, with no foreign key to them, so an author's earnings outlive the
-- caller's workspace. market_payouts records the transfers into authors' ClawHunt wallets.
--
-- agents gains two nullable columns without defaults (no rewrite); the rest are new tables. The short lock timeout
-- makes a busy deploy fail visibly instead of queueing every query behind it (ALTER TABLE agents takes its table's
-- exclusive lock for a moment).
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS market_agents (
  id text PRIMARY KEY,
  -- NULL for AwwO's own (official) Agents, and for an author whose account was deleted, whose Agents then list no more.
  author_user_id text REFERENCES users(id) ON DELETE SET NULL,
  -- The author's name the listed version was approved with (market_agent_versions.author_display).
  author_display text NOT NULL DEFAULT '' CHECK (length(author_display) <= 40),
  official boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','listed','unlisted','suspended')),
  -- What a suspension stopped, which lifting it restores.
  suspended_from text CHECK (suspended_from IS NULL OR suspended_from IN ('draft','listed','unlisted')),
  listed_version integer CHECK (listed_version IS NULL OR listed_version >= 1),
  listed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS market_agents_author ON market_agents(author_user_id);
CREATE TABLE IF NOT EXISTS market_agent_versions (
  agent_id text NOT NULL REFERENCES market_agents(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','pending','approved','rejected','superseded')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  tagline text NOT NULL CHECK (length(tagline) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(description) <= 4000),
  category text NOT NULL,
  kind text NOT NULL DEFAULT 'llm' CHECK (kind IN ('llm','coding')),
  instructions text NOT NULL CHECK (octet_length(instructions) BETWEEN 1 AND 32000),
  instructions_public boolean NOT NULL DEFAULT false,
  -- Frozen copies: [{ref,name,title,body,hash,attribution}], at most four, bodies within the node skill budget.
  skills jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skills) = 'array'),
  runtime text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  effort text NOT NULL DEFAULT '',
  model_locked boolean NOT NULL DEFAULT false,
  price_credits integer NOT NULL DEFAULT 0 CHECK (price_credits >= 0),
  examples jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(examples) = 'array'),
  content_hash text NOT NULL,
  -- The name the market shows for the author, reviewed with the version.
  author_display text NOT NULL DEFAULT '' CHECK (length(author_display) <= 40),
  review_note text NOT NULL DEFAULT '' CHECK (length(review_note) <= 2000),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent_id, version)
);
CREATE INDEX IF NOT EXISTS market_agent_versions_pending ON market_agent_versions(submitted_at) WHERE state = 'pending';
-- A node's workspace Agent that runs a market version holds no instructions of its own: they are frozen into each
-- run's snapshot at admission, so the caller's workspace never stores the author's text.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS market_agent_id text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS market_version integer;
CREATE TABLE IF NOT EXISTS market_agent_calls (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES market_agents(id),
  version integer NOT NULL,
  author_user_id text,
  tenant_id text,
  run_id text UNIQUE,
  actor_id text,
  -- The account charged and its billing period; NULL for a free call (a price of 0, or an author's own).
  billed_user_id text,
  billed_period_start timestamptz,
  billed_period_end timestamptz,
  price_credits integer NOT NULL CHECK (price_credits >= 0),
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  -- The author belongs to the calling workspace: no fee, no earning, no ranking.
  insider boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','charged','released')),
  outcome text NOT NULL DEFAULT '',
  outcome_code text NOT NULL DEFAULT '' CHECK (length(outcome_code) <= 200),
  platform_fault boolean NOT NULL DEFAULT false,
  duration_ms bigint,
  model_credits integer,
  earned_microcredits bigint CHECK (earned_microcredits IS NULL OR earned_microcredits >= 0),
  settlement text NOT NULL DEFAULT 'open' CHECK (settlement IN ('open','final','void','none')),
  payout_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  finalized_at timestamptz,
  CHECK ((billed_user_id IS NULL) = (billed_period_start IS NULL) AND (billed_period_start IS NULL) = (billed_period_end IS NULL)),
  CHECK (price_credits = 0 OR billed_user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS market_calls_spend ON market_agent_calls(billed_user_id, billed_period_start) WHERE price_credits > 0 AND status IN ('reserved','charged');
CREATE INDEX IF NOT EXISTS market_calls_agent_recent ON market_agent_calls(agent_id, created_at);
CREATE INDEX IF NOT EXISTS market_calls_open ON market_agent_calls(billed_period_end) WHERE settlement = 'open';
CREATE INDEX IF NOT EXISTS market_calls_unpaid ON market_agent_calls(author_user_id) WHERE settlement = 'final' AND payout_id IS NULL;
-- What the settlement job reads every ten minutes: the fees held, and the charges of the last day a failed delivery may change.
CREATE INDEX IF NOT EXISTS market_calls_reserved ON market_agent_calls(created_at) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS market_calls_settled ON market_agent_calls(settled_at) WHERE status = 'charged' AND outcome = 'completed';
CREATE TABLE IF NOT EXISTS market_agent_ratings (
  call_id text PRIMARY KEY REFERENCES market_agent_calls(id),
  agent_id text NOT NULL,
  user_id text,
  score smallint NOT NULL CHECK (score IN (-1, 1)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS market_ratings_agent ON market_agent_ratings(agent_id);
CREATE TABLE IF NOT EXISTS market_payouts (
  id text PRIMARY KEY,
  author_user_id text NOT NULL,
  subject text NOT NULL,
  -- What the payout carries in micro-credits (its calls' earnings plus the previous payout's remainder), what it sends
  -- in whole cents (1 credit = 1 cent), and the remainder below a cent that the next payout carries in.
  microcredits bigint NOT NULL CHECK (microcredits >= 0),
  carry_in_microcredits bigint NOT NULL DEFAULT 0 CHECK (carry_in_microcredits >= 0),
  carry_out_microcredits bigint NOT NULL DEFAULT 0 CHECK (carry_out_microcredits BETWEEN 0 AND 999999),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','held','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT '' CHECK (length(last_error) <= 200),
  clawhunt_transaction text,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz
);
-- One payout in flight per author: the next is made from what accrues once it is sent. A failed one (set by an
-- operator only) holds the next back too, so its remainder is never carried twice.
CREATE UNIQUE INDEX IF NOT EXISTS market_payouts_one_open ON market_payouts(author_user_id) WHERE status IN ('pending','held','failed');
-- What a caller's billing period was given, kept by the settlement job while the period has calls to settle:
-- user_plans keeps only the charged period and the one before it, and a period's earnings are made final only after
-- it ends and a hold passes, when user_plans may no longer have it. spent is the most of the period's settled spending
-- seen: a workspace deleted later takes its model calls and generations with it, which must not raise the share of
-- the spending the paid credits covered.
CREATE TABLE IF NOT EXISTS market_period_facts (
  user_id text NOT NULL,
  period_start timestamptz NOT NULL,
  paid_credits integer NOT NULL CHECK (paid_credits >= 0),
  carry integer NOT NULL CHECK (carry >= 0),
  spent bigint NOT NULL DEFAULT 0 CHECK (spent >= 0),
  -- When ClawHunt last failed to answer for the caller's plan before its earnings could be made final: such a period
  -- is tried after the others.
  refresh_failed_at timestamptz,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, period_start)
);
