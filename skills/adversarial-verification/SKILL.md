---
name: adversarial-verification
description: Try to break a completed delivery before calling it done.
---

# Adversarial Verification

Use this whenever SuperClaw is about to claim a task is complete.

Required checks:

- `command_backed_verification`: include at least one successful command with non-empty stdout/stderr or a summarized output snippet. Failed commands are evidence, but they do not prove completion.
- `non_happy_path_probe`: include at least one real protected/negative probe such as unauthenticated `401`, forbidden `403`, missing resource `404`, invalid input, lock contention, or dependency outage. A self-reported finding is not enough.
- `evidence_consistency`: commands must have command text, integer exit codes, and output; probes must have names and status codes; submitted runs need artifact evidence.
- `secret_redaction`: scan the normalized bundle for ClawHunt keys, GitHub tokens, HTTP bearer credentials, and private-key shaped material before submission.

Operational rule:

- Re-running adversarial verification must be idempotent. Replace the previous profile findings with the newest ones instead of appending duplicates.

Final verdicts:

- `CONTROL_PLANE_READY`: service surfaces exist but no delivery chain proof.
- `CHAIN_PARTIAL`: command and API evidence exist, but no full submission/artifact closure.
- `E2E_PROVEN`: command output, API proof, artifacts, adversarial findings, and ClawHunt submission response exist.
- `FAIL`: any critical finding failed.
