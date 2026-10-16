package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Launch day (2026-10-09) showed three ways a managed-execution task (直接执行) failed that were the service's doing,
// not the user's: a worker with every slot taken refused new tasks at once (computer_busy), and tasks that waited on
// their owner to allow a workspace tool or answer a question held a slot until the worker's 15-minute limit
// (TIMEOUT -> computer_execution_failed), which in turn kept the slots full. This file holds the answers to those:
// the task waits in line for a slot, tools of the isolated workspace the deployment allows are allowed without asking,
// and a question is answered for the owner with "go on with sensible defaults" (at once, unless a wait is configured).

// computerQueueWait bounds how long a task waits for a free slot on the managed-execution worker, which answers
// 429 WORKER_BUSY while every slot runs a task, before it fails as computer_busy; computerQueuePoll is how often it
// asks again. Variables so tests can shorten them.
var (
	computerQueueWait = 10 * time.Minute
	computerQueuePoll = 3 * time.Second
)

// A task's question is answered for its owner with computerQuestionFallback after Config.ComputerQuestionWait
// (AWWO_COMPUTER_QUESTION_WAIT_SECONDS, parseComputerQuestionWait). Unset or 0 answers it at once: the owner chose on
// 2026-10-11 that a task never waits on a question (「提问也不等，直接按默认继续」). A positive value first gives the
// task's owner that long to answer, at most maxComputerQuestionWait.
const maxComputerQuestionWait = 15 * time.Minute

const computerQuestionFallback = "（自动回复）请不要再提问：按最合理的默认做法直接完成任务，并在结果里写明你做了哪些假设。" +
	" Automatic reply: do not ask again; finish the task with sensible defaults and state your assumptions in the result."

// parseComputerQuestionWait reads AWWO_COMPUTER_QUESTION_WAIT_SECONDS: unset or 0 answers a task's question at once;
// 1 to 900 waits that many seconds for the owner first. Anything else is refused at startup.
func parseComputerQuestionWait(raw string) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 || time.Duration(n)*time.Second > maxComputerQuestionWait {
		return 0, errors.New("AWWO_COMPUTER_QUESTION_WAIT_SECONDS must be a whole number of seconds from 0 (answer at once) to 900")
	}
	return time.Duration(n) * time.Second, nil
}

// computerWorkspaceTools are the managed-execution worker's tools as their approval requests name them (the
// awwo_workspace MCP server of apps/openmaus-worker/transport.ts). Each acts only inside the task's own isolated
// Docker workspace: no network, a read-only root, no host mounts, CPU and memory limits, 30 s per command.
var computerWorkspaceTools = []string{"awwo_workspace_list", "awwo_workspace_read", "awwo_workspace_write",
	"awwo_workspace_exec", "awwo_workspace_publish", "awwo_workspace_archive"}

// parseComputerAutoAllow reads AWWO_COMPUTER_AUTO_ALLOW_TOOLS, the workspace tools a task may use without asking its
// owner every time: unset allows all of them (the workspace is the task's own sandbox, and on launch day owners left
// these requests unanswered until the task timed out); "none" asks for every one; otherwise a comma-separated subset.
// Only workspace tools can be named, so no other kind of request is ever answered for the owner.
func parseComputerAutoAllow(raw string) (map[string]bool, error) {
	raw = strings.TrimSpace(raw)
	allowed := map[string]bool{}
	switch raw {
	case "":
		for _, tool := range computerWorkspaceTools {
			allowed[tool] = true
		}
		return allowed, nil
	case "none":
		return allowed, nil
	}
	for _, item := range strings.Split(raw, ",") {
		tool := strings.TrimSpace(item)
		if !slices.Contains(computerWorkspaceTools, tool) {
			return nil, errors.New("AWWO_COMPUTER_AUTO_ALLOW_TOOLS lists only workspace tools (" + strings.Join(computerWorkspaceTools, ",") + "), or is none")
		}
		allowed[tool] = true
	}
	return allowed, nil
}

