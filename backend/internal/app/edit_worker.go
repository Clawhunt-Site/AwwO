package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

// The edit job on the render worker (apps/render-worker/server.mjs): POST /internal/edits with the manifest, PUT each
// file, POST …/render, GET each output, DELETE. One job holds the worker at a time, like a render; the API lets one
// render or edit go at a time (renderQueue) and asks again while the worker still answers busy.

// editError is how an edit ends when it does not: a stable code and, for a timeline the worker refused, its words.
type editError struct{ code, detail string }

func (e editError) Error() string { return e.code }

// editJob is a job row as its executor reads it.
type editJob struct {
	ID, CanvasID, NodeID string
	Timeline             json.RawMessage
	Files                []editFile
}

// editReply is the worker's answer to a render.
type editReply struct {
	EditID  string          `json:"editId"`
	Report  json.RawMessage `json:"report"`
	Outputs []editOutput    `json:"outputs"`
}

type editOutput struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
}

// editBusyRetry is how long a job keeps asking a worker that answers busy: past a crashed API's job, which the worker
// removes after ten idle minutes. A variable so tests can shorten it.
var editBusyRetry = 11 * time.Minute

// editLimits are the configured allowances and times, with their defaults for a configuration read without them.
func (a *App) editLimits() (perDay, sitePerDay int, timeout, queueWait time.Duration) {
	perDay, sitePerDay, timeout, queueWait = a.cfg.EditsPerDay, a.cfg.EditsTotalPerDay, a.cfg.EditTimeout, a.cfg.EditQueueWait
	if perDay <= 0 {
		perDay = 40
	}
	if sitePerDay <= 0 {
		sitePerDay = 400
	}
	if timeout <= 0 {
		timeout = 75 * time.Minute
	}
	if queueWait <= 0 {
		queueWait = 45 * time.Minute
	}
	return
}

// dispatchEdit runs one job in the background, registered so a cancel or a shutdown stops it.
func (a *App) dispatchEdit(tid, id string) {
	a.mu.Lock()
	if a.closed || a.running["edit:"+id] != nil {
		a.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.running["edit:"+id] = cancel
	a.tasks.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.tasks.Done()
		defer func() { a.mu.Lock(); delete(a.running, "edit:"+id); a.mu.Unlock() }()
		defer cancel()
		a.executeEdit(ctx, tid, id)
	}()
}

// executeEdit waits for the worker, starts the job (counting the attempt) and renders it. A job the API stops while
// closing stays as it is, for the next process to render again (settleGraphEdit).
func (a *App) executeEdit(ctx context.Context, tid, id string) {
	_, _, renderTime, queueWait := a.editLimits()
	queue := a.renderQueue()
	wait := time.NewTimer(queueWait)
	select {
	case queue <- struct{}{}:
		wait.Stop()
		defer func() { <-queue }()
	case <-wait.C:
		a.settleEdit(tid, id, "failed", "", "edit_busy", "", nil)
		return
	case <-ctx.Done():
		wait.Stop()
		a.editStopped(tid, id)
		return
	}
	job, err := a.startEdit(ctx, tid, id)
	if err != nil || job == nil {
		if err != nil && !a.closing() {
			a.settleEdit(tid, id, "failed", "", "edit_unavailable", "", nil)
		}
		return
	}
	if err = a.renderEdit(ctx, tid, job, renderTime); err != nil {
		var failure editError
		switch {
		case a.closing():
			return
		case ctx.Err() != nil:
			a.editStopped(tid, id)
		case errors.As(err, &failure):
			a.settleEdit(tid, id, "failed", "", failure.code, failure.detail, nil)
		default:
			a.settleEdit(tid, id, "failed", "", "edit_failed", "", nil)
		}
	}
}

// The time of each step of an edit but the render (whose time is the configured EditTimeout, past the worker's own
// limit, so a film too long to render fails on the worker as `timeout`): sending the files and keeping the outputs.
const (
	editUploadTime = 30 * time.Minute
	editKeepTime   = 20 * time.Minute
)

// editStep runs one step under its own time limit: a step this API ran out of time for is the platform's failure
// (edit_unavailable, not charged), whatever error its cut-off call returned.
func editStep(ctx context.Context, limit time.Duration, step func(context.Context) error) error {
	run, done := context.WithTimeout(ctx, limit)
	defer done()
	err := step(run)
	if err != nil && ctx.Err() == nil && errors.Is(run.Err(), context.DeadlineExceeded) {
		return editError{"edit_unavailable", "step_timeout"}
	}
	return err
}

// editStopped settles a job stopped by its graph's cancel (the API's own closing leaves it for the next start).
func (a *App) editStopped(tid, id string) {
	if !a.closing() {
		a.settleEdit(tid, id, "cancelled", "", "cancelled", "", nil)
	}
}

