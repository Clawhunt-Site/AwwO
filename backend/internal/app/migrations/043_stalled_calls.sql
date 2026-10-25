-- A model call its worker cut because the provider sent nothing for the worker's silence limit, before the call returned
-- anything (the worker's MODEL_STALLED), is noted as it settles with the reason stalled: it costs no credits and the
-- workspace's daily total gives it back, at most refundedCallsPerDay such calls a day (invocation_ledger.go
-- settleInvocation, direct_task_refund.go; owner 2026-10-25). Every check on reason is replaced, whatever its name, by one
-- that also takes stalled; the rows refunded_calls holds are all timeouts, which it still takes. Only this small table
-- changes, and every statement can run again unchanged.
SET LOCAL lock_timeout = '10s';
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'refunded_calls'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%reason%'
  LOOP
    EXECUTE format('ALTER TABLE refunded_calls DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE refunded_calls ADD CONSTRAINT refunded_calls_reason_check CHECK (reason IN ('timeout', 'stalled'));
