package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Canvas RSI, loop 4: a canvas that evolves by itself (canvas_auto_evolution, canvas_evolution_log, migration 053; the
// owner's «做出来», 2026-11-03). A canvas's members may turn on either of two switches, both off until then:
//
//   - Auto apply. When a canvas run that ended while it was on has failed nodes, and its lessons are written
//     (canvas_lessons.go), each node whose failure wrote a lesson with a suggested reasoning effort takes it by itself,
//     as the 经验 panel would offer it: low for one that stopped at its model's output limit, medium again for one at
//     low that failed to deliver twice. Only an effort, never a model or the canvas's shape, and never a team's, a
//     workspace Agent's or a media node's. A node is changed once in autoChangeEvery at most, and no more once it was
//     changed autoChangesPerWindow times in autoChangeWindow. A change that did not help (the node's first
//     autoRevertAfterRuns runs after it all failed in ways its own setting could cause) is reverted, without waiting
//     for autoChangeEvery, and the suggestion behind it set aside.
//   - Auto rerun. Then the run's unfinished nodes (those that failed, and those they blocked) run once more, with
//     their new lessons: a canvas run of its own, which spends as any does, at most autoRerunsPerDay a canvas in a day.
//     A rerun's own failures are never rerun, nor a run in which a person stopped a node.
//
// The server decides what is due (planCanvasEvolution); the canvas page carries it out the way a person takes a
// suggestion (an undoable plan, CanvasSurface's applyEvolution). Each change is claimed first (claimCanvasEvolution: the
// server checks it is due as it stands and says from what effort to what, so no page names them), made with the change's
// mark on its node, then settled: done by the canvas save that makes it (settleEvolutionClaims, in updateCanvas's
// transaction: the node at the change's effort, carrying its mark), whether or not its page lives to say so, or by the
// page once the canvas as saved holds it, or skipped with the page's reason (settleCanvasEvolution); a claim left
// unsettled for evolutionClaimWait that the canvas does not hold is let go as a skip, and comes back with a later save
// that holds it. A rerun is claimed as its canvas run is admitted
// (claimAutoRerun, under the canvas row's lock), only once its run's changes are settled. A page acts on a run it saw
// end, and on opening the canvas applies what is due; it never reruns on opening.

const (
	// autoRerunPrefix starts the operation id of an auto rerun, followed by the id of the canvas run it reruns.
	autoRerunPrefix  = "autorerun:"
	autoRerunsPerDay = 3
	// A node is changed by the canvas's evolution once in autoChangeEvery at most, and no more once it was changed
	// autoChangesPerWindow times in autoChangeWindow (a revert counts as a change, and waits for neither).
	autoChangeEvery      = 24 * time.Hour
	autoChangeWindow     = 7 * 24 * time.Hour
	autoChangesPerWindow = 2
	// An effort change is reverted once the node's first this many runs after it all failed.
	autoRevertAfterRuns = 2
	// A change claimed and not settled in this long is let go (a page closed in between).
	evolutionClaimWait = 30 * time.Minute
	evolutionLogShown  = 20
)

// revertJudgedCodes are the ends of a node's run (node_outcomes.code) that judge a change of its reasoning effort:
// failures its own setting could cause, as its lessons are written from them (codeLessonKind), and refused deliveries
// (delivery_<reason>). An outage, an interruption, credits running out or a refusal at admission judges nothing.
var revertJudgedCodes = []string{"output_limit", "workspace_step_limit", "run_timeout", "workspace_context_limit", "output_contract_invalid", "context_limit"}

// liveChangeSQL is whether log row e is a change that stands or may still: settled, or claimed less than
// evolutionClaimWait ago. A claim older than that is let go (settleEvolutionClaims) and counts for nothing.
var liveChangeSQL = `(e.done_at IS NOT NULL OR e.created_at>clock_timestamp()-interval '` + strconv.Itoa(int(evolutionClaimWait.Seconds())) + ` seconds')`

// evolutionNodesSQL lists the session nodes of canvas $2 (workspace $1) as saved: each one's id, title, the reasoning
// effort it runs at (its own, or its Agent's when it names none, as the 经验 panel reads it), its own effort (empty for
// none: what a plan overwrites and a revert puts back), its own model, whether a plan may change its effort at all (not a
// team's, a workspace Agent's or a media node's, which applyCanvasPlan leaves as they are), and its mark: the change of
// the canvas's evolution that the page made on it last (evolution.change; empty for none).
const evolutionNodesSQL = `SELECT DISTINCT ON (n->>'id') n->>'id' AS id,COALESCE(n->>'title','') AS title,
		CASE WHEN jsonb_typeof(n->'effort')='string' THEN n->>'effort'
			ELSE COALESCE((SELECT g.effort FROM agents g WHERE g.tenant_id=c.tenant_id AND g.id=n->'binding'->>'agentId'),'') END AS effort,
		CASE WHEN jsonb_typeof(n->'effort')='string' THEN n->>'effort' ELSE '' END AS own_effort,
		CASE WHEN jsonb_typeof(n->'model')='string' THEN n->>'model' ELSE '' END AS model,
		COALESCE(jsonb_typeof(n->'team'),'null')<>'object' AND COALESCE(n->>'agentRef','')=''
			AND COALESCE(n->>'agentKind','') NOT IN ('image','video','model3d','audio') AS changeable,
		CASE WHEN jsonb_typeof(n->'evolution')='object' AND jsonb_typeof(n->'evolution'->'change')='string' THEN n->'evolution'->>'change' ELSE '' END AS mark
	FROM canvases c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.document->'nodes')='array' THEN c.document->'nodes' ELSE '[]'::jsonb END) n
	WHERE c.tenant_id=$1 AND c.id=$2 AND jsonb_typeof(n)='object' AND n->>'kind'='session'`

// canvasNodeIDsSQL is the ids of every node of canvas $2 (workspace $1) as saved.
const canvasNodeIDsSQL = `SELECT n->>'id' FROM canvases c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.document->'nodes')='array'
	THEN c.document->'nodes' ELSE '[]'::jsonb END) n WHERE c.tenant_id=$1 AND c.id=$2 AND jsonb_typeof(n)='object'`

// evolutionSwitch is one of a canvas's two switches: on since when.
type evolutionSwitch struct {
	On    bool       `json:"on"`
	Since *time.Time `json:"since"`
}

// evolutionStep is one change the canvas's evolution has due for node NodeID: a lesson's suggested effort (LessonID),
// or the revert of an effort change (RevertsID), from the node's own effort (From) to Effort, on Model (the node's own,
// or for one on the workspace's default the model its lesson's runs ran with, as applyEvolution takes it).
type evolutionStep struct {
	LessonID  string `json:"lessonId,omitempty"`
	RevertsID string `json:"revertsId,omitempty"`
	NodeID    string `json:"nodeId"`
	NodeTitle string `json:"nodeTitle"`
	Kind      string `json:"kind"`
	Proposal  string `json:"proposal,omitempty"`
	Seen      int    `json:"seen,omitempty"`
	From      string `json:"from"`
	Effort    string `json:"effort"`
	Model     string `json:"model"`
}

// evolutionRerun is the rerun due: canvas run GraphID's unfinished nodes (Scope), to admit with OperationID.
type evolutionRerun struct {
	GraphID     string   `json:"graphId"`
	OperationID string   `json:"operationId"`
	Scope       []string `json:"scope"`
}

// evolutionRun is a canvas's latest canvas run, as what is due reads it: whether its lessons are written (Learnt, which
// a run is only once it has ended), when it was last updated (its end, once it has ended), whether it is itself an auto
// rerun, and the auto rerun of it, if there is one.
type evolutionRun struct {
	ID        string    `json:"id"`
	Status    string    `json:"status"`
	Learnt    bool      `json:"learnt"`
	EndedAt   time.Time `json:"endedAt"`
	AutoRerun bool      `json:"autoRerun"`
	RerunID   *string   `json:"rerunId"`
}

// evolutionPlan is what a canvas's evolution has due as it stands: its switches, its latest canvas run, the reruns of
// the last day, and once that run is learnt from, the changes to make and revert and the rerun.
type evolutionPlan struct {
	applyAt, rerunAt *time.Time
	latest           *evolutionRun
	lastDay          int
	apply, revert    []evolutionStep
	rerun            *evolutionRerun
}

// latestCanvasRun is canvas cid's latest canvas run other than except, or nil for a canvas without one.
func latestCanvasRun(ctx context.Context, q querier, tid, cid, except string) (*evolutionRun, error) {
	run := evolutionRun{}
	err := q.QueryRow(ctx, `SELECT g.id,g.status,g.lessons_at IS NOT NULL,g.updated_at,
			EXISTS (SELECT 1 FROM canvas_evolution_log e WHERE e.tenant_id=g.tenant_id AND e.canvas_id=g.canvas_id AND e.kind='rerun' AND e.rerun_graph_id=g.id),
			(SELECT e.rerun_graph_id FROM canvas_evolution_log e WHERE e.tenant_id=g.tenant_id AND e.kind='rerun' AND e.graph_id=g.id)
		FROM graph_runs g WHERE g.tenant_id=$1 AND g.canvas_id=$2 AND g.id<>$3 ORDER BY g.created_at DESC,g.id DESC LIMIT 1`, tid, cid, except).
		Scan(&run.ID, &run.Status, &run.Learnt, &run.EndedAt, &run.AutoRerun, &run.RerunID)
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &run, nil
}

// autoRerunsLastDay is how many auto reruns canvas cid started in the last day.
func autoRerunsLastDay(ctx context.Context, q querier, tid, cid string) (int, error) {
	var n int
	err := q.QueryRow(ctx, `SELECT count(*) FROM canvas_evolution_log WHERE tenant_id=$1 AND canvas_id=$2 AND kind='rerun'
		AND created_at>clock_timestamp()-interval '1 day'`, tid, cid).Scan(&n)
	return n, err
}

// changesInFlight is whether a change of canvas run gid's end is claimed and not settled yet (its rerun waits for it).
func changesInFlight(ctx context.Context, q querier, tid, cid, gid string) (bool, error) {
	var claimed bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM canvas_evolution_log e WHERE e.tenant_id=$1 AND e.canvas_id=$2 AND e.graph_id=$3
		AND e.kind IN ('effort','revert') AND e.done_at IS NULL AND `+liveChangeSQL+`)`, tid, cid, gid).Scan(&claimed)
	return claimed, err
}

// planCanvasEvolution is what canvas cid's evolution has due as it stands (evolutionPlan).
func planCanvasEvolution(ctx context.Context, q querier, tid, cid string) (evolutionPlan, error) {
	var plan evolutionPlan
	if err := q.QueryRow(ctx, "SELECT apply_at,rerun_at FROM canvas_auto_evolution WHERE tenant_id=$1 AND canvas_id=$2", tid, cid).Scan(&plan.applyAt, &plan.rerunAt); err != nil && !noRows(err) {
		return plan, err
	}
	var err error
	if plan.latest, err = latestCanvasRun(ctx, q, tid, cid, ""); err != nil {
		return plan, err
	}
	if plan.lastDay, err = autoRerunsLastDay(ctx, q, tid, cid); err != nil {
		return plan, err
	}
	plan.apply, plan.revert = []evolutionStep{}, []evolutionStep{}
	latest := plan.latest
	// Nothing is due before the latest run is learnt from: its nodes' outcomes and lessons are written then.
	if latest == nil || !latest.Learnt {
		return plan, nil
	}
	// A run that failed, and ended while a switch was on, asks for that switch's work.
	failedSince := func(since *time.Time) bool {
		return since != nil && latest.Status == "failed" && !latest.EndedAt.Before(*since)
	}
	if plan.applyAt != nil {
		if plan.revert, err = dueReverts(ctx, q, tid, cid, latest.ID); err != nil {
			return plan, err
		}
	}
	if failedSince(plan.applyAt) {
		if plan.apply, err = dueChanges(ctx, q, tid, cid, latest.ID); err != nil {
			return plan, err
		}
		// A node whose change is being reverted takes no other change now.
		plan.apply = slices.DeleteFunc(plan.apply, func(step evolutionStep) bool {
			return slices.ContainsFunc(plan.revert, func(r evolutionStep) bool { return r.NodeID == step.NodeID })
		})
	}
	if failedSince(plan.rerunAt) && !latest.AutoRerun && latest.RerunID == nil && plan.lastDay < autoRerunsPerDay {
		claimed, err := changesInFlight(ctx, q, tid, cid, latest.ID)
		if err != nil {
			return plan, err
		}
		scope, err := rerunScope(ctx, q, tid, cid, latest.ID)
		if err != nil {
			return plan, err
		}
		if len(scope) > 0 && !claimed {
			plan.rerun = &evolutionRerun{GraphID: latest.ID, OperationID: autoRerunPrefix + latest.ID, Scope: scope}
		}
	}
	return plan, nil
}

// evolutionEntrySQL is a log row e as the canvas's evolution shows it, with its node t (canvas nodes by id: title, own
// effort, kind, mark): its state (claimed, done, or expired: claimed and never settled), whether a revert of it was done
// (reverted), and whether it stands, a person able to take it back (an effort change done, the node still at the
// effort it set and carrying its mark, no revert of it done or under way).
var evolutionEntrySQL = `jsonb_build_object('id',e.id,'kind',e.kind,'auto',e.auto,'nodeId',e.node_id,'nodeTitle',COALESCE(t.title,''),'lessonId',e.lesson_id,
	'graphId',e.graph_id,'revertsId',e.reverts_id,'rerunGraphId',e.rerun_graph_id,'from',e.from_effort,'to',e.to_effort,'reason',e.reason,
	'createdAt',e.created_at,'doneAt',e.done_at,
	'state',CASE WHEN e.done_at IS NOT NULL THEN 'done' WHEN ` + liveChangeSQL + ` THEN 'claimed' ELSE 'expired' END,
	'reverted',EXISTS (SELECT 1 FROM canvas_evolution_log r WHERE r.tenant_id=e.tenant_id AND r.kind='revert' AND r.reverts_id=e.id AND r.done_at IS NOT NULL),
	'standing',e.kind='effort' AND e.done_at IS NOT NULL AND COALESCE(t.kind='session' AND t.own_effort=e.to_effort AND t.mark=e.id,false)
		AND NOT EXISTS (SELECT 1 FROM canvas_evolution_log r WHERE r.tenant_id=e.tenant_id AND r.kind='revert' AND r.reverts_id=e.id
			AND (r.done_at IS NOT NULL OR r.created_at>clock_timestamp()-interval '` + strconv.Itoa(int(evolutionClaimWait.Seconds())) + ` seconds')))`

// evolutionTitlesSQL is every node of canvas $2 (workspace $1) as saved, by id: title, own effort, kind and mark.
const evolutionTitlesSQL = `SELECT DISTINCT ON (n->>'id') n->>'id' AS id,COALESCE(n->>'title','') AS title,
		CASE WHEN jsonb_typeof(n->'effort')='string' THEN n->>'effort' ELSE '' END AS own_effort,COALESCE(n->>'kind','') AS kind,
		CASE WHEN jsonb_typeof(n->'evolution')='object' AND jsonb_typeof(n->'evolution'->'change')='string' THEN n->'evolution'->>'change' ELSE '' END AS mark
	FROM canvases c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.document->'nodes')='array' THEN c.document->'nodes' ELSE '[]'::jsonb END) n
	WHERE c.tenant_id=$1 AND c.id=$2 AND jsonb_typeof(n)='object'`

// canvasEvolutionView is canvas cid's evolution: its two switches, its latest canvas run, what is due, its limits with
// how many auto reruns the last day saw, and its log (the latest evolutionLogShown).
func canvasEvolutionView(ctx context.Context, q querier, tid, cid string) (map[string]any, error) {
	plan, err := planCanvasEvolution(ctx, q, tid, cid)
	if err != nil {
		return nil, err
	}
	log, err := rowsJSON(ctx, q, `WITH t AS MATERIALIZED (`+evolutionTitlesSQL+`)
		SELECT `+evolutionEntrySQL+` FROM canvas_evolution_log e LEFT JOIN t ON t.id=e.node_id
		WHERE e.tenant_id=$1 AND e.canvas_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT $3`, tid, cid, evolutionLogShown)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"autoApply": evolutionSwitch{On: plan.applyAt != nil, Since: plan.applyAt},
		"autoRerun": evolutionSwitch{On: plan.rerunAt != nil, Since: plan.rerunAt},
		"latestRun": plan.latest,
		"pending":   map[string]any{"apply": plan.apply, "revert": plan.revert, "rerun": plan.rerun},
		"limits": map[string]int{"rerunsLastDay": plan.lastDay, "rerunsPerDay": autoRerunsPerDay, "revertAfterRuns": autoRevertAfterRuns,
			"changeEveryHours": int(autoChangeEvery.Hours()), "changesPerWeek": autoChangesPerWindow},
		"log": log,
	}, nil
}

// dueChanges are the suggested efforts the nodes that failed in canvas run gid take: for each such node, its latest
// open effort suggestion of a lesson its failure in gid wrote or counted again (not effort tuning's, which nodes that
// did well are given), as the 经验 panel offers it (lessonSuggests: a higher effort only once its failure came twice),
// one the node does not run at yet, for a node a plan may change, not answered for gid's end yet, and not changed in
// the last autoChangeEvery, nor autoChangesPerWindow times in autoChangeWindow (each change counted from when it was
// made, one under way from its claim; a change let go counts for neither).
func dueChanges(ctx context.Context, q querier, tid, cid, gid string) ([]evolutionStep, error) {
	rows, err := q.Query(ctx, `WITH nodes AS MATERIALIZED (`+evolutionNodesSQL+`)
		SELECT DISTINCT ON (l.node_id) l.id,l.node_id,nd.title,l.kind,l.proposal,l.seen,nd.own_effort,
			CASE l.proposal WHEN 'lower_effort' THEN 'low' ELSE 'medium' END,COALESCE(NULLIF(nd.model,''),l.scope->>'model','')
		FROM canvas_lessons l
		JOIN nodes nd ON nd.id=l.node_id AND nd.changeable
		JOIN graph_run_nodes rn ON rn.tenant_id=l.tenant_id AND rn.graph_id=$3 AND rn.node_id=l.node_id AND rn.state='failed'
		WHERE l.tenant_id=$1 AND l.canvas_id=$2 AND l.status='active' AND l.proposal_state='open' AND l.kind<>'effort_tuning'
			AND l.evidence @> jsonb_build_array(jsonb_build_object('graphId',$3::text))
			AND ((l.proposal='lower_effort' AND nd.effort<>'low') OR (l.proposal='raise_effort' AND l.seen>=2 AND nd.effort='low'))
			AND NOT EXISTS (SELECT 1 FROM canvas_evolution_log e WHERE e.tenant_id=l.tenant_id AND e.canvas_id=l.canvas_id AND e.node_id=l.node_id
				AND (e.graph_id=$3 OR (e.auto AND e.kind IN ('effort','revert') AND `+liveChangeSQL+` AND COALESCE(e.done_at,e.created_at)>clock_timestamp()-$4::bigint*interval '1 second')))
			AND (SELECT count(*) FROM canvas_evolution_log e WHERE e.tenant_id=l.tenant_id AND e.canvas_id=l.canvas_id AND e.node_id=l.node_id
				AND e.auto AND e.kind IN ('effort','revert') AND `+liveChangeSQL+` AND COALESCE(e.done_at,e.created_at)>clock_timestamp()-$5::bigint*interval '1 second')<$6
		ORDER BY l.node_id,l.last_seen_at DESC,l.id`,
		tid, cid, gid, int64(autoChangeEvery.Seconds()), int64(autoChangeWindow.Seconds()), autoChangesPerWindow)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []evolutionStep{}
	for rows.Next() {
		var s evolutionStep
		if err = rows.Scan(&s.LessonID, &s.NodeID, &s.NodeTitle, &s.Kind, &s.Proposal, &s.Seen, &s.From, &s.Effort, &s.Model); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// dueReverts are the effort changes the canvas's evolution made that did not help: the change of effort a node's mark
// names (the change that set its effort last: a person's own edit takes the mark away), done, not reverted and not being
// reverted (a revert of it undone brings the mark back, not the change; one let go counts for nothing), the node still at
// its effort and no change of it under way, whose
// node's first autoRevertAfterRuns runs after it at that effort, of those that
// judge a change of effort (revertJudgedCodes, and every run that was done), all failed, once none of its runs since the
// change can still come before them: no canvas run of the canvas is under way, and each run of the node admitted since
// in an ended canvas run, of those recordGraphOutcomes records (a node done with its run, or failed; not in a
// collaboration, which records none), has its outcome (one recorded late, or never, may be among the first: the node
// then is never reverted by itself); not answered for the end of gid (the latest
// canvas run) yet, and for a node changed fewer than autoChangesPerWindow times in autoChangeWindow (a revert waits for
// no autoChangeEvery). A change a person took back, or changed again, is not reverted, nor one whose first runs did
// well.
func dueReverts(ctx context.Context, q querier, tid, cid, gid string) ([]evolutionStep, error) {
	rows, err := q.Query(ctx, `WITH nodes AS MATERIALIZED (`+evolutionNodesSQL+`),
		last AS (SELECT e.id,e.node_id,e.kind,e.lesson_id,e.from_effort,e.to_effort,e.done_at
			FROM canvas_evolution_log e JOIN nodes nd ON nd.id=e.node_id AND nd.mark=e.id WHERE e.tenant_id=$1 AND e.canvas_id=$2)
		SELECT last.id,last.node_id,nd.title,last.to_effort,last.from_effort,
			COALESCE(NULLIF(nd.model,''),(SELECT l.scope->>'model' FROM canvas_lessons l WHERE l.tenant_id=$1 AND l.id=last.lesson_id),'')
		FROM last JOIN nodes nd ON nd.id=last.node_id AND nd.changeable
		WHERE last.kind='effort' AND last.done_at IS NOT NULL AND nd.own_effort=last.to_effort
			AND NOT EXISTS (SELECT 1 FROM canvas_evolution_log x WHERE x.tenant_id=$1 AND x.kind='revert' AND x.reverts_id=last.id
				AND (x.done_at IS NOT NULL OR x.created_at>clock_timestamp()-interval '`+strconv.Itoa(int(evolutionClaimWait.Seconds()))+` seconds'))
			AND NOT EXISTS (SELECT 1 FROM canvas_evolution_log x WHERE x.tenant_id=$1 AND x.canvas_id=$2 AND x.node_id=last.node_id
				AND x.kind IN ('effort','revert') AND x.done_at IS NULL AND x.created_at>clock_timestamp()-interval '`+strconv.Itoa(int(evolutionClaimWait.Seconds()))+` seconds')
			AND (SELECT count(*) FILTER (WHERE first.state='failed') FROM (SELECT o.state FROM node_outcomes o
				WHERE o.tenant_id=$1 AND o.canvas_id=$2 AND o.node_id=last.node_id AND o.ran_at>last.done_at AND o.effort=last.to_effort
					AND (o.state='done' OR o.code=ANY($5::text[]) OR starts_with(o.code,'delivery_'))
				ORDER BY o.ran_at,o.graph_id LIMIT $3) first)=$3
			AND NOT EXISTS (SELECT 1 FROM graph_runs g WHERE g.tenant_id=$1 AND g.canvas_id=$2 AND g.status IN ('queued','running'))
			AND NOT EXISTS (SELECT 1 FROM graph_runs g JOIN graph_run_nodes n ON n.tenant_id=g.tenant_id AND n.graph_id=g.id AND n.node_id=last.node_id
				LEFT JOIN runs r ON r.tenant_id=n.tenant_id AND r.id=n.run_id
				WHERE g.tenant_id=$1 AND g.canvas_id=$2 AND g.status IN ('completed','failed','interrupted') AND g.collaboration IS NULL AND g.updated_at>last.done_at
					AND (n.state='failed' OR (n.state='done' AND n.run_id IS NOT NULL)) AND COALESCE(r.created_at,g.created_at)>last.done_at
					AND NOT EXISTS (SELECT 1 FROM node_outcomes o WHERE o.tenant_id=g.tenant_id AND o.graph_id=g.id AND o.node_id=n.node_id))
			AND NOT EXISTS (SELECT 1 FROM canvas_evolution_log e WHERE e.tenant_id=$1 AND e.canvas_id=$2 AND e.node_id=last.node_id AND e.graph_id=$4)
			AND (SELECT count(*) FROM canvas_evolution_log e WHERE e.tenant_id=$1 AND e.canvas_id=$2 AND e.node_id=last.node_id
				AND e.auto AND e.kind IN ('effort','revert') AND `+liveChangeSQL+` AND COALESCE(e.done_at,e.created_at)>clock_timestamp()-$6::bigint*interval '1 second')<$7
		ORDER BY last.node_id`, tid, cid, autoRevertAfterRuns, gid, revertJudgedCodes, int64(autoChangeWindow.Seconds()), autoChangesPerWindow)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []evolutionStep{}
	for rows.Next() {
		s := evolutionStep{Kind: "revert"}
		if err = rows.Scan(&s.RevertsID, &s.NodeID, &s.NodeTitle, &s.From, &s.Effort, &s.Model); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// rerunScope is what an auto rerun of canvas run gid runs: the nodes of its scope that did not finish in it (failed,
// or blocked by one that did), still on the canvas, in the run's order. None for a run in which no node failed, or in
// which a person stopped one.
func rerunScope(ctx context.Context, q querier, tid, cid, gid string) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT rn.node_id FROM graph_runs g JOIN graph_run_nodes rn ON rn.tenant_id=g.tenant_id AND rn.graph_id=g.id
		WHERE g.tenant_id=$1 AND g.canvas_id=$2 AND g.id=$3 AND rn.state IN ('failed','blocked') AND jsonb_typeof(g.scope)='array' AND g.scope ? rn.node_id
			AND rn.node_id IN (`+canvasNodeIDsSQL+`)
			AND EXISTS (SELECT 1 FROM graph_run_nodes f WHERE f.tenant_id=g.tenant_id AND f.graph_id=g.id AND f.state='failed')
			AND NOT EXISTS (SELECT 1 FROM graph_run_nodes x WHERE x.tenant_id=g.tenant_id AND x.graph_id=g.id AND x.state='cancelled')
		ORDER BY rn.ordinal,rn.node_id`, tid, cid, gid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// heldSQL is whether the canvas as saved (nodes: evolutionNodesSQL) holds log row e's change: its node runs at the
