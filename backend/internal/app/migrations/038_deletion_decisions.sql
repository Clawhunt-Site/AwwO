-- A deletion request gets the operator's outcome, set from the 删除申请 admin tab: handled (the operator deleted the
-- account; the request's user_id is then empty) or declined (with a reason the person who asked is shown), with when,
-- who decided (an id kept as text: the audit log names the actor too, and no lock on users is needed) and a note. A
-- decided request is final; after a decline the account may ask again. Every check on status is replaced, whatever its
-- name, by three that also hold a decision's shape. Only this small table changes. Every statement can run again
-- unchanged.
SET LOCAL lock_timeout = '10s';
ALTER TABLE account_deletion_requests ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE account_deletion_requests ADD COLUMN IF NOT EXISTS decided_by text;
ALTER TABLE account_deletion_requests ADD COLUMN IF NOT EXISTS decision_note text NOT NULL DEFAULT '';
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'account_deletion_requests'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE account_deletion_requests DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE account_deletion_requests ADD CONSTRAINT account_deletion_requests_status_check
  CHECK (status IN ('pending', 'withdrawn', 'handled', 'declined'));
ALTER TABLE account_deletion_requests ADD CONSTRAINT account_deletion_requests_decided_check
  CHECK ((status IN ('handled', 'declined')) = (decided_at IS NOT NULL));
ALTER TABLE account_deletion_requests ADD CONSTRAINT account_deletion_requests_declined_note_check
  CHECK (status <> 'declined' OR decision_note <> '');
