package app

import (
	"context"
	"encoding/json"
	"regexp"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// Canvas RSI, the record (the 2026-10-31 plan's 1.1: 每个节点结束写一条结果经验). Each node a canvas run ran leaves one row
// in node_outcomes (migration 050), written once, in the transaction that writes the run's lessons
// (distillGraphLessons): the node's role (its template), what it delivers, the runtime, model and reasoning effort it
// ran with, how it ended in the platform's codes, how many attempts it took, how many lessons and skills it was given,
// and the tokens, cost, credits and worker time its runs took. Nothing a prompt, an output or a refusal said is in it:
// it is the record every workspace's runs leave without their content (the owner's option A for learning data,
// 2026-10-31), and what effort tuning counts. A row goes with its canvas run, and so with its canvas and workspace.
//
// Effort tuning (the plan's 1.3: effort 按经验调). A node that keeps finishing on its first attempt at its reasoning
// effort, of a template whose runs on the same model finish as well at low with less output, in runs from at least two
// workspaces, is suggested low: a lesson of kind effort_tuning, which gives a model nothing and carries the suggestion
// lower_effort, which the 经验 panel applies as a plan the person takes there. A node put at low that then fails to
// deliver is suggested medium again (lessonProposal's raise_effort), so the loop comes back by itself where low did not
// do, and low is not suggested again to a node that did not finish first time at low in the counts' window.

const (
	// Effort tuning counts the outcomes of the last effortTuningWindow, read again at most every effortStatsEvery.
	effortTuningWindow = 14 * 24 * time.Hour
	effortStatsEvery   = 10 * time.Minute
	// Low is suggested where the template's runs on the model at low finished on their first attempt at least as often
	// as at the node's effort, less effortTuningMargin, stopped at the output limit no more often, and those done first
	// time wrote less output on average.
	effortTuningMargin = 0.05
)

// effortTuningLimits are how much evidence effort tuning needs: runs of the template on the model at low and at the
// node's effort (minRuns each), the workspaces the low runs came from, and the node's own first-pass runs at its
// effort. The zero value (an App no test set them on) is defaultEffortTuning.
type effortTuningLimits struct{ minRuns, minWorkspaces, ownRuns int }

var defaultEffortTuning = effortTuningLimits{minRuns: 20, minWorkspaces: 2, ownRuns: 3}

func (a *App) effortTuning() effortTuningLimits {
	if a.effortTuningLimits != (effortTuningLimits{}) {
		return a.effortTuningLimits
	}
	return defaultEffortTuning
}

// effortKey and effortStat are the platform's outcome counts for one template on one model at one effort: the node
// runs, those done on their first attempt, those that stopped at the output limit, the workspaces they came from, and
// the output tokens of the runs done first time whose usage is known, with how many those are.
type effortKey struct{ template, model, effort string }
type effortStat struct {
	runs, firstPass, outputLimit, workspaces, outputRuns int
	output                                               int64
}

// effortStatsCache holds the counts between reads (effortStatsEvery).
type effortStatsCache struct {
	mu    sync.Mutex
	at    time.Time
	stats map[effortKey]effortStat
}

// effortStatsNow are the platform's outcome counts of the last effortTuningWindow. When they cannot be read, the ones
// read last stay until the next read (no lesson waits for them; none is suggested without them).
func (a *App) effortStatsNow(ctx context.Context) map[effortKey]effortStat {
	a.effortStats.mu.Lock()
	defer a.effortStats.mu.Unlock()
	if !a.effortStats.at.IsZero() && time.Since(a.effortStats.at) < effortStatsEvery {
		return a.effortStats.stats
	}
	a.effortStats.at = time.Now()
	read, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	rows, err := a.db.Query(read, `SELECT template,model,effort,count(*),count(*) FILTER (WHERE state='done' AND attempts=0),
		count(*) FILTER (WHERE code='output_limit'),count(DISTINCT tenant_id),count(output_tokens) FILTER (WHERE state='done' AND attempts=0),
		COALESCE(sum(output_tokens) FILTER (WHERE state='done' AND attempts=0),0)::bigint FROM node_outcomes
		WHERE ran_at>now()-$1::bigint*interval '1 millisecond' AND run_id IS NOT NULL AND template<>'' AND model<>'' GROUP BY template,model,effort`,
		effortTuningWindow.Milliseconds())
	if err != nil {
		a.log.Warn("the platform's node outcomes were not read", "error_type", errorType(err))
		return a.effortStats.stats
	}
	stats := map[effortKey]effortStat{}
	for rows.Next() {
		var k effortKey
		var s effortStat
		if rows.Scan(&k.template, &k.model, &k.effort, &s.runs, &s.firstPass, &s.outputLimit, &s.workspaces, &s.outputRuns, &s.output) == nil {
			stats[k] = s
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		a.log.Warn("the platform's node outcomes were not read", "error_type", errorType(err))
		return a.effortStats.stats
	}
	a.effortStats.stats = stats
	return stats
}

// effortTuningSuggests is whether a node of template on model at effort, with own first-pass runs of its own there,
// would do as well at low, by the platform's counts.
func effortTuningSuggests(stats map[effortKey]effortStat, template, model, effort string, own int, limits effortTuningLimits) bool {
	low, at := stats[effortKey{template, model, "low"}], stats[effortKey{template, model, effort}]
	if effort == "low" || own < limits.ownRuns || low.runs < limits.minRuns || low.workspaces < limits.minWorkspaces || at.runs < limits.minRuns {
		return false
	}
	if low.outputRuns == 0 || at.outputRuns == 0 {
		return false
	}
	lowPass, atPass := float64(low.firstPass)/float64(low.runs), float64(at.firstPass)/float64(at.runs)
	lowStop, atStop := float64(low.outputLimit)/float64(low.runs), float64(at.outputLimit)/float64(at.runs)
	lowOut, atOut := float64(low.output)/float64(low.outputRuns), float64(at.output)/float64(at.outputRuns)
	return lowPass >= atPass-effortTuningMargin && lowStop <= atStop && lowOut < atOut
}

// outcomeNode is what the record reads of a node of the canvas run's frozen document.
type outcomeNode struct {
	ID         string         `json:"id"`
	TemplateID string         `json:"templateId"`
	Contract   *graphContract `json:"contract"`
	// Team and AgentRef: a node whose own setup decides its model and effort, which a plan does not change.
	Team     bool `json:"team"`
	AgentRef bool `json:"agentRef"`
}

// graphOutcomeNodesSQL is what the record reads of canvas run $2's frozen document, node by node ($1 its workspace).
const graphOutcomeNodesSQL = `SELECT COALESCE(jsonb_agg(jsonb_build_object('id',n->'id','templateId',n->'templateId',
	'contract',CASE WHEN jsonb_typeof(n->'contract')='object' THEN n->'contract' END,
	'team',jsonb_typeof(n->'team')='object','agentRef',COALESCE(jsonb_typeof(n->'agentRef') NOT IN ('null'),false))),'[]'::jsonb)
	FROM graph_runs g CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(g.document->'nodes')='array' THEN g.document->'nodes' ELSE '[]'::jsonb END) n
	WHERE g.tenant_id=$1 AND g.id=$2 AND jsonb_typeof(n)='object'`

// platformCode is the shape of the platform's own codes, the only words of how a node ended the record keeps.
var platformCode = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// outcomeCode is how a node ended, in the platform's codes: "" when it was done; a delivery its outputs refused, by its
// reason (deliveryRefusals); its run's error code, or its own (a refusal at admission); or "other".
func outcomeCode(f lessonFailure) string {
	if f.state == "done" {
		return ""
	}
	if f.runID != "" && f.runStatus == "completed" {
		if reason := deliveryReason(f.detail); reason != "" {
			return "delivery_" + reason
		}
	}
	for _, code := range []string{f.runError, f.detail} {
		if platformCode.MatchString(code) {
			return code
		}
	}
	return "other"
}

// outcomeEffort is the reasoning effort a run ran at: its snapshot's, or its model's default where it chose none (""
// for a model without levels).
func outcomeEffort(snap executionSnapshot) string {
	if snap.Effort != "" {
		return snap.Effort
	}
	for _, m := range snap.Health.Models {
		if m.ID == snap.Model && len(m.ReasoningEfforts) > 0 {
			return m.DefaultReasoningEffort
		}
	}
	return ""
}

// nodeOutcome is one node's record, as recordGraphOutcomes wrote it, with what effort tuning reads of it.
type nodeOutcome struct {
	nodeID, runID, template, model, effort, state string
	attempts                                      int
	admitted                                      time.Time
	node                                          outcomeNode
	snap                                          executionSnapshot
}

// graphOutcomeNodes is what the record reads of canvas run gid's frozen document, by node id.
func graphOutcomeNodes(ctx context.Context, tx pgx.Tx, tid, gid string) (map[string]outcomeNode, error) {
	var raw []byte
	if err := tx.QueryRow(ctx, graphOutcomeNodesSQL, tid, gid).Scan(&raw); err != nil {
		return nil, err
	}
	parsed := []outcomeNode{}
	_ = json.Unmarshal(raw, &parsed)
	nodes := map[string]outcomeNode{}
	for _, n := range parsed {
		nodes[n.ID] = n
	}
	return nodes, nil
}

// recordGraphOutcomes writes, in transaction tx, the record of each node of canvas run gid that ran or was refused at
// admission (settled: the nodes as distillGraphLessons read them, with their earlier attempts' runs), and returns what
// it wrote. A row that cannot be written is left out (logged): the run's lessons never wait for it.
func (a *App) recordGraphOutcomes(ctx context.Context, tx pgx.Tx, tid, canvasID, gid string, nodes map[string]outcomeNode, settled []lessonFailure, attemptRuns map[string][]string) []nodeOutcome {
	written := []nodeOutcome{}
	for _, f := range settled {
		if (f.state != "done" && f.state != "failed") || (f.runID == "" && f.state == "done") {
			continue
		}
		var snap executionSnapshot
		if len(f.snapshot) > 0 {
			_ = json.Unmarshal(f.snapshot, &snap)
		}
		node := nodes[f.nodeID]
		facts := graphExperienceFacts(graphNode{TemplateID: node.TemplateID, Contract: node.Contract}, f.snapshot)
		effort := outcomeEffort(snap)
		if snap.Media != nil {
			effort = ""
		}
		var lessons, skills int
		if snap.Lessons != nil {
			lessons = len(snap.Lessons.Items)
		}
		if snap.Skills != nil {
			skills = len(snap.Skills.Items)
		}
		runs := append([]string{}, attemptRuns[f.nodeID]...)
		if f.runID != "" {
			runs = append(runs, f.runID)
		}
		o := nodeOutcome{nodeID: f.nodeID, runID: f.runID, template: facts.role, model: facts.model, effort: effort, state: f.state, attempts: f.attempts,
			admitted: f.admitted, node: node, snap: snap}
		if err := sideWrite(ctx, tx, `INSERT INTO node_outcomes(tenant_id,canvas_id,graph_id,node_id,run_id,template,output_type,runtime,model,effort,state,code,
			attempts,lessons,skills,ran_at,input_tokens,output_tokens,cached_input_tokens,cache_write_tokens,reasoning_tokens,cost_microusd,credits,worker_ms)
			SELECT $1,$2,$3,$4,NULLIF($5,''),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$17,sum(m.input_tokens)::bigint,sum(m.output_tokens)::bigint,
				sum(m.cached_input_tokens)::bigint,sum(m.cache_write_tokens)::bigint,sum(m.reasoning_tokens)::bigint,sum(m.estimated_cost_microusd)::bigint,
				sum(m.credit_charge)::bigint,sum(m.worker_total_ms)::bigint
			FROM (SELECT 1) one LEFT JOIN model_invocations m ON m.tenant_id=$1 AND m.run_id=ANY($16::text[])
			ON CONFLICT (tenant_id,graph_id,node_id) DO NOTHING`,
			tid, canvasID, gid, f.nodeID, f.runID, clip(o.template, 32), clip(facts.outputType, 64), clip(facts.runtime, 32), clip(o.model, 200), clip(effort, 32),
			f.state, outcomeCode(f), f.attempts, lessons, skills, runs, f.admitted); err != nil {
			a.log.Warn("a canvas node's outcome was not recorded", "error_type", errorType(err))
			continue
		}
		written = append(written, o)
	}
	return written
}

// clip keeps the first n bytes of s, whole runes only.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && n < len(s) && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n]
}

// tuneGraphEfforts writes, in transaction tx, an effort_tuning lesson for each node of the canvas run's outcomes that
// could run at low as well as at its effort (effortTuningSuggests): a node done on its first attempt, an Agent of a
// template (no team, no workspace Agent, no media), on a model that takes low, which has finished on its first attempt
// at its effort often enough before, and never ran on the model at low without finishing first time (a node put back
// from low, raise_effort, is not sent there again) in the counts' window.
func (a *App) tuneGraphEfforts(ctx context.Context, tx pgx.Tx, tid, canvasID, gid string, outcomes []nodeOutcome) error {
	var stats map[effortKey]effortStat
	limits := a.effortTuning()
	for _, o := range outcomes {
		if o.state != "done" || o.attempts != 0 || o.effort == "" || o.effort == "low" || o.node.Team || o.node.AgentRef || o.snap.Team != nil ||
			o.snap.Media != nil || o.snap.Market != nil || !slices.Contains(planAgentTemplateIDs, o.template) || lessonProposal("effort_tuning", o.snap) != "lower_effort" {
			continue
		}
		if stats == nil {
			stats = a.effortStatsNow(ctx)
		}
		own, missedAtLow, err := nodeEffortHistory(ctx, tx, tid, canvasID, o.nodeID, o.model, o.effort)
		if err != nil {
			return err
		}
		if missedAtLow > 0 || !effortTuningSuggests(stats, o.template, o.model, o.effort, own, limits) {
			continue
		}
		scope, _ := json.Marshal(map[string]string{"runtime": snapshotRuntime(o.snap), "model": o.snap.Model, "effort": o.snap.Effort})
		evidence, _ := json.Marshal([]map[string]any{{"graphId": gid, "runId": o.runID, "code": "effort_tuning"}})
		if err := writeNodeLesson(ctx, tx, tid, canvasID, o.nodeID, "effort_tuning", lessonDescriptions["effort_tuning"], scope, evidence, "lower_effort", o.admitted); err != nil {
			return err
		}
	}
	return nil
}

// nodeEffortHistory is what node nodeID of canvas canvasID ran on model in the counts' window, by when each run ran: its
// runs done on their first attempt at effort, and its runs at low that were not.
func nodeEffortHistory(ctx context.Context, tx pgx.Tx, tid, canvasID, nodeID, model, effort string) (own, missedAtLow int, err error) {
	err = tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE effort=$5 AND state='done' AND attempts=0),
		count(*) FILTER (WHERE effort='low' AND run_id IS NOT NULL AND NOT (state='done' AND attempts=0))
		FROM node_outcomes WHERE tenant_id=$1 AND canvas_id=$2 AND node_id=$3 AND model=$4 AND ran_at>now()-$6::bigint*interval '1 millisecond'`,
		tid, canvasID, nodeID, model, effort, effortTuningWindow.Milliseconds()).Scan(&own, &missedAtLow)
	return own, missedAtLow, err
}