// startEdit moves a queued job to running (one more attempt) while its graph run still runs, and reads it.
func (a *App) startEdit(ctx context.Context, tid, id string) (*editJob, error) {
	job := &editJob{ID: id}
	var files []byte
	err := a.db.QueryRow(ctx, `UPDATE edit_jobs e SET status='running',attempts=attempts+1,started_at=clock_timestamp() WHERE e.tenant_id=$1 AND e.id=$2 AND e.status='queued'
		AND EXISTS(SELECT 1 FROM graph_runs g WHERE g.tenant_id=e.tenant_id AND g.id=e.graph_id AND g.status='running') RETURNING canvas_id,node_id,timeline,files`, tid, id).
		Scan(&job.CanvasID, &job.NodeID, &job.Timeline, &files)
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(files, &job.Files); err != nil {
		return nil, err
	}
	return job, nil
}

func (a *App) editClient() *http.Client {
	return &http.Client{Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// editCall sends one request to the worker's edit routes.
func (a *App) editCall(ctx context.Context, method, route string, body io.Reader, size int64, contentType string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(a.cfg.RenderURL, "/")+"/internal/edits"+route, body)
	if err != nil {
		return nil, err
	}
	if size >= 0 {
		req.ContentLength = size
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.RenderToken)
	return a.editClient().Do(req)
}

// editWorkerError maps a worker refusal to the job's end: a refused timeline keeps the worker's message.
func editWorkerError(status int, raw []byte) error {
	var reply struct {
		Error struct {
			Code, Message, Detail, Field string
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &reply)
	e := reply.Error
	switch {
	case status == 400 && e.Code == "INVALID_EDIT":
		return editError{"edit_rejected", firstRunes(e.Message, 500)}
	case status == 400 && e.Code == "EDIT_FILE_MISMATCH":
		return editError{"edit_file_mismatch", ""}
	case status == 400 && e.Code == "EDIT_FILE_UNSUPPORTED":
		// A stored file of no container an edit takes: the worker's words name it and the ones it takes.
		return editError{"edit_rejected", firstRunes(e.Message, 500)}
	case status == 413:
		return editError{"edit_rejected", "The timeline is larger than the worker takes"}
	case status == 429:
		return editError{"edit_busy", ""}
	case status == 401 || status == 404 || status == 409 || status == 503:
		// No token, a worker without edits or without this job any more (stopped, removed, restarted), or one that
		// cannot: the platform's, not the timeline's.
		return editError{"edit_unavailable", ""}
	case status == 422 && e.Detail == "timeout":
		return editError{"timeout", ""}
	case status == 422 && e.Detail == "film_too_large":
		return editError{"edit_rejected", firstRunes(e.Message, 500)}
	case status == 422:
		return editError{"edit_failed", firstRunes(e.Detail, 80)}
	case status >= 500:
		// The worker's own trouble (its disk, its process), not the timeline's.
		return editError{"edit_unavailable", ""}
	}
	return editError{"edit_failed", ""}
}

func readWorkerReply(resp *http.Response, limit int64) ([]byte, error) {
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, editError{"edit_failed", "reply_unreadable"}
	}
	return raw, nil
}

// maxEditManifestBytes is the worker's own limit on a manifest (edit-timeline.mjs maxManifestBytes), less room for
// the request's other fields.
const maxEditManifestBytes = 4<<20 - 64<<10

// editManifest is the job as the worker takes it. The timeline's markup is not escaped (json.Marshal would turn every
// <, > and & of a card into six bytes, as renderRequestBody avoids too); the film may be at most the size this API
// stores, so the worker caps its rate, or refuses a film that cannot fit, before it renders.
func (a *App) editManifest(job *editJob) ([]byte, error) {
	limit := a.cfg.MediaMaxFileBytes
	if limit <= 0 {
		limit = 300 << 20
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(map[string]any{"editId": job.ID, "timeline": job.Timeline, "files": editManifestFiles(job.Files), "limits": map[string]any{"maxFilmBytes": limit}}); err != nil {
		return nil, editError{"edit_failed", "manifest"}
	}
	if buffer.Len() > maxEditManifestBytes {
		return nil, editError{"edit_rejected", "The timeline is larger than the worker takes"}
	}
	return buffer.Bytes(), nil
}

// createWorkerEdit hands the worker the job's manifest, asking again while it answers busy (editBusyRetry). A job
// of the same id an earlier attempt left on the worker (the API restarted mid-edit) is removed first.
func (a *App) createWorkerEdit(ctx context.Context, job *editJob) error {
	body, err := a.editManifest(job)
	if err != nil {
		return err
	}
	a.deleteWorkerEdit(job.ID)
	deadline := time.Now().Add(editBusyRetry)
	for attempt := 1; ; attempt++ {
		resp, err := a.editCall(ctx, http.MethodPost, "", bytes.NewReader(body), int64(len(body)), "application/json")
		if err != nil {
			return editError{"edit_unavailable", ""}
		}
		raw, err := readWorkerReply(resp, 64<<10)
		if err != nil {
			return err
		}
		if resp.StatusCode == http.StatusCreated {
			return nil
		}
		pause := min(time.Duration(attempt)*time.Second, 5*time.Second)
		if resp.StatusCode != http.StatusTooManyRequests || time.Now().Add(pause).After(deadline) {
			return editWorkerError(resp.StatusCode, raw)
		}
		select {
		case <-time.After(pause):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func editManifestFiles(files []editFile) []map[string]any {
	out := make([]map[string]any, len(files))
	for i, f := range files {
		out[i] = map[string]any{"name": f.Name, "size": f.Size, "sha256": f.SHA256}
	}
	return out
}

// putWorkerFiles streams every stored file of the job to the worker, in manifest order.
func (a *App) putWorkerFiles(ctx context.Context, tid string, job *editJob) error {
	for i, f := range job.Files {
		path, ok := a.mediaFile(tid, f.Path)
		if !ok {
			return editError{"edit_file_missing", f.Name}
		}
		file, err := os.Open(path)
		if err != nil {
			return editError{"edit_file_missing", f.Name}
		}
		resp, err := a.editCall(ctx, http.MethodPut, fmt.Sprintf("/%s/files/%d", job.ID, i), file, f.Size, "application/octet-stream")
		file.Close()
		if err != nil {
			return editError{"edit_unavailable", ""}
		}
		raw, err := readWorkerReply(resp, 64<<10)
		if err != nil {
			return err
		}
		if resp.StatusCode != http.StatusNoContent {
			return editWorkerError(resp.StatusCode, raw)
		}
	}
	return nil
}

// renderEdit runs the job on the worker, each step under its own time (editStep), and keeps its outputs; the worker's
// job is removed however it ends.
func (a *App) renderEdit(ctx context.Context, tid string, job *editJob, renderTime time.Duration) error {
	defer a.deleteWorkerEdit(job.ID)
	if err := editStep(ctx, editBusyRetry+2*time.Minute, func(step context.Context) error { return a.createWorkerEdit(step, job) }); err != nil {
		return err
	}
	if err := editStep(ctx, editUploadTime, func(step context.Context) error { return a.putWorkerFiles(step, tid, job) }); err != nil {
		return err
	}
	var reply *editReply
	if err := editStep(ctx, renderTime, func(step context.Context) (err error) { reply, err = a.renderWorkerEdit(step, job); return err }); err != nil {
		return err
	}
	return editStep(ctx, editKeepTime, func(step context.Context) error {
		kept, err := a.fetchEditOutputs(step, tid, job, reply.Outputs)
		defer kept.discard()
		if err != nil {
			return err
		}
		return a.saveEdit(step, tid, job, reply.Report, kept)
	})
}

// renderWorkerEdit has the worker render the job whose files it has, and reads its reply.
func (a *App) renderWorkerEdit(ctx context.Context, job *editJob) (*editReply, error) {
	resp, err := a.editCall(ctx, http.MethodPost, "/"+job.ID+"/render", nil, 0, "")
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, editError{"edit_unavailable", ""}
	}
	raw, err := readWorkerReply(resp, 4<<20)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, editWorkerError(resp.StatusCode, raw)
	}
	var reply editReply
	if json.Unmarshal(raw, &reply) != nil || reply.EditID != job.ID {
		return nil, editError{"edit_failed", "reply_invalid"}
	}
	return &reply, nil
}

func (a *App) deleteWorkerEdit(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if resp, err := a.editCall(ctx, http.MethodDelete, "/"+id, nil, 0, ""); err == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()
	}
}

// editOutputRule says what a worker output may be: its name, its type, its role in the node's record and its cap.
var editOutputRules = []struct {
	kind, contentType, role string
	name                    *regexp.Regexp
	inline                  bool
	max                     int64
}{
	{"video", "video/mp4", "film", regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}\.mp4$`), false, 0},
	{"subtitles", "application/x-subrip", "subtitles", regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}\.srt$`), true, 1 << 20},
	{"still", "image/jpeg", "still", regexp.MustCompile(`^still-\d{3}\.jpg$`), false, 4 << 20},
	{"report", "application/json", "report", regexp.MustCompile(`^report\.json$`), true, 1 << 20},
}

// keptOutput is one output read back from the worker: in memory (subtitles, report) or in a file renamed into the
// job's media directory once checked.
type keptOutput struct {
	editOutput
	role  string
	data  []byte
	final string
}

type keptOutputs struct {
	items   []keptOutput
	written []string
	saved   bool
}

// discard removes the files written for outputs that were not saved.
func (k *keptOutputs) discard() {
	if k == nil || k.saved {
		return
	}
	for _, path := range k.written {
		_ = os.Remove(path)
	}
}
