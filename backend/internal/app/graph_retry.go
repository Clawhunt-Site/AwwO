package app

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Canvas RSI, loop 1 (R-1): a canvas node whose run failed for a transient reason runs again by itself.
//
// A plain graph node (never a collaboration turn) whose child run ended failed with a code in graphRetryableCodes goes
// back to waiting while its graph still runs and it has a retry left (AWWO_GRAPH_NODE_RETRIES, default 2, 0 turns this
// off). In one transaction its attempts count goes up, retry_at is set after graphRetryBackoff, the failed run is
// appended to its attempt_log, its detail says retrying, and one canvas_experiences row (kind retry, outcome pending)
// records it. The node keeps naming the failed run until its next attempt replaces it. The scheduler admits it again
// only once retry_at has passed, through the admission every node takes (allowances, plan slots, one active run per
// node session), so each attempt is a run of its own, counted and billed as one; downstream nodes wait meanwhile, as
// they do for a node still running. When the node settles, its pending experiences take the outcome it reached:
// succeeded for done, failed for any other end.
//
// Never retried: what the request or the model itself decided (output and context limits, an invalid contract, a
// refusal, a rejected credential, refused content or parameters, an empty provider balance, a workspace step limit),
// accounting failures, a cancelled run or graph, and an interrupted run, whose provider outcome is uncertain (its
// executor was lost, and the executor settles those without replay). A refusal at admission (quota, plan) is not a
// run's failure and settles the node as before. A generation that failed as media_failed runs again only when its
// provider charged nothing for it (mediaRunUnbilled).

// graphRetryableCodes are the run error codes a canvas node is retried for: the closed list of the Canvas RSI design.
var graphRetryableCodes = map[string]bool{
	"runtime_rejected":           true,
	"runtime_unavailable":        true,
	"runtime_session_busy":       true,
	"runtime_stream_ended":       true,
	"provider_unavailable":       true,
	"provider_rate_limited":      true,
	"runtime_failed":             true,
	"run_timeout":                true,
	"workspace_unavailable":      true,
	"workspace_admission_failed": true,
	"media_provider_unavailable": true,
	"media_provider_busy":        true,
	"media_result_unavailable":   true,
	"media_failed":               true,
	"media_motion_failed":        true,
}

const (
	defaultGraphNodeRetries = 2
	maxGraphNodeRetries     = 5
	// The first retry waits graphRetryBase, each later one twice as long as the one before, up to graphRetryMax.
	graphRetryBase = 15 * time.Second
	graphRetryMax  = 120 * time.Second
	// graphRetryingDetail is a waiting node's detail between a failed attempt and its next one.
	graphRetryingDetail = "retrying"
)

// parseGraphNodeRetries reads AWWO_GRAPH_NODE_RETRIES: how many times one canvas node may run again after a transient
// failure. Unset is 2; 0 retries nothing.
func parseGraphNodeRetries(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return defaultGraphNodeRetries, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 || n > maxGraphNodeRetries {
		return 0, errors.New("AWWO_GRAPH_NODE_RETRIES must be a whole number from 0 (no automatic retries) to 5")
	}
	return n, nil
}

// graphRetryBackoff is how long a node waits for its next attempt after retries earlier retries: 15 s, 30 s, 60 s,
// then 120 s each time. unit stands in for the 15 s (zero is 15 s; tests shorten it); the ceiling is eight units.
func graphRetryBackoff(retries int, unit time.Duration) time.Duration {
	if unit <= 0 {
		unit = graphRetryBase
	}
	ceiling := unit * (graphRetryMax / graphRetryBase)
	if retries <= 0 {
		return unit
	}
	if retries >= 3 {
		return ceiling
	}
	return min(unit<<retries, ceiling)
}

// graphNodeRetries is the retry limit in force: the configured one, kept within 0-5 for a Config not read from the
// environment.
func (a *App) graphNodeRetries() int {
	return min(max(a.cfg.GraphNodeRetries, 0), maxGraphNodeRetries)
}

// graphRetryable reports whether a node run that ended failed with code may run again. unbilled tells whether a
// generation cost nothing and is asked only for media_failed.
func graphRetryable(code string, unbilled func() bool) bool {
	if !graphRetryableCodes[code] {
		return false
	}
	return code != "media_failed" || unbilled()
}

// mediaRunUnbilled reports whether a generation's provider charged nothing for it: the provider ended the task without
// charging (unbillMedia), refused it outright (markMediaRefused), or it was never sent. One whose submission's outcome
// is unknown counts as charged, since sending it again could pay for it twice.
func (a *App) mediaRunUnbilled(ctx context.Context, tid, runID string) bool {
	var unbilled bool
	err := a.db.QueryRow(ctx, `SELECT g.provider_accepted IS NOT TRUE AND (g.provider_accepted IS FALSE OR g.provider_refused OR g.submitted_at IS NULL)
		FROM media_generations g WHERE g.tenant_id=$1 AND g.run_id=$2`, tid, runID).Scan(&unbilled)
	return err == nil && unbilled
}

// graphNodeAdmittedSQL marks node $3 of graph $2 as running its new run $4. A node that waited for its next attempt no
// longer says it is retrying; its attempts and attempt log stay.
const graphNodeAdmittedSQL = "UPDATE graph_run_nodes SET state='running',run_id=$4,retry_at=NULL,detail=CASE WHEN detail='" + graphRetryingDetail + "' THEN '' ELSE detail END WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3"