// change's effort and carries the change's mark (evolution.change, which the page writes on the node as it makes the
// change: CanvasSurface's applyEvolution). A person's own edit to the same effort carries no mark, and holds nothing.
const heldSQL = `COALESCE((SELECT n.own_effort=e.to_effort AND n.mark=e.id FROM nodes n WHERE n.id=e.node_id),false)`

// settleEvolutionClaims settles, in transaction tx, the changes of canvas cid as the canvas as saved now holds them
// (heldSQL). One it holds is done, as of now, as its settle would make it, audited as actor's ("" for none): under way, or
// let go (a skip with no reason, which only the expiry writes: the change made after all, by a save that failed and went
// through later, or a draft restored), unless an entry of its kind holds its place by then. Called in the transaction of
// each save of the canvas, as well as in claims and settles, a change is done with the save that made it, whether or not
// its page lives to say so, and one whose recording failed is recorded at the next. A claim let go (older than
// evolutionClaimWait) that it does not hold becomes a skip with no reason, which answers its run's end and counts as no
// change; one under way is left to its page.
func settleEvolutionClaims(ctx context.Context, tx pgx.Tx, tid, cid, actor string) error {
	rows, err := tx.Query(ctx, `WITH nodes AS MATERIALIZED (`+evolutionNodesSQL+`)
		SELECT e.id,CASE WHEN e.kind<>'skip' THEN e.kind WHEN e.reverts_id IS NULL THEN 'effort' ELSE 'revert' END,e.kind='skip',
			e.lesson_id,e.reverts_id,`+heldSQL+`,`+liveChangeSQL+`
		FROM canvas_evolution_log e WHERE e.tenant_id=$1 AND e.canvas_id=$2
			AND ((e.kind IN ('effort','revert') AND e.done_at IS NULL) OR (e.kind='skip' AND e.reason=''))
		ORDER BY e.created_at,e.id`, tid, cid)
	if err != nil {
		return err
	}
	type claim struct {
		id, kind          string
		letGo, held, live bool
		lesson, reverts   *string
	}
	claims := []claim{}
	for rows.Next() {
		var c claim
		if err = rows.Scan(&c.id, &c.kind, &c.letGo, &c.lesson, &c.reverts, &c.held, &c.live); err != nil {
			rows.Close()
			return err
		}
		claims = append(claims, c)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for _, c := range claims {
		switch {
		case c.held && c.letGo:
			// A change let go comes back as what it was, unless one of its kind for its node at its run's end, or a revert of
			// the same change, holds its place by now.
			var tag pgconn.CommandTag
			if tag, err = tx.Exec(ctx, `UPDATE canvas_evolution_log e SET kind=$3 WHERE e.tenant_id=$1 AND e.id=$2 AND e.kind='skip'
				AND NOT EXISTS (SELECT 1 FROM canvas_evolution_log y WHERE y.tenant_id=e.tenant_id AND y.graph_id=e.graph_id AND y.node_id=e.node_id AND y.kind=$3)
				AND NOT EXISTS (SELECT 1 FROM canvas_evolution_log y WHERE y.tenant_id=e.tenant_id AND y.reverts_id=e.reverts_id AND y.kind='revert')`,
				tid, c.id, c.kind); err == nil && tag.RowsAffected() == 1 {
				if err = markEvolutionDone(ctx, tx, tid, c.id, c.kind, c.lesson, c.reverts); err == nil {
					err = audit(ctx, tx, actor, tid, "canvas_evolution."+c.kind, c.id)
				}
			}
		case c.held:
			if err = markEvolutionDone(ctx, tx, tid, c.id, c.kind, c.lesson, c.reverts); err == nil {
				err = audit(ctx, tx, actor, tid, "canvas_evolution."+c.kind, c.id)
			}
		case !c.letGo && !c.live:
			_, err = tx.Exec(ctx, "UPDATE canvas_evolution_log SET kind='skip',reason='',done_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", tid, c.id)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// settleEvolutionBySave settles, in the transaction of a save of canvas cid, the changes of its evolution the save makes
// (settleEvolutionClaims), as actor's. A savepoint holds them: a failure of their own leaves the save as it is (logged),
// and the changes to the next save, claim or settle, which find them by their marks.
func (a *App) settleEvolutionBySave(ctx context.Context, tx pgx.Tx, tid, cid, actor string) {
	savepoint, err := tx.Begin(ctx)
	if err == nil {
		if err = settleEvolutionClaims(ctx, savepoint, tid, cid, actor); err == nil {
			err = savepoint.Commit(ctx)
		} else {
			_ = savepoint.Rollback(ctx)
		}
	}
	if err != nil {
		a.log.Warn("a canvas save's changes of its evolution were not settled", "error_type", errorType(err))
	}
}

// markEvolutionDone settles change id done: a change taken marks its suggestion applied (offered again only for a
// failure after it, canvas_lessons.go); one reverted sets the suggestion behind it aside, so that it is not made again.
func markEvolutionDone(ctx context.Context, tx pgx.Tx, tid, id, kind string, lesson, reverts *string) error {
	if _, err := tx.Exec(ctx, "UPDATE canvas_evolution_log SET done_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", tid, id); err != nil {
		return err
	}
	var err error
	if kind == "effort" && lesson != nil {
		_, err = tx.Exec(ctx, `UPDATE canvas_lessons SET proposal_state='applied',proposal_at=clock_timestamp(),updated_at=clock_timestamp()
			WHERE tenant_id=$1 AND id=$2`, tid, *lesson)
	} else if kind == "revert" && reverts != nil {
		_, err = tx.Exec(ctx, `UPDATE canvas_lessons l SET proposal_state='dismissed',proposal_at=clock_timestamp(),updated_at=clock_timestamp()
			FROM canvas_evolution_log e WHERE e.tenant_id=$1 AND e.id=$2 AND l.tenant_id=e.tenant_id AND l.id=e.lesson_id`, tid, *reverts)
	}
	return err
}

// canvasEvolution answers a canvas's evolution (canvasEvolutionView) to any member.
func (a *App) canvasEvolution(w http.ResponseWriter, r *http.Request) {
	tid, cid := r.PathValue("tenantId"), r.PathValue("canvasId")
	var exists bool
	if err := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM canvases WHERE tenant_id=$1 AND id=$2)", tid, cid).Scan(&exists); err != nil {
		a.dbError(w, err)
		return
	}
	if !exists {
		fail(w, 404, "not_found", "Canvas not found")
		return
	}
	view, err := canvasEvolutionView(r.Context(), a.db, tid, cid)
	if err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, view)
}

// evolutionWrite opens the transaction of a write to canvas cid's evolution by a member who may run it (the workspace
// row locked first, the role as it stands now): nil, with the reply written, when it may not go on.
func (a *App) evolutionWrite(w http.ResponseWriter, r *http.Request, tid, cid string) pgx.Tx {
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		a.dbError(w, err)
		return nil
	}
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		_ = tx.Rollback(r.Context())
		return nil
	}
	var exists bool
	if err = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM canvases WHERE tenant_id=$1 AND id=$2)", tid, cid).Scan(&exists); err != nil || !exists {
		_ = tx.Rollback(r.Context())
		if err != nil {
			a.dbError(w, err)
		} else {
			fail(w, 404, "not_found", "Canvas not found")
		}
		return nil
	}
	return tx
}

