package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type teamMember struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Role         string   `json:"role"`
	Instructions string   `json:"instructions"`
	Runtime      string   `json:"runtime"`
	Model        string   `json:"model"`
	Context      string   `json:"context"`
	Tools        []string `json:"tools"`
}
type nodeTeam struct {
	Version        int          `json:"version"`
	Mode           string       `json:"mode"`
	Runtime        string       `json:"runtime"`
	MaxRounds      int          `json:"maxRounds"`
	MaxTurns       int          `json:"maxTurns"`
	TimeoutSeconds int          `json:"timeoutSeconds"`
	Members        []teamMember `json:"members"`
}
type executionSnapshot struct {
	Instructions     string             `json:"instructions"`
	Model            string             `json:"model"`
	Budget           int                `json:"budget"`
	Overhead         int                `json:"overhead"`
	Team             *nodeTeam          `json:"team,omitempty"`
	Health           piHealth           `json:"health"`
	History          *[]json.RawMessage `json:"history,omitempty"`
	HistoryAvailable int                `json:"historyAvailable,omitempty"`
}

func validateTeam(t *nodeTeam) error {
	if t == nil {
		return nil
	}
	if t.Version != 1 || t.Runtime != "pi" || t.MaxRounds < 1 || t.MaxRounds > 8 || t.MaxTurns < 1 || t.MaxTurns > 64 || t.TimeoutSeconds < 10 || t.TimeoutSeconds > 1800 || len(t.Members) < 1 || len(t.Members) > 8 {
		return errors.New("Invalid team version, runtime, bounds or member count")
	}
	switch t.Mode {
	case "sequential", "parallel", "debate":
	case "review":
		if len(t.Members) < 2 {
			return errors.New("Review requires at least two members")
		}
	default:
		return errors.New("Unsupported collaboration mode")
	}
	ids := map[string]bool{}
	for _, m := range t.Members {
		if strings.TrimSpace(m.ID) == "" || utf8.RuneCountInString(m.ID) > 128 || ids[m.ID] || strings.TrimSpace(m.Name) == "" || utf8.RuneCountInString(m.Name) > 128 || strings.TrimSpace(m.Role) == "" || utf8.RuneCountInString(m.Role) > 512 || utf8.RuneCountInString(m.Instructions) > 16000 || utf8.RuneCountInString(m.Model) > 256 || (m.Runtime != "" && m.Runtime != "pi") || len(m.Tools) > 0 || (m.Context != "task" && m.Context != "shared") {
			return errors.New("Invalid member identity, runtime, model, context or tools")
		}
		ids[m.ID] = true
	}
	// A complete first pass must fit. Later review passes may exhaust the explicit budget.
	if t.MaxTurns < len(t.Members) {
		return errors.New("Turn budget cannot complete one team pass")
	}
	return nil
}
func (h piHealth) modelLimits(model string) (int, int, bool) {
	if model == "" || model == h.Model {
		b, o := h.contextLimits()
		return b, o, true
	}
	for _, m := range h.Models {
		if m.ID == model {
			b, o := m.MaxContextTextBytes, m.MessageOverheadBytes
			if b <= 0 || b > 262144 {
				b = 262144
			}
			return b, o, true
		}
	}
	return 0, 0, false
}
func validateTeamModels(t *nodeTeam, h piHealth) error {
	if err := validateTeam(t); err != nil {
		return err
	}
	if t == nil {
		return nil
	}
	for _, m := range t.Members {
		if _, _, ok := h.modelLimits(m.Model); !ok {
			return fmt.Errorf("Team member %s selects an unavailable model", m.Name)
		}
	}
	return nil
}
func savedNodeTeam(raw []byte, nodeID string) (*nodeTeam, error) {
	var d struct {
		Nodes []struct {
			ID      string          `json:"id"`
			Team    json.RawMessage `json:"team"`
			Runtime string          `json:"runtime"`
		} `json:"nodes"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return nil, errors.New("Invalid canvas")
	}
	for _, n := range d.Nodes {
		if n.ID == nodeID {
			if n.Runtime != "" && n.Runtime != "pi" {
				return nil, errors.New("Unsupported node runtime")
			}
			if len(n.Team) == 0 || string(n.Team) == "null" {
				return nil, nil
			}
			var t nodeTeam
			dec := json.NewDecoder(strings.NewReader(string(n.Team)))
			dec.DisallowUnknownFields()
			if dec.Decode(&t) != nil {
				return nil, errors.New("Invalid team configuration")
			}
			return &t, validateTeam(&t)
		}
	}
	return nil, nil
}
func (a *App) runTurns(w http.ResponseWriter, r *http.Request) {
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	var exists bool
	if e := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM runs WHERE tenant_id=$1 AND id=$2)", tid, id).Scan(&exists); e != nil {
		a.dbError(w, e)
		return
	}
	if !exists {
		fail(w, 404, "not_found", "Run not found")
		return
	}
	v, e := rowsJSON(r.Context(), a.db, `SELECT jsonb_build_object('id',id,'memberId',member_id,'memberName',member_name,'role',role,'round',round,'ordinal',ordinal,'status',status,'output',output,'error',error,'model',config->>'model','runtime',config->>'runtime','config',config,'prompt',prompt,'systemPrompt',system_prompt,'messages',messages,'context',context,'createdAt',created_at,'updatedAt',updated_at) FROM run_turns WHERE tenant_id=$1 AND run_id=$2 ORDER BY ordinal`, tid, id)
	a.replyList(w, v, e)
}

var errInvocationQuota = errors.New("quota_exceeded")

// Admission is serialized with tenant mutations. Every actual provider invocation,
// including each team member, consumes one durable admission; uncertain calls are not retried.
func (a *App) reserveInvocation(ctx context.Context, tid, rid, invID string) error {
	for {
		tx, e := a.db.Begin(ctx)
		if e != nil {
			return e
		}
		var status, actor, runStatus string
		var concurrent, daily int
		e = tx.QueryRow(ctx, "SELECT status,max_concurrent_runs,max_runs_per_day FROM tenants WHERE id=$1 FOR UPDATE", tid).Scan(&status, &concurrent, &daily)
		if e == nil {
			e = tx.QueryRow(ctx, "SELECT COALESCE(actor_id,''),status FROM runs WHERE tenant_id=$1 AND id=$2", tid, rid).Scan(&actor, &runStatus)
		}
		if e == nil && runStatus == "cancelled" {
			e = context.Canceled
		}
		if e == nil && (status != "active" || (runStatus != "queued" && runStatus != "running")) {
			e = errors.New("execution_revoked")
		}
		if e == nil && actor != "" {
			var role string
			e = tx.QueryRow(ctx, "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, actor).Scan(&role)
			if e == nil && role != "owner" && role != "admin" && role != "member" {
				e = errors.New("execution_revoked")
			}
		}
		var active, today int
		if e == nil {
			e = tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status='running'),count(*) FILTER(WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') FROM model_invocations WHERE tenant_id=$1`, tid).Scan(&active, &today)
		}
		if e == nil && today >= daily {
			e = errInvocationQuota
		}
		if e != nil {
			tx.Rollback(context.Background())
			return e
		}
		if active < concurrent {
			_, e = tx.Exec(ctx, "INSERT INTO model_invocations(id,tenant_id,run_id,status) VALUES($1,$2,$3,'running')", invID, tid, rid)
			if e == nil {
				e = tx.Commit(ctx)
			} else {
				tx.Rollback(context.Background())
			}
			return e
		}
		tx.Rollback(context.Background())
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(40 * time.Millisecond):
		}
	}
}
func (a *App) completeInvocation(tid, id, status string) {
	_ = a.persistExecution(func(ctx context.Context) error {
		_, e := a.db.Exec(ctx, "UPDATE model_invocations SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'", tid, id, status)
		return e
	})
}
func (a *App) settleRunInvocation(tid, id string) {
	ctx, c := context.WithTimeout(context.Background(), 5*time.Second)
	defer c()
	status := "failed"
	if e := a.db.QueryRow(ctx, "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2", tid, id).Scan(&status); e != nil || status == "running" || status == "queued" {
		status = "failed"
	}
	a.completeInvocation(tid, id, status)
}

