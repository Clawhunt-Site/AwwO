package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Image and video nodes run as ordinary runs (composer, quota, events, transcript, cancel), but
// execute here instead of in a model worker: submit the prompt and the node's closed parameters
// to RunningHub once, record the provider task so an API restart resumes polling rather than
// paying for the generation again, poll until it finishes, then download each result into
// AWWO_MEDIA_DIR and record it as an artifact. The run's output names those artifacts.
//
// Progress is reported only as the provider's own state (queued, running) plus "saving" while
// files download; there is no invented percentage.

const (
	runtimeRunningHub  = "runninghub"
	mediaPollFailures  = 12
	mediaOutputType    = "awwo.media"
	mediaSweepInterval = time.Hour
	mediaSweepMinAge   = time.Hour
)

type mediaPlan struct {
	Version  int            `json:"version"`
	Provider string         `json:"provider"`
	Model    string         `json:"model"`
	Kind     string         `json:"kind"`
	Params   map[string]any `json:"params"`
}

type mediaItem struct {
	ArtifactID  string `json:"artifactId"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
}

// Server-generated identifiers only; anything else never becomes part of a path.
var mediaPathPart = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var mediaFileName = regexp.MustCompile(`^[0-9a-f]{64}\.(png|jpg|webp|gif|mp4|webm|mov)$`)

// mediaHub is the configured provider client, or nil when media generation is off.
func (a *App) mediaHub() *runningHub {
	if !a.cfg.mediaConfigured() {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.media == nil {
		a.media = newRunningHub(a.cfg)
	}
	return a.media
}

// savedMediaNode reads an image or video node's kind, model and parameter choices from the saved
// canvas.
func savedMediaNode(document []byte, nodeID string) (kind, model string, params json.RawMessage, err error) {
	var doc struct {
		Nodes []struct {
			ID          string          `json:"id"`
			AgentKind   string          `json:"agentKind"`
			Model       string          `json:"model"`
			MediaParams json.RawMessage `json:"mediaParams"`
		} `json:"nodes"`
	}
	if json.Unmarshal(document, &doc) != nil {
		return "", "", nil, setupError{"node_setup_required", "Initialize the node before running it"}
	}
	for _, n := range doc.Nodes {
		if n.ID == nodeID {
			return n.AgentKind, n.Model, n.MediaParams, nil
		}
	}
	return "", "", nil, setupError{"node_setup_required", "Initialize the node before running it"}
}

// mediaSnapshot freezes a media run at admission: the catalog model, its kind and the complete
// parameter values. Nothing is substituted: an unknown model, a kind or model that changed since
// the node was initialized, an unentitled model or an invalid parameter is refused. A generation
// costs money, so running the previously initialized model instead of the one now shown on the
// node is not an option.
func (a *App) mediaSnapshot(document []byte, nodeID, model, prompt string, entitlement modelEntitlement) (executionSnapshot, error) {
	if !a.cfg.mediaConfigured() {
		return executionSnapshot{}, setupError{"media_unavailable", "Image and video generation is not configured"}
	}
	m, ok := builtinMediaCatalog.model(model)
	if !ok {
		return executionSnapshot{}, setupError{"model_unavailable", "Node model is unavailable for its runtime or this workspace"}
	}
	if !a.mediaEntitled(entitlement, model) {
		return executionSnapshot{}, setupError{"model_not_allowed", "This workspace may not use the selected model"}
	}
	kind, saved, raw, err := savedMediaNode(document, nodeID)
	if err != nil {
		return executionSnapshot{}, err
	}
	if kind != m.Kind || saved != m.ID {
		return executionSnapshot{}, setupError{"node_setup_required", "Initialize the node to apply its changed type or model"}
	}
	params, err := m.resolveMediaParams(raw)
	if err != nil {
		return executionSnapshot{}, setupError{"media_params_invalid", "Node media settings are invalid for its model"}
	}
	if !m.validMediaPrompt(prompt) {
		return executionSnapshot{}, setupError{"media_prompt_invalid", fmt.Sprintf("The prompt must be %d-%d characters for this model", m.Prompt.MinLength, m.Prompt.MaxLength)}
	}
	return executionSnapshot{Runtime: runtimeRunningHub, Model: m.ID, Media: &mediaPlan{Version: 1, Provider: "runninghub", Model: m.ID, Kind: m.Kind, Params: params}}, nil
}

func (a *App) mediaAdmissionError(w http.ResponseWriter, err error) {
	var input setupError
	if !errors.As(err, &input) {
		fail(w, 500, "internal_error", "Media run admission failed")
		return
	}
	status := 400
	switch input.code {
	case "media_unavailable", "media_storage_full", "media_storage_unavailable":
		status = 503
	case "model_not_allowed":
		status = 403
	case "node_setup_required":
		status = 409
	}
	fail(w, status, input.code, input.message)
}

// createMediaRun admits a run of an image or video node. It shares createRun's transaction, so the
// workspace's concurrency limit, idempotency and session lock already apply; media adds its own
// daily limit, counted from durable run rows.
func (a *App) createMediaRun(w http.ResponseWriter, r *http.Request, tx pgx.Tx, tid string, b runInput, hash string, document []byte, nodeID, model string, entitlement modelEntitlement) {
	ctx := r.Context()
	if len(b.KnowledgeRevisionIDs) > 0 {
		fail(w, 400, "media_knowledge_unsupported", "Image and video nodes do not take knowledge context")
		return
	}
	snapshot, e := a.mediaSnapshot(document, nodeID, model, b.Prompt, entitlement)
	if e != nil {
		a.mediaAdmissionError(w, e)
		return
	}
	// Refuse before paying for a generation this host cannot store.
	if e = a.mediaStorageReady(); e != nil {
		a.mediaAdmissionError(w, e)
		return
	}
	// The workspace row is locked; the deployment-wide count takes its own lock, so neither limit
	// can be passed by concurrent admissions. Both read the clock after waiting for the locks.
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(84321010)"); e != nil {
		a.dbError(w, e)
		return
	}
	var today, total int
	if e = tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE tenant_id=$1),count(*) FROM media_generations
		WHERE created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, tid).Scan(&today, &total); e != nil {
		a.dbError(w, e)
		return
	}
	if today >= a.cfg.MediaRunsPerDay {
		fail(w, 429, "media_quota_exceeded", "This workspace has used today's image and video generations")
		return
	}
	if total >= a.cfg.MediaTotalRunsPerDay {
		fail(w, 429, "media_capacity_exceeded", "Today's image and video generations are used up; try again tomorrow")
		return
	}
	id := randomID()
	task, _ := json.Marshal(map[string]string{"provider": "runninghub", "model": snapshot.Model})
	v, e := oneJSON(ctx, tx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,media_task) VALUES($1,$2,$3,$4,$5,$6,'queued',$7) RETURNING "+runJSON, id, tid, b.SessionID, b.OperationID, hash, b.Prompt, task)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = saveRunSnapshot(ctx, tx, tid, id, currentUser(r).ID, snapshot); e != nil {
		a.dbError(w, e)
		return
	}
	if _, e = tx.Exec(ctx, "INSERT INTO media_generations(run_id,tenant_id,model,created_at) VALUES($1,$2,$3,clock_timestamp())", id, tid, snapshot.Model); e != nil {
		a.dbError(w, e)
		return
	}
	if _, e = tx.Exec(ctx, "INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES($1,$2,$3,$4,'user',$5)", randomID(), tid, b.SessionID, id, b.Prompt); e != nil {
		a.dbError(w, e)
		return
	}
	if _, e = tx.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, id, `{"type":"queued"}`); e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(ctx, tx, currentUser(r).ID, tid, "run.created", id); e != nil {
		a.dbError(w, e)
		return
	}
	if !a.workerAvailable(w) {
		return
	}
	if e = tx.Commit(ctx); e != nil {
		a.dbError(w, e)
		return
	}
	a.notifyRunEvent(id)
	a.dispatchFor(a.cfg.MediaTimeout, tid, id, "node", func(ctx context.Context) {
		a.execute(ctx, tid, id, b.SessionID, b.Prompt, "", "node", 0, 0)
	}, r.Context())
	writeJSON(w, 202, v)
}

func mediaFailureCode(err error) string {
	if e, ok := asRHError(err); ok {
		return e.Code
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "media_timeout"
	}
	return "media_failed"
}

// executeMedia submits the run once and follows it to a terminal state.
func (a *App) executeMedia(ctx context.Context, tid, id, sid, prompt string, snapshot executionSnapshot) {
	plan := snapshot.Media
	m, ok := builtinMediaCatalog.model(plan.Model)
	if !ok || m.Kind != plan.Kind || plan.Provider != "runninghub" {
		a.finish(tid, id, "failed", "", "snapshot_invalid")
		return
	}
	hub := a.mediaHub()
	if hub == nil {
		a.finish(tid, id, "failed", "", "media_unavailable")
		return
	}
	body := map[string]any{"prompt": strings.TrimSpace(prompt)}
	for name, value := range plan.Params {
		body[name] = value
	}
	// One admitted run is one provider task: a submission that may or may not have reached the
	// provider is never retried, because a retry could pay for the same generation twice. Nor is it
	// abandoned by a cancel or a shutdown: once sent it may be billed, so its task id is awaited
	// and recorded (the API client's own timeout bounds the wait).
	if a.mediaStopped(ctx, id, false) {
		return
	}
	submitCtx, cancelSubmit := context.WithTimeout(context.WithoutCancel(ctx), rhSubmitTimeout)
	task, err := hub.submit(submitCtx, m.Endpoint, body)
	cancelSubmit()
	if err != nil {
		if a.mediaStopped(ctx, id, false) {
			return
		}
		a.finish(tid, id, "failed", "", mediaFailureCode(err))
		return
	}
	if task.TaskID == "" {
		a.finish(tid, id, "failed", "", "media_provider_unavailable")
		return
	}
	recorded := a.recordMediaTask(ctx, tid, id, task.TaskID) == nil
	if !recorded {
		// Polling still works in this process; only a restart could not resume it.
		a.log.Warn("media task id not recorded", "event", "media_task_unrecorded")
	}
	a.followMedia(ctx, hub, tid, id, sid, m, task, recorded)
}

// leaveForResume marks a media run that stopped only because the API is shutting down (or lost
// its database lease) while its provider task was in flight. The run stays running in the
// database, so the next start resumes polling instead of submitting, and paying, again.
func (a *App) leaveForResume(id string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.closed {
		return false
	}
	if a.resumable == nil {
		a.resumable = map[string]bool{}
	}
	a.resumable[id] = true
	return true
}

// resumesAfterRestart reports, once, whether run id was left for the next start to resume.
func (a *App) resumesAfterRestart(id string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.resumable[id] {
		return false
	}
	delete(a.resumable, id)
	return true
}

// mediaStopped reports whether a media run's context ended for a reason other than its deadline:
// a cancel, which has already settled the run, or a shutdown, which leaves the run for the next
// start when its provider task is recorded and otherwise lets dispatch mark it interrupted.
func (a *App) mediaStopped(ctx context.Context, id string, recorded bool) bool {
	err := ctx.Err()
	if err == nil || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if recorded {
		a.leaveForResume(id)
	}
	return true
}

func (a *App) recordMediaTask(ctx context.Context, tid, id, taskID string) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	tag, e := a.db.Exec(ctx, "UPDATE runs SET media_task=COALESCE(media_task,'{}'::jsonb)||jsonb_build_object('taskId',$3::text,'submittedAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')) WHERE tenant_id=$1 AND id=$2 AND status='running'", tid, id, taskID)
	if e == nil && tag.RowsAffected() == 0 {
		return errors.New("run is no longer running")
	}
	return e
}

func (a *App) mediaStatus(ctx context.Context, tid, id, status string) {
	data, _ := json.Marshal(map[string]string{"type": "media_status", "status": status})
	if e := a.appendRunProgress(ctx, tid, id, data); e != nil && ctx.Err() == nil {
		a.log.Warn("media status not recorded", "event", "media_status_unrecorded")
	}
}

// followMedia polls a submitted task until it succeeds, fails or the run's deadline passes, then
// stores the results. recorded says whether the task id is durable, so a shutdown can leave the
// run for the next start instead of settling it.
func (a *App) followMedia(ctx context.Context, hub *runningHub, tid, id, sid string, m *mediaModel, task rhTask, recorded bool) {
	reported, failures := "", 0
	for task.Status != "SUCCESS" {
		if state := strings.ToLower(task.Status); state != reported && (state == "queued" || state == "running") {
			reported = state
			a.mediaStatus(ctx, tid, id, state)
		}
		select {
		case <-ctx.Done():
			if a.mediaStopped(ctx, id, recorded) {
				return
			}
			a.finish(tid, id, "failed", "", "media_timeout")
			return
		case <-time.After(a.cfg.MediaPollInterval):
		}
		next, err := hub.query(ctx, task.TaskID)
		if err != nil {
			if ctx.Err() != nil {
				continue
			}
			if e, ok := asRHError(err); ok && e.is("media_pending") {
				// "Still queued / running" answered as an error code: not a failure.
				failures = 0
				continue
			}
			if e, ok := asRHError(err); ok && e.Transient {
				if failures++; failures > mediaPollFailures {
					a.finish(tid, id, "failed", "", "media_provider_unavailable")
					return
				}
				continue
			}
			a.finish(tid, id, "failed", "", mediaFailureCode(err))
			return
		}
		failures = 0
		if next.TaskID == "" {
			next.TaskID = task.TaskID
		}
		if next.TaskID != task.TaskID {
			// One provider account serves every workspace: an answer about another task is never
			// stored as this run's result.
			a.finish(tid, id, "failed", "", "media_provider_unavailable")
			return
		}
		task = next
	}
	a.mediaStatus(ctx, tid, id, "saving")
	output, err := a.storeMediaResults(ctx, hub, tid, id, sid, m, task.Results)
	if err != nil {
		if a.mediaStopped(ctx, id, recorded) {
			return
		}
		a.finish(tid, id, "failed", "", mediaFailureCode(err))
		return
	}
	a.finish(tid, id, "completed", output, "")
}

type resumableMedia struct {
	tenant, run, session, task string
	elapsed                    time.Duration
}

// resumableMediaRuns lists media runs that were waiting on a provider task when the API stopped.
// They are excluded from the restart sweep and resumed: their generation is already paid for.
func resumableMediaRuns(ctx context.Context, tx pgx.Tx) ([]resumableMedia, error) {
	rows, e := tx.Query(ctx, `SELECT tenant_id,id,session_id,media_task->>'taskId',
		GREATEST(0,EXTRACT(EPOCH FROM now()-COALESCE(NULLIF(media_task->>'submittedAt','')::timestamptz,created_at)))::bigint
		FROM runs WHERE status='running' AND media_task ? 'taskId'`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []resumableMedia{}
	for rows.Next() {
		var item resumableMedia
		var seconds int64
		if e = rows.Scan(&item.tenant, &item.run, &item.session, &item.task, &seconds); e != nil {
			return nil, e
		}
		item.elapsed = time.Duration(seconds) * time.Second
		out = append(out, item)
	}
	return out, rows.Err()
}

func (a *App) resumeMedia(items []resumableMedia) {
	for _, item := range items {
		item := item
		remaining := a.cfg.MediaTimeout - item.elapsed
		if remaining <= 0 {
			a.finish(item.tenant, item.run, "failed", "", "media_timeout")
			continue
		}
		a.dispatchFor(remaining, item.tenant, item.run, "node", func(ctx context.Context) {
			var raw []byte
			var snapshot executionSnapshot
			if a.db.QueryRow(ctx, "SELECT execution_snapshot FROM runs WHERE tenant_id=$1 AND id=$2", item.tenant, item.run).Scan(&raw) != nil || json.Unmarshal(raw, &snapshot) != nil || snapshot.Media == nil {
				a.finish(item.tenant, item.run, "failed", "", "snapshot_invalid")
				return
			}
			m, ok := builtinMediaCatalog.model(snapshot.Media.Model)
			hub := a.mediaHub()
			if !ok || hub == nil {
				a.finish(item.tenant, item.run, "failed", "", "media_unavailable")
				return
			}
			a.followMedia(ctx, hub, item.tenant, item.run, item.session, m, rhTask{TaskID: item.task, Status: "RUNNING"}, true)
		})
	}
}
