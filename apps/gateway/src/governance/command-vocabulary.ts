/**
 * Canonical mutating tool-name vocabulary — ported verbatim from the single
 * Python sources, so the read-only posture gate (postureDeniesTool) covers the
 * same kernel-state mutations by construction (not just repo/shell tools):
 *
 * - COMPANY_TOOL_NAMES        <- company_commands.py COMMAND_TYPE_TO_TOOL_NAME values
 * - MARKETPLACE_WRITE_TOOL_NAMES <- marketplace_commands.py tool names with is_read=False
 *
 * Only the NAMES are ported here; the full command logic lives in its domain
 * (P2+). command-vocabulary.test.ts cross-checks these lists against the Python
 * sources and fails loudly on any drift, mirroring the Python single-source
 * anti-drift tests (test_company_tools.py, test_marketplace_tools.py).
 */

export const COMPANY_TOOL_NAMES: readonly string[] = Object.freeze([
  "company_create",
  "company_update",
  "company_archive",
  "agent_hire",
  "agent_update",
  "agent_charter",
  "issue_create",
  "issue_assign",
  "issue_delegate",
  "issue_comment",
  "work_product_attach",
  "issue_submit_review",
  "issue_block",
  "issue_unblock",
  "issue_hold",
  "issue_unhold",
  "issue_requeue",
  "work_product_update",
  "issue_tree_pause",
  "issue_tree_resume",
  "issue_tree_cancel",
  "routine_author",
  "board_inbox_resolve",
  "board_inbox_assign",
]);

// Marketplace browse/inspect are reads (is_read=True) and are deliberately NOT
// here — they do not mutate. Everything else crosses an external boundary /
// makes commitments and is mutating by construction.
export const MARKETPLACE_WRITE_TOOL_NAMES: readonly string[] = Object.freeze([
  "marketplace_post_task",
  "marketplace_bid",
  "marketplace_claim",
  "marketplace_submit",
  "marketplace_abandon",
  "marketplace_accept",
  "marketplace_accept_bid",
]);