type teamCall func(context.Context, teamMember, int, int, teamTurnInput) (string, error)

// runTeam is deterministic orchestration: outputs are data, never executable instructions.
// shared means earlier completed turns are supplied, task means only the task; aggregation
// and review necessarily receive their explicit operands regardless of context preference.
func runTeam(ctx context.Context, t nodeTeam, task string, call teamCall) (string, error) {
	ordinal := 0
	transcript := []teamOutput{}
	invoke := func(m teamMember, round int, extra, purpose string, force bool) (string, error) {
		ordinal++
		if ordinal > t.MaxTurns {
			return "", errors.New("team_turn_budget_exhausted")
		}
		input := teamTurnInput{Task: task, Instruction: extra, Purpose: purpose, Required: force}
		if m.Context == "shared" || force {
			input.Upstream = append([]teamOutput{}, transcript...)
		}
		out, err := call(ctx, m, round, ordinal, input)
		if err == nil {
			transcript = append(transcript, teamOutput{teamSource: teamSource{MemberID: m.ID, MemberName: m.Name, Round: round, Ordinal: ordinal}, Output: out})
		}
		return out, err
	}
	var out string
	var err error
	switch t.Mode {
	case "sequential":
		for _, m := range t.Members {
			out, err = invoke(m, 1, "", "work", false)
			if err != nil {
				return "", err
			}
		}
	case "parallel":
		if len(t.Members) == 1 {
			return invoke(t.Members[0], 1, "", "work", false)
		}
		workers := t.Members[:len(t.Members)-1]
		results := make([]string, len(workers))
		errs := make([]error, len(workers))
		var wg sync.WaitGroup
		workCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		for i, m := range workers {
			wg.Add(1)
			go func(i int, m teamMember) {
				defer wg.Done()
				results[i], errs[i] = call(workCtx, m, 1, i+1, teamTurnInput{Task: task, Purpose: "work"})
				if errs[i] != nil {
					cancel()
				}
			}(i, m)
		}
		wg.Wait()
		ordinal = len(workers)
		for i, m := range workers {
			if errs[i] != nil {
				return "", errs[i]
			}
			transcript = append(transcript, teamOutput{teamSource: teamSource{MemberID: m.ID, MemberName: m.Name, Round: 1, Ordinal: i + 1}, Output: results[i]})
		}
		out, err = invoke(t.Members[len(t.Members)-1], 1, "Summarize the member outputs into the final node result. Follow the task's output contract.", "aggregate", true)
	case "debate":
		for round := 1; round <= t.MaxRounds; round++ {
			for _, m := range t.Members {
				out, err = invoke(m, round, "Discuss and critically evaluate the task and available arguments. Identify disagreements and improvements.", "work", false)
				if err != nil {
					return "", err
				}
			}
		}
		out, err = invoke(t.Members[len(t.Members)-1], t.MaxRounds+1, "Resolve the discussion and return the final node result, following the task's output contract.", "aggregate", true)
	case "review":
		for round := 1; round <= t.MaxRounds; round++ {
			for _, m := range t.Members[:len(t.Members)-1] {
				out, err = invoke(m, round, "Produce or improve the deliverable. Address the previous review feedback when provided.", "revise", round > 1)
				if err != nil {
					return "", err
				}
			}
			verdict, reviewErr := invoke(t.Members[len(t.Members)-1], round, `Review the latest deliverable. Return ONLY strict JSON: {"approved":boolean,"output":string,"feedback":string}. When approved, output MUST contain the approved final deliverable matching the original task output contract. Otherwise provide actionable feedback.`, "review", true)
			if reviewErr != nil {
				return "", reviewErr
			}
			var v struct {
				Approved *bool   `json:"approved"`
				Output   *string `json:"output"`
				Feedback string  `json:"feedback"`
			}
			dec := json.NewDecoder(strings.NewReader(verdict))
			dec.DisallowUnknownFields()
			if dec.Decode(&v) != nil || v.Approved == nil || v.Output == nil || dec.Decode(&struct{}{}) != io.EOF {
				return "", errors.New("invalid_review_verdict")
			}
			if *v.Approved {
				return *v.Output, nil
			}
		}
		return "", errors.New("review_rounds_exhausted")
	default:
		return "", errors.New("invalid_team_mode")
	}
	return out, err
}
func (a *App) executeTeam(ctx context.Context, tid, rid, sid, prompt string, snap executionSnapshot) {
	t := *snap.Team
	ctx, cancel := context.WithTimeout(ctx, time.Duration(t.TimeoutSeconds)*time.Second)
	defer cancel()
	output, err := runTeam(ctx, t, prompt, func(ctx context.Context, m teamMember, round, ordinal int, input teamTurnInput) (string, error) {
		return a.executeTeamTurn(ctx, tid, rid, sid, snap, m, round, ordinal, input)
	})
	if err != nil {
		status, code := "failed", err.Error()
		if errors.Is(ctx.Err(), context.Canceled) {
			status, code = "cancelled", ""
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code = "team_timeout"
		}
		a.finish(tid, rid, status, "", code)
		return
	}
	a.finish(tid, rid, "completed", output, "")
}
func (a *App) executeTeamTurn(ctx context.Context, tid, rid, sid string, snap executionSnapshot, m teamMember, round, ordinal int, input teamTurnInput) (result string, resultErr error) {
	if m.Model == "" {
		m.Model = snap.Model
	}
	m.Runtime = "pi"
	budget, overhead, ok := snap.Health.modelLimits(m.Model)
	if !ok {
		return "", errors.New("model_unavailable")
	}
	prompt, instructions, history, inputContext, err := prepareTeamInput(snap, m, input, budget, overhead)
	if err != nil {
		return "", err
	}
	messagesRaw, _ := json.Marshal(history)
	contextRaw, _ := json.Marshal(inputContext)
	id := randomID()
	body, _ := json.Marshal(map[string]any{"runId": id, "tenantId": tid, "sessionId": sid + "_" + tokenHash(m.ID)[:16], "prompt": prompt, "messages": history, "systemPrompt": instructions, "model": m.Model, "runtime": "pi"})
	if len(body) > 1<<20 {
		return "", errors.New("context_limit")
	}
	config, _ := json.Marshal(m)
	if _, e := a.db.Exec(ctx, "INSERT INTO run_turns(id,tenant_id,run_id,member_id,member_name,role,round,ordinal,config,status,prompt,system_prompt,messages,context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11,$12,$13)", id, tid, rid, m.ID, m.Name, m.Role, round, ordinal, config, prompt, instructions, messagesRaw, contextRaw); e != nil {
		return "", errors.New("turn_persistence_failed")
	}
	output := ""
	status := "failed"
	code := ""
	contextFailure := func(err error) bool {
		if errors.Is(err, context.Canceled) {
			status, code = "cancelled", ""
			return true
		}
		if errors.Is(err, context.DeadlineExceeded) {
			code = "team_timeout"
			return true
		}
		return false
	}
	defer func() {
		// A member cannot contribute to aggregation until both its deliverable
		// and released concurrency slot commit together.
		err := a.persistExecution(func(c context.Context) error {
			tx, e := a.db.Begin(c)
			if e != nil {
				return e
			}
			defer tx.Rollback(c)
			if _, e = tx.Exec(c, "UPDATE run_turns SET status=$3,output=$4,error=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running')", tid, id, status, output, code); e != nil {
				return e
			}
			if _, e = tx.Exec(c, "UPDATE model_invocations SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'", tid, id, status); e != nil {
				return e
			}
			return tx.Commit(c)
		})
		if err != nil {
			result, resultErr = "", errors.New("turn_persistence_failed")
		}
	}()
	if e := a.reserveInvocation(ctx, tid, rid, id); e != nil {
		code = e.Error()
		contextFailure(e)
		return "", e
	}
	if _, e := a.db.Exec(ctx, "UPDATE run_turns SET status='running',updated_at=now() WHERE tenant_id=$1 AND id=$2", tid, id); e != nil {
		if contextFailure(e) {
			return "", e
		}
		code = "turn_persistence_failed"
		return "", errors.New(code)
	}
	// Parent cancellation stops this request context, but Pi's active map is
	// keyed by this turn ID. Explicit cleanup also covers interrupted admission
	// and broken streams, using a fresh bounded context after ctx is cancelled.
	// Parallel members clean up independently before their slots are released.
	defer func() {
		if status != "completed" {
			a.cancelPI(id)
		}
	}()
	resp, e := a.admitPI(ctx, body)
	if e != nil {
		if contextFailure(e) {
			return "", e
		}
		code = "runtime_unavailable"
		return "", errors.New(code)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		code = "runtime_rejected"
		return "", errors.New(code)
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var ev struct{ Type, Delta, Text string }
		if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &ev) != nil {
			code = "invalid_runtime_event"
			return "", errors.New(code)
		}
		switch ev.Type {
		case "text_delta":
			if len(output)+len(ev.Delta) > 2<<20 {
				code = "output_limit"
				return "", errors.New(code)
			}
			output += ev.Delta
			if _, e = a.db.Exec(ctx, "UPDATE run_turns SET output=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'", tid, id, output); e != nil {
				if contextFailure(e) {
					return "", e
				}
				code = "turn_persistence_failed"
				return "", errors.New(code)
			}
		case "completed":
			if len(ev.Text) > 2<<20 || !strings.HasPrefix(ev.Text, output) {
				code = "inconsistent_runtime_output"
				return "", errors.New(code)
			}
			output = ev.Text
			status = "completed"
			return output, nil
		case "cancelled":
			status = "cancelled"
			return "", context.Canceled
		case "failed":
			code = "runtime_failed"
			return "", errors.New(code)
		default:
			code = "invalid_runtime_event"
			return "", errors.New(code)
		}
	}
	code = "runtime_stream_ended"
	if contextFailure(ctx.Err()) {
		return "", ctx.Err()
	}
	return "", errors.New(code)
}

// Kept here to make transaction ownership explicit for snapshot admission helpers.
func saveRunSnapshot(ctx context.Context, tx pgx.Tx, tid, rid, actor string, snap executionSnapshot) error {
	raw, _ := json.Marshal(snap)
	var team any
	if snap.Team != nil {
		team, _ = json.Marshal(snap.Team)
	}
	_, e := tx.Exec(ctx, "UPDATE runs SET execution_snapshot=$3,team_snapshot=$4,actor_id=NULLIF($5,'') WHERE tenant_id=$1 AND id=$2", tid, rid, raw, team, actor)
	return e
}
