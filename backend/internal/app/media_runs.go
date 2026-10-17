package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

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
	// References are the pictures the generation starts from, frozen at admission (media_refs.go).
	References []mediaReference `json:"references,omitempty"`
	// Motion is a 3D model's rig and animation chain, frozen at admission (tripo_motion.go); nil for every other run.
	Motion *tripoMotion `json:"motion,omitempty"`
}

type mediaItem struct {
	ArtifactID  string `json:"artifactId"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	// Animations are the names of the clips a stored GLB carries, read from the file itself (media_glb.go): written
	// only for a GLB that has some.
	Animations []string `json:"animations,omitempty"`
	// ClipsOnly marks a GLB with clips and no mesh: clips for the skeleton of the record's first model.
	ClipsOnly bool `json:"clipsOnly,omitempty"`
}

// Server-generated identifiers only; anything else never becomes part of a path.
var mediaPathPart = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Uploaded files of any type are stored as <sha256>.bin (uploads.go); their type lives in the artifact row.
var mediaFileName = regexp.MustCompile(`^[0-9a-f]{64}\.(png|jpg|webp|gif|mp4|webm|mov|glb|mp3|wav|bin)$`)

// mediaHub is the configured RunningHub client, or nil when image and video generation is off.
func (a *App) mediaHub() *runningHub {
	if !a.cfg.runningHubConfigured() {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.media == nil {
		a.media = newRunningHub(a.cfg)
	}
	return a.media
}

// tripoHub is the configured Tripo client, or nil when 3D generation is off.
func (a *App) tripoHub() *tripoClient {
	if !a.cfg.tripoConfigured() {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.tripo == nil {
		a.tripo = newTripo(a.cfg)
	}
	return a.tripo
}

// xtasyHub is the configured X-tasy client, or nil when its image and video generation is off.
func (a *App) xtasyHub() *xtasyClient {
	if !a.cfg.xtasyConfigured() {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.xtasy == nil {
		a.xtasy = newXtasy(a.cfg)
	}
	return a.xtasy
}

// jimengHub is the configured Jimeng client, or nil when its image and video generation is off.
func (a *App) jimengHub() *jimengClient {
	if !a.cfg.jimengConfigured() {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.jimeng == nil {
		a.jimeng = newJimeng(a.cfg)
	}
	return a.jimeng
}

// mediaProvider is a media generation backend: Jimeng, X-tasy or RunningHub for images and video, Tripo for 3D models.
// A task is submitted once, queried until it ends, and its result files are downloaded through an allowlisted client.
type mediaProvider interface {
	submit(ctx context.Context, endpoint string, body map[string]any) (rhTask, error)
	query(ctx context.Context, taskID string) (rhTask, error)
	download(ctx context.Context, raw string, w io.Writer) (int64, error)
	fileLimit() int64
}

// mediaProviderFor returns the configured client for a catalog provider, or nil (never a typed nil).
func (a *App) mediaProviderFor(provider string) mediaProvider {
	switch provider {
	case mediaProviderRunningHub:
		if hub := a.mediaHub(); hub != nil {
			return hub
		}
	case mediaProviderTripo:
		if hub := a.tripoHub(); hub != nil {
			return hub
		}
	case mediaProviderXtasy:
		if hub := a.xtasyHub(); hub != nil {
			return hub
		}
	case mediaProviderJimeng:
		if hub := a.jimengHub(); hub != nil {
			return hub
		}
	}
	return nil
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
	snapshot, err := a.mediaPlanSnapshot(document, nodeID, model, entitlement)
	if err != nil {
		return executionSnapshot{}, err
	}
	m, _ := builtinMediaCatalog.model(model)
	if !m.validMediaPrompt(prompt) {
		return executionSnapshot{}, mediaPromptError(m)
	}
	return snapshot, nil
}

func mediaPromptError(m *mediaModel) error {
	return setupError{"media_prompt_invalid", fmt.Sprintf("The prompt must be %d-%d characters for this model", m.Prompt.MinLength, m.Prompt.MaxLength)}
}

// mediaPromptAccepted applies the model's prompt bounds to a generation's words. A 3D model built from a reference
// picture reads no words (Tripo's image-to-model takes none), so it needs none; any it has stay within the bound.
func mediaPromptAccepted(m *mediaModel, text string, refs []mediaReference) bool {
	if len(refs) > 0 && m.Kind == mediaKindModel3D {
		return utf8.RuneCountInString(text) <= m.Prompt.MaxLength
	}
	return m.validMediaPrompt(text)
}

// freezeMediaPrompt resolves a media run's reference pictures from its message and checks its words: the stored
// prompt is the words, then the lines of the pictures the generation starts from (other files are not used and are
// not kept), and the references go into the run's plan. cut shortens words past the model's limit instead of
// refusing them: a canvas run composes its prompt from upstream deliveries, a user's own Send does not.
func (a *App) freezeMediaPrompt(ctx context.Context, q querier, tid, canvasID, prompt string, plan *mediaPlan, cut bool) (string, error) {
	m, ok := builtinMediaCatalog.model(plan.Model)
	if !ok {
		return "", setupError{"model_unavailable", "Node model is unavailable for its runtime or this workspace"}
	}
	refs, err := a.freezeMediaReferences(ctx, q, tid, canvasID, prompt, m)
	if err != nil {
		return "", err
	}
	text := strings.TrimSpace(stripAttachmentLines(prompt))
	if cut {
		text = strings.TrimSpace(firstRunes(text, m.Prompt.MaxLength))
	}
	if !mediaPromptAccepted(m, text, refs) {
		return "", mediaPromptError(m)
	}
	plan.References = refs
	return withReferenceLines(text, refs), nil
}

// mediaPlanSnapshot is mediaSnapshot without the prompt: a canvas run freezes a media node's model and parameters
// when the graph is admitted and composes its prompt only when the node's turn comes (graph_media.go).
func (a *App) mediaPlanSnapshot(document []byte, nodeID, model string, entitlement modelEntitlement) (executionSnapshot, error) {
	if !a.cfg.mediaConfigured() {
		return executionSnapshot{}, setupError{"media_unavailable", "Image and video generation is not configured"}
	}
	m, ok := builtinMediaCatalog.model(model)
	if !ok {
		return executionSnapshot{}, setupError{"model_unavailable", "Node model is unavailable for its runtime or this workspace"}
	}
	if !a.cfg.mediaProviderConfigured(m.Provider) {
		return executionSnapshot{}, setupError{"media_unavailable", "This node's generation provider is not configured"}
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
	plan := &mediaPlan{Version: 1, Provider: m.Provider, Model: m.ID, Kind: m.Kind, Params: params}
	runtime := runtimeRunningHub
	switch m.Provider {
	case mediaProviderTripo:
		runtime = runtimeTripo
		// A skeleton and its clips are a chain of further paid tasks after the model, frozen with the run.
		if plan.Motion, err = tripoMotionFor(params); err != nil {
			return executionSnapshot{}, setupError{"media_params_invalid", "Node media settings are invalid for its model"}
		}
	case mediaProviderXtasy:
		runtime = runtimeXtasy
	case mediaProviderJimeng:
		runtime = runtimeJimeng
	}
	return executionSnapshot{Runtime: runtime, Model: m.ID, Media: plan}, nil
}

// frozenMotionValid checks a stored plan's chain: only a Tripo model has one. A run starting now has exactly the chain
// its parameters ask for, as it was admitted moments ago; a resumed run follows the one an earlier start froze, as it
// is, when it has a shape this release could have frozen.
func frozenMotionValid(m *mediaModel, plan *mediaPlan, fresh bool) bool {
	if m.Provider != mediaProviderTripo {
		return plan.Motion == nil
	}
	if !fresh {
		return plan.Motion == nil || validTripoMotion(plan.Motion)
	}
	want, err := tripoMotionFor(plan.Params)
	return err == nil && reflect.DeepEqual(want, plan.Motion)
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
// paid tells that the workspace's owner had an entitled plan when the run was read: the generation is then
// admitted on the plan's daily generations across the account's workspaces and spends the period's credits,
// instead of the workspace's own media allowance and the free plan's media route limit and ceiling.
// own are the workspace's own run limits, which apply when the plan lapsed after createRun read it.
func (a *App) createMediaRun(w http.ResponseWriter, r *http.Request, tx pgx.Tx, tid string, b runInput, hash string, document []byte, nodeID, canvasID, model string, entitlement modelEntitlement, routes routeLimits, paid bool, own workspaceLimits) {
	ctx := r.Context()
	if len(b.KnowledgeRevisionIDs) > 0 {
		fail(w, 400, "media_knowledge_unsupported", "Image and video nodes do not take knowledge context")
		return
	}
	snapshot, e := a.mediaPlanSnapshot(document, nodeID, model, entitlement)
	if e != nil {
		a.mediaAdmissionError(w, e)
		return
	}
	// The message's first fitting picture becomes the generation's reference where the model takes one; the words
	// are checked against the model's bounds, and what is stored (and later sent) is the words without file lines.
	if b.Prompt, e = a.freezeMediaPrompt(ctx, tx, tid, canvasID, b.Prompt, snapshot.Media, false); e != nil {
		var input setupError
		if !errors.As(e, &input) {
			a.dbError(w, e)
			return
		}
		a.mediaAdmissionError(w, e)
		return
	}
	// Refuse before paying for a generation this host cannot store.
	if e = a.mediaStorageReady(); e != nil {
		a.mediaAdmissionError(w, e)
		return
	}
	billing, e := a.admitMediaGeneration(ctx, tx, tid, snapshot, routes, paid, false, own)
	var refusal *mediaRefusal
	if errors.As(e, &refusal) {
		fail(w, refusal.status, refusal.code, refusal.message)
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	id := randomID()
	task, _ := json.Marshal(map[string]string{"provider": snapshot.Media.Provider, "model": snapshot.Model})
	v, e := oneJSON(ctx, tx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,media_task) VALUES($1,$2,$3,$4,$5,$6,'queued',$7) RETURNING "+runJSON, id, tid, b.SessionID, b.OperationID, hash, b.Prompt, task)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = saveRunSnapshot(ctx, tx, tid, id, currentUser(r).ID, snapshot); e != nil {
		a.dbError(w, e)
		return
	}
	if _, e = tx.Exec(ctx, "INSERT INTO media_generations(run_id,tenant_id,model,created_at,credit_points,billed_user_id,billed_period_start) VALUES($1,$2,$3,clock_timestamp(),$4,$5,$6)", id, tid, snapshot.Model, billing.credits, billing.billedUser, billing.billedPeriod); e != nil {
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

// mediaRefusal is why a generation is not admitted, with the status a run request answers it with.
type mediaRefusal struct {
	status        int
	code, message string
}

func (r *mediaRefusal) Error() string { return r.code }

// mediaBilling is what an admitted generation is recorded with: a paid plan's credits, account and period, or nothing
// for a free generation.
type mediaBilling struct {
	credits      *int
	billedUser   *string
	billedPeriod *time.Time
}

// generationCounts matches a generation (alias g) that spends a free allowance: one sent to its provider
// (submitted_at, set before the request goes out) unless the provider refused it outright, creating no task
// (provider_refused, refusedAnswer); one its provider accepted, even if it failed or was refunded afterwards; and one
// still queued or running, so concurrent admissions cannot pass a limit together. So a refused generation gives its
// attempt back, and so does one whose run ended before it was ever sent (a cancel, a failed reference upload), while a
// submission whose outcome is unknown (a timeout, a lost answer, a cancel or a restart while it was in flight) keeps
// counting.
const generationCounts = `(NOT g.provider_refused AND (g.submitted_at IS NOT NULL OR g.provider_accepted IS NOT NULL
	OR EXISTS(SELECT 1 FROM runs r WHERE r.tenant_id=g.tenant_id AND r.id=g.run_id AND r.status IN ('queued','running'))))`

// admitMediaGeneration decides whether one more generation may be paid for, inside the admitting transaction, which
// already holds the workspace row: with an entitled plan its daily generations, its agents at once (unless the caller
// already holds one of them: holdsSlot, as a canvas run does through planRunSlot) and its credits; otherwise the
// workspace's and the deployment's free allowances, the free 3D caps and the route limits. paid tells that the owner
// had an entitled plan when it was read without its lock; own are the workspace's own run limits, which apply when
// that plan lapsed since. A refusal is a *mediaRefusal; any other error is the database's.
func (a *App) admitMediaGeneration(ctx context.Context, tx pgx.Tx, tid string, snapshot executionSnapshot, routes routeLimits, paid, holdsSlot bool, own workspaceLimits) (mediaBilling, error) {
	none := mediaBilling{}
	// The workspace row is locked; the deployment-wide count takes its own lock, so neither limit
	// can be passed by concurrent admissions. Both read the clock after waiting for the locks.
	if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(84321010)"); e != nil {
		return none, e
	}
	// today counts this workspace's free generations only: paid ones never spend a free allowance, and one that cost
	// nothing gave its attempt back (generationCounts).
	var today, total int
	if e := tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE g.tenant_id=$1 AND g.billed_user_id IS NULL),count(*) FILTER (WHERE g.billed_user_id IS NULL) FROM media_generations g
		WHERE g.created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND `+generationCounts, tid).Scan(&today, &total); e != nil {
		return none, e
	}
	// A paid plan's row is locked after the workspace row and the media lock, like every model call's.
	var plan *activePlan
	if paid {
		var e error
		if plan, e = ownerPlan(ctx, tx, tid, true); e != nil {
			return none, e
		}
		if plan == nil {
			// The plan lapsed since it was read, and the workspace's own run limits were skipped then.
			switch e = own.admit(ctx, tx, tid); {
			case errors.Is(e, errPlanRequired):
				return none, &mediaRefusal{402, "plan_required", "This workspace needs its owner's paid plan"}
			case errors.Is(e, errInvocationQuota):
				return none, &mediaRefusal{429, "quota_exceeded", "Workspace run quota exceeded"}
			case e != nil:
				return none, e
			}
		}
	}
	// The operator's own workspace has no free allowance to run out of (operator_workspace.go); a paid plan's limits are
	// the plan's, as before.
	operator := false
	if plan == nil {
		var e error
		if operator, e = operatorWorkspace(ctx, tx, tid); e != nil {
			return none, e
		}
	}
	if plan != nil {
		usage, e := accountPlanUsage(ctx, tx, plan.UserID, a.cfg.PlannerModel)
		if e != nil {
			return none, e
		}
		if usage.MediaToday >= plan.Limits.MediaPerDay {
			return none, &mediaRefusal{429, "plan_media_quota_exceeded", "This plan's image and video generations for today are used up"}
		}
		// A generation is a run: it takes one of the plan's agents at once (createRun leaves that count to here).
		if !holdsSlot {
			used, e := accountSlotsUsed(ctx, tx, plan.UserID)
			if e != nil {
				return none, e
			}
			if used >= plan.Limits.Concurrent {
				return none, &mediaRefusal{429, "plan_busy", "This plan's agents at once are all running, in this or another workspace; try again when one finishes"}
			}
		}
	} else if !operator && today >= a.cfg.MediaRunsPerDay {
		return none, &mediaRefusal{429, "media_quota_exceeded", "This workspace has used today's image and video generations"}
	}
	if plan == nil && !operator && total >= a.cfg.mediaTotalNow() {
		return none, &mediaRefusal{429, "media_capacity_exceeded", "Today's image and video generations are used up; try again tomorrow"}
	}
	// A 3D generation is paid from the operator's Tripo balance: free ones have their own, smaller caps, for the
	// workspace and across every workspace, counted from durable rows under the same lock.
	if plan == nil && !operator && snapshot.Media.Provider == mediaProviderTripo {
		// A rig and its animations cost the operator's balance several times a model (rig 25 Tripo credits, 50 per five
		// clips), which a free 3D allowance counted per generation would hide: they need a paid plan.
		if snapshot.Media.Motion != nil {
			return none, &mediaRefusal{402, "model3d_motion_plan_required", "Rigging and animating a 3D model needs a paid plan"}
		}
		var mine, all int
		if e := tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE g.tenant_id=$1),count(*) FROM media_generations g
			WHERE g.billed_user_id IS NULL AND g.model LIKE 'tripo.%' AND g.created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND `+generationCounts, tid).Scan(&mine, &all); e != nil {
			return none, e
		}
		if mine >= a.cfg.TripoFreeRunsPerDay {
			return none, &mediaRefusal{429, "model3d_quota_exceeded", "This workspace has used today's free 3D generations"}
		}
		if all >= a.cfg.tripoTotalNow() {
			return none, &mediaRefusal{429, "model3d_capacity_exceeded", "Today's free 3D generations are used up; try again tomorrow"}
		}
	}
	billing := none
	if plan != nil {
		n := mediaCreditsFor(snapshot.Model, snapshot.Media.Kind, snapshot.Media.Params) + mediaReferenceCredits(snapshot.Model, len(snapshot.Media.References))
		billing = mediaBilling{&n, &plan.UserID, &plan.PeriodStart}
		switch e := checkCredits(ctx, tx, plan, n); {
		case errors.Is(e, errCreditsExhausted):
			return none, &mediaRefusal{402, "credits_exhausted", "This plan's credits for the period are used up"}
		case e != nil:
			return none, e
		}
		routes = nil
	}
	// A route-limited free workspace also has its own media allowance and shares a deployment-wide
	// ceiling with the other route-limited workspaces; one that limits no route (an empty object) has neither.
	switch code, e := a.mediaRouteLimit(ctx, tx, routes, today); {
	case e != nil:
		return none, e
	case code == "media_quota_exceeded":
		return none, &mediaRefusal{429, code, "This workspace has used today's image and video generations"}
	case code != "":
		return none, &mediaRefusal{429, code, "Today's image and video generations are used up; try again tomorrow"}
	}
	return billing, nil
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
	if !ok || m.Kind != plan.Kind || plan.Provider != m.Provider || !frozenMotionValid(m, plan, true) {
		a.finish(tid, id, "failed", "", "snapshot_invalid")
		return
	}
	hub := a.mediaProviderFor(m.Provider)
	if hub == nil {
		a.finish(tid, id, "failed", "", "media_unavailable")
		return
	}
	// The stored prompt ends with the lines of its reference pictures; the provider gets the words alone.
	text := strings.TrimSpace(stripAttachmentLines(prompt))
	var references []string
	if len(plan.References) > 0 {
		// An upload creates no task and no charge; a run that fails here is not billed (recordMediaTask never ran).
		if a.mediaStopped(ctx, id, false) {
			return
		}
		ids, err := a.uploadMediaReferences(ctx, hub, tid, id, plan.References)
		if err != nil {
			if a.mediaStopped(ctx, id, false) {
				return
			}
			a.finish(tid, id, "failed", "", mediaFailureCode(err))
			return
		}
		references = ids
	}
	endpoint := m.Endpoint
	var body map[string]any
	switch m.Provider {
	case mediaProviderTripo:
		if len(references) > 0 {
			body, endpoint = tripoImageRequest(m, references[0], plan.Params), tripoImageEndpoint
		} else {
			body = tripoRequest(m, text, plan.Params)
		}
	case mediaProviderXtasy:
		body = xtasyRequest(m, text, plan.Params, id, references)
	case mediaProviderJimeng:
		body = jimengRequest(m, text, plan.Params, id, references)
	default:
		body = runningHubRequest(m, text, plan.Params)
	}
	// One admitted run is one provider task: a submission that may or may not have reached the
	// provider is never retried, because a retry could pay for the same generation twice. Nor is it
	// abandoned by a cancel or a shutdown: once sent it may be billed, so its task id is awaited
	// and recorded (the API client's own timeout bounds the wait). The one answer that is sent
	// again is one saying no task was created (submitMedia).
	if a.mediaStopped(ctx, id, false) {
		return
	}
	// The generation counts as sent before the provider can bill it (generationCounts); one that cannot be marked so is
	// not sent at all, and so costs nothing. A run cancelled meanwhile was settled by its cancel.
	if e := a.markMediaSubmitted(ctx, tid, id); errors.Is(e, errMediaRunEnded) {
		return
	} else if e != nil {
		a.log.Warn("media submission not recorded; not sent", "event", "media_submit_unrecorded")
		a.finish(tid, id, "failed", "", "media_unavailable")
		return
	}
	task, err := submitMedia(ctx, hub, endpoint, body, func() { a.mediaStatus(ctx, tid, id, "queued") })
	if err != nil {
		if e, ok := asRHError(err); ok && e.Refused {
			a.markMediaRefused(ctx, tid, id)
		}
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
	a.followMedia(ctx, hub, tid, id, sid, m, plan, task, recorded, motionProgress{})
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
	halted, _ := a.mediaHalted(ctx, id, recorded)
	return halted
}

// mediaHalted is mediaStopped that also says whether the run was left for the next start to resume (a shutdown while
// its provider task is recorded) rather than cancelled, or left to be marked interrupted.
func (a *App) mediaHalted(ctx context.Context, id string, recorded bool) (halted, resumes bool) {
	err := ctx.Err()
	if err == nil || errors.Is(err, context.DeadlineExceeded) {
		return false, false
	}
	return true, recorded && a.leaveForResume(id)
}

// pollMedia queries a submitted task until it succeeds, and returns it. Anything else returns what ended it: the run's
// context (a cancel, a shutdown or its deadline), the task's own failure, too many transient answers in a row, or an
// answer about another task (one provider account serves every workspace, so such an answer is never this run's
// result). report, when given, is told each queued or running state once as it changes.
func (a *App) pollMedia(ctx context.Context, hub mediaProvider, task rhTask, report func(state string)) (rhTask, error) {
	reported, failures := "", 0
	for task.Status != "SUCCESS" {
		if state := strings.ToLower(task.Status); report != nil && state != reported && (state == "queued" || state == "running") {
			reported = state
			report(state)
		}
		select {
		case <-ctx.Done():
			return task, ctx.Err()
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
					return task, &rhError{Code: "media_provider_unavailable"}
				}
				continue
			}
			return task, err
		}
		failures = 0
		if next.TaskID == "" {
			next.TaskID = task.TaskID
		}
		if next.TaskID != task.TaskID {
			return task, &rhError{Code: "media_provider_unavailable"}
		}
		task = next
	}
	return task, nil
}

// submitMedia sends a run's one provider task. Every answer is final except one that says no task was created
// (rhError.RetryAfter: Tripo's full concurrency pool or rate limit, which one operator account meets as soon as a
// few workspaces generate at once): that is waited out as the provider asked, with the run shown as queued
// (waiting is called once), until the task is accepted, refused otherwise, or the run is cancelled or past its
// deadline. Each send has its own timeout and is never abandoned midway, like the single send it replaces.
// A refusal gives the generation's attempt back (rhError.Refused) only when it answered the first send: X-tasy also
// sends again after an answer that never arrived (its Idempotency-Key returns the task the first send made), so after
// any resend an earlier send may have created, and billed, the task.
func submitMedia(ctx context.Context, hub mediaProvider, endpoint string, body map[string]any, waiting func()) (rhTask, error) {
	notified := false
	for sends := 1; ; sends++ {
		submitCtx, cancelSubmit := context.WithTimeout(context.WithoutCancel(ctx), rhSubmitTimeout)
		task, err := hub.submit(submitCtx, endpoint, body)
		cancelSubmit()
		e, ok := asRHError(err)
		if ok && sends > 1 {
			e.Refused = false
		}
		if !ok || e.RetryAfter <= 0 {
			return task, err
		}
		if !notified {
			notified = true
			waiting()
		}
		select {
		case <-ctx.Done():
			return task, err
		case <-time.After(e.RetryAfter):
		}
	}
}

// errMediaRunEnded says a generation's run ended (a cancel) before it was marked sent: it is not sent at all.
var errMediaRunEnded = errors.New("media run ended before it was sent")

// markMediaSubmitted records that a generation is about to be sent to its provider, which may bill it from then on.
// The run's row is locked while it is checked and marked, so a cancel either comes first, and the generation is not
// sent (errMediaRunEnded), or waits until it already counts as sent: a cancel can never free an allowance that a
// generation sent afterwards still uses.
func (a *App) markMediaSubmitted(ctx context.Context, tid, id string) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(context.Background())
	var status string
	if e = tx.QueryRow(ctx, "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, id).Scan(&status); e != nil {
		return e
	}
	if status != "queued" && status != "running" {
		return errMediaRunEnded
	}
	tag, e := tx.Exec(ctx, "UPDATE media_generations SET submitted_at=COALESCE(submitted_at,clock_timestamp()) WHERE tenant_id=$1 AND run_id=$2", tid, id)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return errors.New("generation row missing")
	}
	return tx.Commit(ctx)
}

// markMediaRefused records that the provider refused a generation outright, creating no task (refusedAnswer): it cost
// nothing, so a free one gives its attempt back. If this write fails the generation keeps counting.
func (a *App) markMediaRefused(ctx context.Context, tid, id string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if _, e := a.db.Exec(ctx, "UPDATE media_generations SET provider_refused=true WHERE tenant_id=$1 AND run_id=$2 AND provider_accepted IS NULL", tid, id); e != nil {
		a.log.Warn("refused generation not recorded", "event", "media_refusal_unrecorded")
	}
}

// unbillMedia records that the provider returned a generation's frozen credits (Tripo does for a task that failed
// or was cancelled on its side), so the generation costs its paid plan nothing (creditsSpentSQL). A free
// allowance stays spent: the provider accepted the task (generationCounts).
func (a *App) unbillMedia(ctx context.Context, tid, id string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if _, e := a.db.Exec(ctx, "UPDATE media_generations SET provider_accepted=false WHERE tenant_id=$1 AND run_id=$2", tid, id); e != nil {
		a.log.Warn("unbilled generation not recorded", "event", "media_unbill_unrecorded")
	}
}

func (a *App) recordMediaTask(ctx context.Context, tid, id, taskID string) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	// The provider has the task and may bill it, so its generation is charged even if the run was cancelled
	// while it was being submitted.
	if _, e := a.db.Exec(ctx, "UPDATE media_generations SET provider_accepted=true WHERE tenant_id=$1 AND run_id=$2", tid, id); e != nil {
		return e
	}
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
// stores the results, or for a 3D model with a skeleton runs its chain (followTripoMotion). recorded
// says whether the task id is durable, so a shutdown can leave the run for the next start instead of
// settling it; progress is how far a resumed run's chain got.
func (a *App) followMedia(ctx context.Context, hub mediaProvider, tid, id, sid string, m *mediaModel, plan *mediaPlan, task rhTask, recorded bool, progress motionProgress) {
	// A generation admitted with a chain was priced for it: until the chain runs, none of it is charged.
	unchained := func() {
		if plan.Motion != nil {
			a.settleMotionCredits(tid, id, plan.Motion.credits())
		}
	}
	task, err := a.pollMedia(ctx, hub, task, func(state string) { a.mediaStatus(ctx, tid, id, state) })
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		if halted, resumes := a.mediaHalted(ctx, id, recorded); halted {
			// A run the next start resumes is charged when it ends there.
			if !resumes {
				unchained()
			}
			return
		}
		unchained()
		a.finish(tid, id, "failed", "", "media_timeout")
		return
	}
	if err != nil {
		if e, ok := asRHError(err); ok && e.Unbilled {
			a.unbillMedia(ctx, tid, id)
		}
		unchained()
		a.finish(tid, id, "failed", "", mediaFailureCode(err))
		return
	}
	if plan.Motion != nil {
		a.followTripoMotion(ctx, hub, tid, id, sid, m, plan.Motion, task, recorded, progress, textureMaxOf(plan.Params))
		return
	}
	a.mediaStatus(ctx, tid, id, "saving")
	output, err := a.storeMediaResults(ctx, hub, tid, id, sid, m, task.Results, textureMaxOf(plan.Params))
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
	// How far a 3D model's chain got (tripo_motion.go).
	motion motionProgress
}

// resumableMediaRuns lists media runs that were waiting on a provider task when the API stopped.
// They are excluded from the restart sweep and resumed: their generation is already paid for.
func resumableMediaRuns(ctx context.Context, tx pgx.Tx) ([]resumableMedia, error) {
	rows, e := tx.Query(ctx, `SELECT tenant_id,id,session_id,media_task->>'taskId',
		GREATEST(0,EXTRACT(EPOCH FROM now()-COALESCE(NULLIF(media_task->>'submittedAt','')::timestamptz,created_at)))::bigint,
		COALESCE(media_task->'motionTasks','[]'::jsonb)::text,COALESCE(media_task->>'motionSent','0')
		FROM runs WHERE status='running' AND media_task ? 'taskId'`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []resumableMedia{}
	for rows.Next() {
		var item resumableMedia
		var seconds int64
		var tasks, sent string
		if e = rows.Scan(&item.tenant, &item.run, &item.session, &item.task, &seconds, &tasks, &sent); e != nil {
			return nil, e
		}
		item.elapsed = time.Duration(seconds) * time.Second
		item.motion = readMotionProgress(tasks, sent)
		out = append(out, item)
	}
	return out, rows.Err()
}

// readMotionProgress reads a run's recorded chain. Anything it cannot read counts every step as sent, so none of them
// is sent again: a resumed chain then follows the tasks it can read and fails at the first it cannot.
func readMotionProgress(tasks, sent string) motionProgress {
	var p motionProgress
	n, err := strconv.Atoi(strings.TrimSpace(sent))
	if json.Unmarshal([]byte(tasks), &p.tasks) != nil || err != nil || n < 0 {
		return motionProgress{sent: math.MaxInt32}
	}
	p.sent = max(n, len(p.tasks))
	return p
}

func (a *App) resumeMedia(items []resumableMedia) {
	for _, item := range items {
		item := item
		remaining := a.cfg.MediaTimeout - item.elapsed
		if remaining <= 0 {
			a.expireMedia(item)
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
			if ok && !frozenMotionValid(m, snapshot.Media, false) {
				a.finish(item.tenant, item.run, "failed", "", "snapshot_invalid")
				return
			}
			var hub mediaProvider
			if ok {
				hub = a.mediaProviderFor(m.Provider)
			}
			if !ok || hub == nil {
				a.finish(item.tenant, item.run, "failed", "", "media_unavailable")
				return
			}
			a.followMedia(ctx, hub, item.tenant, item.run, item.session, m, snapshot.Media, rhTask{TaskID: item.task, Status: "RUNNING"}, true, item.motion)
		})
	}
}

// expireMedia ends a resumable run whose time ran out while the API was down. A 3D model's chain is charged for the
// steps Tripo accepted (their outcome unknown, as the model task's), and nothing for those it never got.
func (a *App) expireMedia(item resumableMedia) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	var raw []byte
	var snapshot executionSnapshot
	if a.db.QueryRow(ctx, "SELECT execution_snapshot FROM runs WHERE tenant_id=$1 AND id=$2", item.tenant, item.run).Scan(&raw) == nil &&
		json.Unmarshal(raw, &snapshot) == nil && snapshot.Media != nil && validTripoMotion(snapshot.Media.Motion) {
		motion, unbilled := snapshot.Media.Motion, snapshot.Media.Motion.credits()
		for step := range min(len(item.motion.tasks), len(motion.Batches)+1) {
			unbilled -= motion.stepCredits(step)
		}
		if unbilled > 0 {
			a.settleMotionCredits(item.tenant, item.run, unbilled)
		}
	}
	cancel()
	a.finish(item.tenant, item.run, "failed", "", "media_timeout")
}