// startComputerTask hands the task to the worker and returns its event stream. A busy worker is asked again every
// computerQueuePoll until a slot frees or the wait runs out (computerQueueWait, and never more than half of what is
// left of the run's own deadline); meanwhile the task records computer_queued, and computer_started once it runs, so
// its card says it waits in line. Any other refusal ends the task at once, as before.
func (a *App) startComputerTask(ctx context.Context, tid, rid string, payload map[string]any) (*http.Response, bool) {
	var queuedAt time.Time
	limit := computerQueueWait
	if deadline, ok := ctx.Deadline(); ok {
		limit = min(limit, time.Until(deadline)/2)
	}
	for {
		if deadline, ok := ctx.Deadline(); ok {
			// Time spent in line comes off the task's run time, so the worker never outlasts the run.
			payload["timeoutMs"] = computerRunTimeout(min(a.cfg.RunTimeout, time.Until(deadline))).Milliseconds()
		}
		response, e := a.computerRequest(ctx, "POST", "/internal/runs", payload)
		if e != nil {
			if ctx.Err() != nil {
				a.computerStopped(tid, rid)
			} else {
				a.finish(tid, rid, "failed", "", "computer_unavailable")
			}
			return nil, false
		}
		if response.StatusCode == 200 && strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
			if !queuedAt.IsZero() {
				_ = a.computerEvent(ctx, tid, rid, map[string]any{"type": "computer_started", "waitedMs": time.Since(queuedAt).Milliseconds()})
			}
			return response, true
		}
		// The worker's reason is in its body only: log it, or a refused task leaves no trace of why.
		code := computerRefusal(response)
		response.Body.Close()
		if response.StatusCode == http.StatusTooManyRequests {
			if queuedAt.IsZero() {
				queuedAt = time.Now()
				a.log.Info("managed execution is busy; the task waits for a slot", "run", rid, "code", code)
				_ = a.computerEvent(ctx, tid, rid, map[string]string{"type": "computer_queued"})
			}
			if time.Since(queuedAt) < limit {
				select {
				case <-ctx.Done():
					a.computerStopped(tid, rid)
					return nil, false
				case <-time.After(computerQueuePoll):
				}
				if !a.computerRunActive(ctx, tid, rid) {
					if ctx.Err() != nil {
						a.computerStopped(tid, rid)
					} else {
						a.finish(tid, rid, "failed", "", "execution_revoked")
					}
					return nil, false
				}
				continue
			}
		}
		a.log.Warn("managed execution refused the task", "run", rid, "status", response.StatusCode, "code", code, "waited", time.Since(queuedAt).Round(time.Second).String())
		a.finish(tid, rid, "failed", "", computerRefusalError(response.StatusCode))
		return nil, false
	}
}

// answerUnansweredQuestion answers a task's question for its owner once Config.ComputerQuestionWait has passed without an
// answer, so a task whose owner stepped away finishes on sensible defaults instead of holding a slot until the
// worker's time limit. An answer the owner gave meanwhile wins: only a request still pending is answered. With no
// wait configured the stream answers the question itself, at once, and does not start this.
func (a *App) answerUnansweredQuestion(ctx context.Context, tid, rid, requestID string) {
	timer := time.NewTimer(a.cfg.ComputerQuestionWait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
	}
	a.autoRespondComputer(ctx, tid, rid, requestID, computerQuestionFallback, "auto_answer")
}

// autoRespondComputer allows one pending request of a running task on the service's behalf, along the owner's own
// path (respondComputer): a 'sending' receipt, the call to the worker, then the outcome; audited as
// computer.response.<reason> with no actor. A request already answered, or a task no longer running, is left alone.
// It returns the request's resulting status ("" when it left it alone).
func (a *App) autoRespondComputer(ctx context.Context, tid, rid, requestID, message, reason string) string {
	operation := "auto-" + tokenHash(rid + "\x00" + requestID)[:40]
	raw, _ := json.Marshal(map[string]string{"requestId": requestID, "behavior": "allow", "message": message, "operationId": operation})
	hash := tokenHash(rid + "\x00" + string(raw))
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return ""
	}
	defer tx.Rollback(ctx)
	var state, approval string
	if tx.QueryRow(ctx, "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, rid).Scan(&state) != nil || state != "running" {
		return ""
	}
	if tx.QueryRow(ctx, "SELECT status FROM computer_approvals WHERE tenant_id=$1 AND run_id=$2 AND request_id=$3 FOR UPDATE", tid, rid, requestID).Scan(&approval) != nil || approval != "pending" {
		return ""
	}
	if _, e = tx.Exec(ctx, "INSERT INTO computer_responses(tenant_id,operation_id,run_id,request_hash,request_id,status) VALUES($1,$2,$3,$4,$5,'sending')", tid, operation, rid, hash, requestID); e != nil {
		return ""
	}
	if _, e = tx.Exec(ctx, "UPDATE computer_approvals SET status='sending' WHERE tenant_id=$1 AND run_id=$2 AND request_id=$3", tid, rid, requestID); e != nil {
		return ""
	}
	if e = audit(ctx, tx, "", tid, "computer.response."+reason, rid); e != nil {
		return ""
	}
	if e = tx.Commit(ctx); e != nil {
		return ""
	}
	call, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	status := "unknown"
	if response, err := a.computerRequest(call, "POST", "/internal/runs/"+rid+"/respond", map[string]string{"requestId": requestID, "behavior": "allow", "message": message}); err == nil {
		var accepted struct {
			Accepted bool `json:"accepted"`
		}
		if response.StatusCode == 200 && json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&accepted) == nil && accepted.Accepted {
			status = "allowed"
		}
		response.Body.Close()
	}
	save, done := context.WithTimeout(context.Background(), 3*time.Second)
	defer done()
	if tx, e = a.db.Begin(save); e == nil {
		defer tx.Rollback(save)
		_, e = tx.Exec(save, "UPDATE computer_responses SET status=$3 WHERE tenant_id=$1 AND operation_id=$2", tid, operation, status)
		if e == nil {
			_, e = tx.Exec(save, "UPDATE computer_approvals SET status=$4,resolved_at=now() WHERE tenant_id=$1 AND run_id=$2 AND request_id=$3", tid, rid, requestID, status)
		}
		if e == nil {
			e = tx.Commit(save)
		}
	}
	if e != nil {
		status = "unknown"
	}
	a.notifyRunEvent(rid)
	a.log.Info("managed execution request answered by the service", "run", rid, "reason", reason, "status", status)
	return status
}