// graphChildOperationID is the operation of a plain node's run: the first attempt keeps the form every graph run has
// used, each retry adds its number, since an operation names exactly one run.
func graphChildOperationID(gid, nid string, attempts int) string {
	op := "graph:" + gid + ":" + tokenHash(nid)[:20]
	if attempts > 0 {
		op += ":retry-" + strconv.Itoa(attempts)
	}
	return op
}

// retryGraphNode moves node n of graph gid, whose run runID ended failed with code, back to waiting for its next
// attempt when its graph still runs and it has a retry left, and records the retry. retried says whether it did;
// without an error, a node that was not retried settles as before. An error means nothing was written, and the
// scheduler's next pass decides again.
func (a *App) retryGraphNode(ctx context.Context, tid, gid string, n graphNode, runID, code string) (retried bool, err error) {
	limit := a.graphNodeRetries()
	if limit == 0 {
		return false, nil
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(context.Background())
	// The graph's row lock orders a retry with a cancellation, which takes it first too: either the graph is no longer
	// running here and nothing is retried, or the cancellation finds the node waiting for its retry and ends it.
	var canvasID, status string
	if err = tx.QueryRow(ctx, "SELECT canvas_id,status FROM graph_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, gid).Scan(&canvasID, &status); err != nil {
		return false, err
	}
	if status != "running" {
		return false, nil
	}
	var attempts int
	var snapshot []byte
	err = tx.QueryRow(ctx, `SELECT n.attempts,n.execution_snapshot FROM graph_run_nodes n JOIN runs r ON r.tenant_id=n.tenant_id AND r.id=n.run_id
		WHERE n.tenant_id=$1 AND n.graph_id=$2 AND n.node_id=$3 AND n.state='running' AND n.run_id=$4 AND r.status='failed' FOR UPDATE OF n`, tid, gid, n.ID, runID).Scan(&attempts, &snapshot)
	if noRows(err) {
		return false, nil
	}
	if err != nil || attempts >= limit {
		return false, err
	}
	wait := graphRetryBackoff(attempts, a.graphRetryUnit)
	if _, err = tx.Exec(ctx, `UPDATE graph_run_nodes n SET state='waiting',detail=$6,attempts=n.attempts+1,retry_at=now()+$5::bigint*interval '1 millisecond',
		attempt_log=n.attempt_log||jsonb_build_array(jsonb_build_object('runId',r.id,'code',r.error,'endedAt',r.updated_at,'attempt',n.attempts+1))
		FROM runs r WHERE n.tenant_id=$1 AND n.graph_id=$2 AND n.node_id=$3 AND n.run_id=$4 AND r.tenant_id=n.tenant_id AND r.id=n.run_id`, tid, gid, n.ID, runID, wait.Milliseconds(), graphRetryingDetail); err != nil {
		return false, err
	}
	facts := graphExperienceFacts(n, snapshot)
	detail, _ := json.Marshal(map[string]any{"attempt": attempts + 1, "limit": limit, "waitMs": wait.Milliseconds(), "agentKind": n.AgentKind})
	if _, err = tx.Exec(ctx, `INSERT INTO canvas_experiences(id,tenant_id,canvas_id,graph_id,node_id,run_id,kind,failure_code,node_role,output_type,runtime,model,detail)
		VALUES($1,$2,$3,$4,$5,$6,'retry',$7,$8,$9,$10,$11,$12)`, randomID(), tid, canvasID, gid, n.ID, runID, code, facts.role, facts.outputType, facts.runtime, facts.model, detail); err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	a.observeGraphNodeState("waiting")
	return true, nil
}

// settleGraphExperiencesSQL gives the pending experiences of graph $2's settled nodes the outcome their node reached.
const settleGraphExperiencesSQL = `UPDATE canvas_experiences e SET outcome=CASE WHEN n.state='done' THEN 'succeeded' ELSE 'failed' END,
	detail=e.detail||jsonb_build_object('nodeState',n.state),updated_at=now()
	FROM graph_run_nodes n WHERE e.tenant_id=$1 AND e.graph_id=$2 AND e.outcome='pending' AND n.tenant_id=e.tenant_id
	AND n.graph_id=e.graph_id AND n.node_id=e.node_id AND n.state NOT IN ('waiting','running')`

// experienceFacts are what an experience records about its node, so that what is learnt from it can be scoped to
// nodes like it: the node's role (its template), what it delivers, and the runtime and model it was frozen with.
type experienceFacts struct{ role, outputType, runtime, model string }

func graphExperienceFacts(n graphNode, snapshot []byte) experienceFacts {
	f := experienceFacts{outputType: graphOutputType(n)}
	if slices.Contains(planTemplateIDs, n.TemplateID) {
		f.role = n.TemplateID
	}
	var snap executionSnapshot
	if len(snapshot) > 0 && json.Unmarshal(snapshot, &snap) == nil {
		f.runtime, f.model = snapshotRuntime(snap), snap.Model
		if snap.Media != nil {
			f.outputType, f.model = snap.Media.Kind, snap.Media.Model
		}
	}
	return f
}

// graphOutputType names what a node delivers: its contract's output field types in order, each once and joined by
// "+", or text for a node without declared outputs.
func graphOutputType(n graphNode) string {
	if n.Contract == nil || len(n.Contract.Outputs) == 0 {
		return "text"
	}
	types := []string{}
	for _, f := range n.Contract.Outputs {
		t := f.Type
		if t == "" {
			t = "text"
		}
		if !slices.Contains(types, t) {
			types = append(types, t)
		}
	}
	return strings.Join(types, "+")
}