// commitEvolution commits tx and answers canvas cid's evolution as it now stands, under key (or as the whole reply).
func (a *App) commitEvolution(w http.ResponseWriter, r *http.Request, tx pgx.Tx, tid, cid string, extra map[string]any) {
	view, err := canvasEvolutionView(r.Context(), tx, tid, cid)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		a.dbError(w, err)
		return
	}
	if extra == nil {
		writeJSON(w, 200, view)
		return
	}
	extra["evolution"] = view
	writeJSON(w, 200, extra)
}

// updateCanvasEvolution turns a canvas's switches on or off, for a member who may run it. A switch turned on that was on
// keeps when it was turned on; one turned off forgets it. Each change of a switch is audited; it answers the evolution.
func (a *App) updateCanvasEvolution(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AutoApply *bool `json:"autoApply"`
		AutoRerun *bool `json:"autoRerun"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if b.AutoApply == nil && b.AutoRerun == nil {
		fail(w, 400, "invalid_input", "Say which switch to change: autoApply or autoRerun")
		return
	}
	tid, cid := r.PathValue("tenantId"), r.PathValue("canvasId")
	tx := a.evolutionWrite(w, r, tid, cid)
	if tx == nil {
		return
	}
	defer tx.Rollback(r.Context())
	actor := currentUser(r).ID
	var wasApply, wasRerun bool
	if err := tx.QueryRow(r.Context(), `SELECT COALESCE(bool_or(apply_at IS NOT NULL),false),COALESCE(bool_or(rerun_at IS NOT NULL),false)
		FROM canvas_auto_evolution WHERE tenant_id=$1 AND canvas_id=$2`, tid, cid).Scan(&wasApply, &wasRerun); err != nil {
		a.dbError(w, err)
		return
	}
	if _, err := tx.Exec(r.Context(), `INSERT INTO canvas_auto_evolution AS s(tenant_id,canvas_id,apply_at,apply_by,rerun_at,rerun_by)
		VALUES($1,$2,CASE WHEN $3::boolean THEN clock_timestamp() END,CASE WHEN $3::boolean THEN $5 END,
			CASE WHEN $4::boolean THEN clock_timestamp() END,CASE WHEN $4::boolean THEN $5 END)
		ON CONFLICT (tenant_id,canvas_id) DO UPDATE SET
			apply_at=CASE WHEN $3::boolean IS NULL THEN s.apply_at WHEN $3 THEN COALESCE(s.apply_at,clock_timestamp()) END,
			apply_by=CASE WHEN $3::boolean IS NULL THEN s.apply_by WHEN $3 THEN CASE WHEN s.apply_at IS NULL THEN $5 ELSE s.apply_by END END,
			rerun_at=CASE WHEN $4::boolean IS NULL THEN s.rerun_at WHEN $4 THEN COALESCE(s.rerun_at,clock_timestamp()) END,
			rerun_by=CASE WHEN $4::boolean IS NULL THEN s.rerun_by WHEN $4 THEN CASE WHEN s.rerun_at IS NULL THEN $5 ELSE s.rerun_by END END,
			updated_at=clock_timestamp()`, tid, cid, b.AutoApply, b.AutoRerun, actor); err != nil {
		a.dbError(w, err)
		return
	}
	for _, change := range []struct {
		action   string
		value    *bool
		previous bool
	}{{"canvas_evolution.apply", b.AutoApply, wasApply}, {"canvas_evolution.rerun", b.AutoRerun, wasRerun}} {
		if change.value == nil || *change.value == change.previous {
			continue
		}
		action := change.action + "_off"
		if *change.value {
			action = change.action + "_on"
		}
		if err := audit(r.Context(), tx, actor, tid, action, cid); err != nil {
			a.dbError(w, err)
			return
		}
	}
	a.commitEvolution(w, r, tx, tid, cid, nil)
}

// claimCanvasEvolution claims a change of the canvas's evolution before the canvas page makes it, answering the change
// claimed (from the node's own effort to the one the server names) with the evolution:
//   - lessonId: a lesson's suggested effort, due now for node nodeId at the end of canvas run graphId (the latest), auto
//     apply being on;
//   - revertsId: the revert of an effort change, due now (auto), or one a person takes back (auto false): an effort
//     change done, not reverted, its node still at the effort it set and carrying its mark (409 evolution_changed
//     otherwise).
//
// A step not due as it stands is refused (409 evolution_not_due); one recorded already, too (409 evolution_recorded).
// What the claim's own settling of the canvas recorded (settleEvolutionClaims) stays, whatever its answer.
func (a *App) claimCanvasEvolution(w http.ResponseWriter, r *http.Request) {
	var b struct {
		GraphID   string `json:"graphId"`
		NodeID    string `json:"nodeId"`
		LessonID  string `json:"lessonId"`
		RevertsID string `json:"revertsId"`
		Auto      *bool  `json:"auto"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	auto := b.Auto == nil || *b.Auto
	if b.GraphID == "" || b.NodeID == "" || len(b.NodeID) > 200 || (b.LessonID == "") == (b.RevertsID == "") || (!auto && b.LessonID != "") {
		fail(w, 400, "invalid_input", "A change names its canvas run, its node, and either the lesson it takes or the change it reverts")
		return
	}
	tid, cid := r.PathValue("tenantId"), r.PathValue("canvasId")
	tx := a.evolutionWrite(w, r, tid, cid)
	if tx == nil {
		return
	}
	defer tx.Rollback(r.Context())
	ctx := r.Context()
	if err := settleEvolutionClaims(ctx, tx, tid, cid, ""); err != nil {
		a.dbError(w, err)
		return
	}
	// A claim refused keeps what the settling above recorded.
	refuse := func(status int, code, message string) {
		if err := tx.Commit(ctx); err != nil {
			a.dbError(w, err)
			return
		}
		fail(w, status, code, message)
	}
	kind, from, to := "effort", "", ""
	lessonID, reverts := any(nil), any(nil)
	if auto {
		plan, err := planCanvasEvolution(ctx, tx, tid, cid)
		if err != nil {
			a.dbError(w, err)
			return
		}
		if plan.applyAt == nil {
			refuse(409, "auto_apply_off", "This canvas does not apply its suggestions by itself")
			return
		}
		steps := plan.apply
		if b.RevertsID != "" {
			steps = plan.revert
		}
		i := slices.IndexFunc(steps, func(s evolutionStep) bool {
			return s.NodeID == b.NodeID && s.LessonID == b.LessonID && s.RevertsID == b.RevertsID
		})
		if plan.latest == nil || plan.latest.ID != b.GraphID || i < 0 {
			refuse(409, "evolution_not_due", "That change is not due for this canvas as it stands")
			return
		}
		from, to = steps[i].From, steps[i].Effort
	} else {
		var node, graph, changeTo, changeFrom string
		var reverted bool
		err := tx.QueryRow(ctx, `SELECT e.node_id,e.graph_id,e.from_effort,e.to_effort,EXISTS (SELECT 1 FROM canvas_evolution_log x
				WHERE x.tenant_id=e.tenant_id AND x.kind='revert' AND x.reverts_id=e.id)
			FROM canvas_evolution_log e WHERE e.tenant_id=$1 AND e.canvas_id=$2 AND e.id=$3 AND e.kind='effort' AND e.done_at IS NOT NULL`,
			tid, cid, b.RevertsID).Scan(&node, &graph, &changeFrom, &changeTo, &reverted)
		if noRows(err) {
			refuse(404, "not_found", "Change not found")
			return
		}
		if err != nil {
			a.dbError(w, err)
			return
		}
		if node != b.NodeID || graph != b.GraphID {
			refuse(409, "evolution_mismatch", "That change was not made to that node at that run's end")
			return
		}
		if reverted {
			refuse(409, "evolution_reverted", "That change was taken back already")
			return
		}
		var stands bool
		if err = tx.QueryRow(ctx, `WITH nodes AS (`+evolutionNodesSQL+`) SELECT EXISTS (SELECT 1 FROM nodes WHERE id=$3 AND own_effort=$4 AND mark=$5)`,
			tid, cid, b.NodeID, changeTo, b.RevertsID).Scan(&stands); err != nil {
			a.dbError(w, err)
			return
		}
		if !stands {
			refuse(409, "evolution_changed", "That node was changed since: there is nothing to take back")
			return
		}
		from, to = changeTo, changeFrom
	}
	if b.LessonID != "" {
		lessonID = b.LessonID
	} else {
		kind, reverts = "revert", b.RevertsID
	}
	id := randomID()
	_, err := tx.Exec(ctx, `INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,kind,auto,node_id,lesson_id,graph_id,reverts_id,from_effort,to_effort,actor_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, id, tid, cid, kind, auto, b.NodeID, lessonID, b.GraphID, reverts, from, to, currentUser(r).ID)
	if uniqueViolation(err) {
		_ = tx.Rollback(ctx)
		fail(w, 409, "evolution_recorded", "This change is recorded already")
		return
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	change, err := oneJSON(ctx, tx, `WITH t AS MATERIALIZED (`+evolutionTitlesSQL+`) SELECT `+evolutionEntrySQL+`
		FROM canvas_evolution_log e LEFT JOIN t ON t.id=e.node_id WHERE e.tenant_id=$1 AND e.canvas_id=$2 AND e.id=$3`, tid, cid, id)
	if err != nil {
		a.dbError(w, err)
		return
	}
	a.commitEvolution(w, r, tx, tid, cid, map[string]any{"change": json.RawMessage(change)})
}

// settleCanvasEvolution settles a change claimed: done, once the canvas as saved holds it (heldSQL: 409
// evolution_unsaved before; the save that made it has as a rule settled it already), which marks the suggestion it took
// applied, or for a revert sets the suggestion behind the change aside; or
// skipped, with why the page could not make it (in the words it showed), which answers its run's end and counts as no
// change. A change is settled once (409 evolution_settled; the same settle again is answered as it was), and not once
// its claim was let go (409 evolution_expired). Each settle is audited; it answers the evolution.
func (a *App) settleCanvasEvolution(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Done    bool   `json:"done"`
		Skipped string `json:"skipped"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	skipped := strings.TrimSpace(b.Skipped)
	if b.Done == (skipped != "") || len([]rune(skipped)) > 300 {
		fail(w, 400, "invalid_input", "A change is settled as done, or skipped with a reason of at most 300 characters")
		return
	}
	tid, cid, id := r.PathValue("tenantId"), r.PathValue("canvasId"), r.PathValue("changeId")
	tx := a.evolutionWrite(w, r, tid, cid)
	if tx == nil {
		return
	}
	defer tx.Rollback(r.Context())
	ctx := r.Context()
	var kind, node, to, reason string
	var lesson, reverts *string
	var settled, live bool
	err := tx.QueryRow(ctx, `SELECT e.kind,e.node_id,e.to_effort,e.lesson_id,e.reverts_id,e.reason,e.done_at IS NOT NULL,`+liveChangeSQL+`
		FROM canvas_evolution_log e WHERE e.tenant_id=$1 AND e.canvas_id=$2 AND e.id=$3 FOR UPDATE`, tid, cid, id).
		Scan(&kind, &node, &to, &lesson, &reverts, &reason, &settled, &live)
	if noRows(err) {
		fail(w, 404, "not_found", "Change not found")
		return
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	// The same settle again (its answer lost on the way) is answered as it was; any other settle of a settled change is
	// refused.
	if settled || (kind != "effort" && kind != "revert") {
		if (b.Done && (kind == "effort" || kind == "revert")) || (!b.Done && kind == "skip" && reason == skipped) {
			a.commitEvolution(w, r, tx, tid, cid, nil)
			return
		}
		fail(w, 409, "evolution_settled", "This change is settled already")
		return
	}
	// A claim older than evolutionClaimWait is settled as the canvas as saved holds it (settleEvolutionClaims): a done
	// settle of one the canvas holds is answered as done; any other is refused, as the claim was let go.
	if !live {
		if err = settleEvolutionClaims(ctx, tx, tid, cid, ""); err == nil {
			err = tx.QueryRow(ctx, "SELECT kind,done_at IS NOT NULL FROM canvas_evolution_log WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&kind, &settled)
		}
		if err != nil {
			a.dbError(w, err)
			return
		}
		if b.Done && settled && kind != "skip" {
			a.commitEvolution(w, r, tx, tid, cid, nil)
			return
		}
		if err = tx.Commit(ctx); err != nil {
			a.dbError(w, err)
			return
		}
		fail(w, 409, "evolution_expired", "This change was claimed too long ago, and was let go")
		return
	}
	action := "canvas_evolution.skip"
	if b.Done {
		var held bool
		if err = tx.QueryRow(ctx, `WITH nodes AS (`+evolutionNodesSQL+`) SELECT EXISTS (SELECT 1 FROM nodes WHERE id=$3 AND own_effort=$4 AND mark=$5)`,
			tid, cid, node, to, id).Scan(&held); err != nil {
			a.dbError(w, err)
			return
		}
		if !held {
			fail(w, 409, "evolution_unsaved", "The canvas as saved does not run that node at that effort, marked with this change")
			return
		}
		if err = markEvolutionDone(ctx, tx, tid, id, kind, lesson, reverts); err != nil {
			a.dbError(w, err)
			return
		}
		action = "canvas_evolution." + kind
	} else if _, err = tx.Exec(ctx, "UPDATE canvas_evolution_log SET kind='skip',reason=$3,done_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
		tid, id, skipped); err != nil {
		a.dbError(w, err)
		return
	}
	if err = audit(ctx, tx, currentUser(r).ID, tid, action, id); err != nil {
		a.dbError(w, err)
		return
	}
	if err = settleEvolutionClaims(ctx, tx, tid, cid, ""); err != nil {
		a.dbError(w, err)
		return
	}
	a.commitEvolution(w, r, tx, tid, cid, nil)
}

// uniqueViolation is whether err is a unique constraint's refusal.
func uniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// graphRunID is the shape of a canvas run's id (randomID).
var graphRunID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

// autoRerunParent is the canvas run an auto rerun's operation id names: ok for an operation id of an auto rerun
// (autoRerunPrefix), with parent "" for one whose id does not name a run as AwwO names them.
func autoRerunParent(operationID string) (parent string, ok bool) {
	parent, ok = strings.CutPrefix(operationID, autoRerunPrefix)
	if !ok || !graphRunID.MatchString(parent) {
		parent = ""
	}
	return parent, ok
}

// claimAutoRerun admits canvas run newID (being admitted in tx, under its canvas row's lock, after createGraphRun recorded
// the changes the saved canvas holds: settleEvolutionClaims) as the auto rerun of canvas run parent: only while the
// canvas's auto rerun is on; of the canvas's latest canvas run before it, once it failed,
// was learnt from and ended while the switch was on, and is no auto rerun itself; once its changes are settled; once; at
// most autoRerunsPerDay in a day; and only of nodes its rerunScope holds. It answers a refusal's code and message, or
// "" with the rerun logged.
func claimAutoRerun(ctx context.Context, tx pgx.Tx, tid, cid, parent, newID, actor string, scope []string) (string, string, error) {
	var rerunAt *time.Time
	if err := tx.QueryRow(ctx, "SELECT rerun_at FROM canvas_auto_evolution WHERE tenant_id=$1 AND canvas_id=$2", tid, cid).Scan(&rerunAt); err != nil && !noRows(err) {
		return "", "", err
	}
	if rerunAt == nil {
		return "auto_rerun_off", "This canvas does not rerun its unfinished nodes by itself", nil
	}
	latest, err := latestCanvasRun(ctx, tx, tid, cid, newID)
	if err != nil {
		return "", "", err
	}
	if latest == nil || latest.ID != parent || latest.Status != "failed" || !latest.Learnt || latest.EndedAt.Before(*rerunAt) {
		return "auto_rerun_stale", "Only the canvas's latest run, once it failed and was learnt from, is rerun by itself", nil
	}
	if latest.AutoRerun {
		return "auto_rerun_chained", "A rerun's own unfinished nodes are not rerun by themselves", nil
	}
	if latest.RerunID != nil {
		return "auto_rerun_done", "That run was rerun by itself already", nil
	}
	claimed, err := changesInFlight(ctx, tx, tid, cid, parent)
	if err != nil {
		return "", "", err
	}
	if claimed {
		return "auto_rerun_pending", "The canvas is still taking its changes of that run's end", nil
	}
	lastDay, err := autoRerunsLastDay(ctx, tx, tid, cid)
	if err != nil {
		return "", "", err
	}
	if lastDay >= autoRerunsPerDay {
		return "auto_rerun_limit", "This canvas reran its unfinished nodes by itself as often as a day allows", nil
	}
	unfinished, err := rerunScope(ctx, tx, tid, cid, parent)
	if err != nil {
		return "", "", err
	}
	if len(scope) == 0 || slices.ContainsFunc(scope, func(id string) bool { return !slices.Contains(unfinished, id) }) {
		return "auto_rerun_scope", "A rerun runs only nodes that did not finish in the run it reruns", nil
	}
	id := randomID()
	if _, err = tx.Exec(ctx, `INSERT INTO canvas_evolution_log(id,tenant_id,canvas_id,kind,graph_id,rerun_graph_id,actor_id,done_at)
		VALUES($1,$2,$3,'rerun',$4,$5,$6,clock_timestamp())`, id, tid, cid, parent, newID, actor); err != nil {
		return "", "", err
	}
	return "", "", audit(ctx, tx, actor, tid, "canvas_evolution.rerun", id)
}
