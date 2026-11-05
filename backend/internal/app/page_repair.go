package app

import (
	"context"
	"regexp"
)

// A delivered page that fails when it runs goes back to the node that made it, once, as a message in the node's own chat
// (apps/web/src/canvas/pageRepair.ts); so does a figure that never moves, once of its own. The page keeps that once in
// the canvas's browser storage, which another browser, another device and a collaborator's browser do not share, and a
// repair whose result arrives more than 30 minutes after it was asked counts there as a new delivery. Each repair is a
// paid run. So the service holds every browser to the page's onces, per kind, as a canvas's auto rerun is never rerun by
// itself (claimAutoRerun): of a node's automatic repairs, at most one of each kind runs in a row (a failing page's, a
// still figure's), and none after that until another run of the node. Every run of a node, a person's message, a canvas
// run (graph_runs.go) or an auto rerun, is a run of the node's session, so the session's latest runs say what ran since
// the last repair. That is what the service knows, not which page each run delivered: after any other run of the node,
// whether or not it delivered a new page, the page may ask once more for each kind. Automatic repairs are so held to the
// runs people and canvas runs make, with no daily cap of their own.
//
// The request carries no field that marks it: the page's repair message begins with its fixed first line
// (pageRepairMessage), which every build of the page sends, cached ones too. The field's id goes into it as it is, and an
// id may hold a quote (a plan's ids refuse whitespace, control characters and three reserved names, not quotes; a stored
// contract's may hold almost anything, and the page sends no repair for one holding a line break), so the id is the line
// up to its last quote, before an optional " · still" (the page reads it the same way: PAGE_REPAIR_HEADER).
var pageRepairHeader = regexp.MustCompile("^AwwO page repair · field \"[^\\n]+\"( · still)?\\n")

// pageRepairPrefix is how that first line begins, whatever field it names: a stored prompt that begins otherwise is no
// repair, and of one that begins so the service reads the whole first line, however long the field's id.
const pageRepairPrefix = "AwwO page repair · field \""

// pageRepairKind is "still" for a request to make a figure move, "page" for one to fix a page that failed, and "" for any
// other prompt: a person's own words that mention the line somewhere else are no repair.
func pageRepairKind(prompt string) string {
	switch m := pageRepairHeader.FindStringSubmatch(prompt); {
	case m == nil:
		return ""
	case m[1] != "":
		return "still"
	default:
		return "page"
	}
}

// pageRepairRefusal answers a refusal's code and message for a page repair the node session must not run, or "" for one
// it may: a repair is refused when the session's latest run was a repair of the same kind (the page already asked that
// once), or its two latest runs both were repairs (a page error's repair and a still figure's, then nothing more until
// another run of the node).
// Anything else that ran between, a person's message or any canvas run of the node, lets the page ask once more. It reads
// under the session row's lock createRun holds, once the session has no run queued or running (session_busy): each of
// its runs is over then, runs_one_active_session ran them one after another, and updated_at is written only while a run
// is queued or running (its status changes and its streamed output), so each one's updated_at is when it ended. Not
// created_at: that is the time its admission's transaction began, which can be earlier than a run admitted ahead of it.
// updated_at too is a transaction's start (now()): a cancellation that began before the run ahead ended, and waited,
// stamps the run it cancels as if it had ended first, and a run so cancelled delivered nothing. When a canvas run's
// cancellation does so (it cancels only canvas runs), a repair after it is refused where the page could have asked (free,
// and the reader can ask in the node's chat). When a workspace's suspension does so to a repair it cancels, one more
// repair may run once the workspace is active again.
func pageRepairRefusal(ctx context.Context, q querier, tid, sid, prompt string) (string, string, error) {
	kind := pageRepairKind(prompt)
	if kind == "" {
		return "", "", nil
	}
	rows, err := q.Query(ctx, `SELECT CASE WHEN starts_with(prompt,$3) THEN left(prompt,strpos(prompt,chr(10))) ELSE '' END
		FROM (SELECT prompt,updated_at,created_at,id FROM runs WHERE tenant_id=$1 AND session_id=$2 ORDER BY updated_at DESC,created_at DESC,id DESC LIMIT 2) r
		ORDER BY updated_at DESC,created_at DESC,id DESC`, tid, sid, pageRepairPrefix)
	if err != nil {
		return "", "", err
	}
	defer rows.Close()
	var latest []string
	for rows.Next() {
		var line string
		if err = rows.Scan(&line); err != nil {
			return "", "", err
		}
		latest = append(latest, pageRepairKind(line))
	}
	if err = rows.Err(); err != nil {
		return "", "", err
	}
	sameKind := len(latest) > 0 && latest[0] == kind
	twoRepairs := len(latest) == 2 && latest[0] != "" && latest[1] != ""
	if sameKind || twoRepairs {
		return "page_repair_chained", "This node's page went back for an automatic repair already: it does not go back again by itself", nil
	}
	return "", "", nil
}
