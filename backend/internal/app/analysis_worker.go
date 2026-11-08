package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode"
)

// The executor of an analyze node's job (analyses.go) on the video analysis worker (apps/video-analysis-worker), whose
// protocol is the render worker's edit jobs with other paths: the manifest, the one video by size and sha256, the run,
// the outputs, the delete.

// analysisError is how an analysis ends when it does not: a stable code and, for a video the worker refused, its words.
type analysisError struct{ code, detail string }

func (e analysisError) Error() string { return e.code }

// analysisJob is a job row as its executor reads it.
type analysisJob struct {
	ID, CanvasID, NodeID string
	Source               editFile
	Options              json.RawMessage
}

// analysisReply is the worker's answer to a run.
type analysisReply struct {
	AnalysisID string          `json:"analysisId"`
	Report     json.RawMessage `json:"report"`
	Summary    *string         `json:"summary"`
	Outputs    []editOutput    `json:"outputs"`
}

// analysisBusyRetry is how long a job keeps asking a worker that answers busy: past a crashed API's job, which the
// worker removes after ten idle minutes. A variable so tests can shorten it.
var analysisBusyRetry = 11 * time.Minute

// analysisLimits are the configured allowances and times, with their defaults for a configuration read without them.
func (a *App) analysisLimits() (perDay, sitePerDay int, timeout, queueWait time.Duration) {
	perDay, sitePerDay, timeout, queueWait = a.cfg.AnalysesPerDay, a.cfg.AnalysesSitePerDay, a.cfg.AnalysisTimeout, a.cfg.AnalysisQueueWait
	if perDay <= 0 {
		perDay = 20
	}
	if sitePerDay <= 0 {
		sitePerDay = 200
	}
	if timeout <= 0 {
		timeout = 40 * time.Minute
	}
	if queueWait <= 0 {
		queueWait = 45 * time.Minute
	}
	return
}

// analysisQueue lets one analysis at a time go to the worker (it analyses one at a time and refuses a second); the
// others wait queued instead of failing.
func (a *App) analysisQueue() chan struct{} {
	a.analysisSlotOnce.Do(func() { a.analysisSlot = make(chan struct{}, 1) })
	return a.analysisSlot
}

// dispatchAnalysis runs one job in the background, registered so a cancel or a shutdown stops it.
func (a *App) dispatchAnalysis(tid, id string) {
	a.mu.Lock()
	if a.closed || a.running["analysis:"+id] != nil {
		a.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.running["analysis:"+id] = cancel
	a.tasks.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.tasks.Done()
		defer func() { a.mu.Lock(); delete(a.running, "analysis:"+id); a.mu.Unlock() }()
		defer cancel()
		a.executeAnalysis(ctx, tid, id)
	}()
}

// executeAnalysis waits for the worker, starts the job (counting the attempt) and runs it. A job the API stops while
// closing stays as it is, for the next process to run again (settleGraphAnalysis).
func (a *App) executeAnalysis(ctx context.Context, tid, id string) {
	_, _, runTime, queueWait := a.analysisLimits()
	queue := a.analysisQueue()
	wait := time.NewTimer(queueWait)
	select {
	case queue <- struct{}{}:
		wait.Stop()
		defer func() { <-queue }()
	case <-wait.C:
		a.settleAnalysis(tid, id, "failed", "", "analysis_busy", "", nil)
		return
	case <-ctx.Done():
		wait.Stop()
		a.analysisStopped(tid, id)
		return
	}
	job, err := a.startAnalysis(ctx, tid, id)
	if err != nil || job == nil {
		if err != nil && !a.closing() {
			a.settleAnalysis(tid, id, "failed", "", "analysis_unavailable", "", nil)
		}
		return
	}
	if err = a.runAnalysisJob(ctx, tid, job, runTime); err != nil {
		var failure analysisError
		switch {
		case a.closing():
			return
		case ctx.Err() != nil:
			a.analysisStopped(tid, id)
		case errors.As(err, &failure):
			a.settleAnalysis(tid, id, "failed", "", failure.code, failure.detail, nil)
		default:
			a.settleAnalysis(tid, id, "failed", "", "analysis_failed", "", nil)
		}
	}
}

// The time of each step but the run (whose time is the configured AnalysisTimeout, past the worker's own limit, so a
// video too slow to analyse fails on the worker as `timeout`): sending the video and keeping the outputs.
const (
	analysisUploadTime = 20 * time.Minute
	analysisKeepTime   = 20 * time.Minute
)

// analysisStep runs one step under its own time limit: a step this API ran out of time for is the platform's failure
// (analysis_unavailable, not charged), whatever error its cut-off call returned.
func analysisStep(ctx context.Context, limit time.Duration, step func(context.Context) error) error {
	run, done := context.WithTimeout(ctx, limit)
	defer done()
	err := step(run)
	if err != nil && ctx.Err() == nil && errors.Is(run.Err(), context.DeadlineExceeded) {
		return analysisError{"analysis_unavailable", "step_timeout"}
	}
	return err
}

// analysisStopped settles a job stopped by its graph's cancel (the API's own closing leaves it for the next start).
func (a *App) analysisStopped(tid, id string) {
	if !a.closing() {
		a.settleAnalysis(tid, id, "cancelled", "", "cancelled", "", nil)
	}
}

// startAnalysis moves a queued job to running (one more attempt) while its graph run still runs, and reads it.
func (a *App) startAnalysis(ctx context.Context, tid, id string) (*analysisJob, error) {
	job := &analysisJob{ID: id}
	var source []byte
	err := a.db.QueryRow(ctx, `UPDATE analysis_jobs j SET status='running',attempts=attempts+1,started_at=clock_timestamp() WHERE j.tenant_id=$1 AND j.id=$2 AND j.status='queued'
		AND EXISTS(SELECT 1 FROM graph_runs g WHERE g.tenant_id=j.tenant_id AND g.id=j.graph_id AND g.status='running') RETURNING canvas_id,node_id,source,options`, tid, id).
		Scan(&job.CanvasID, &job.NodeID, &source, &job.Options)
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(source, &job.Source); err != nil {
		return nil, err
	}
	return job, nil
}

func (a *App) analysisClient() *http.Client {
	return &http.Client{Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// analysisCall sends one request to the worker's analysis routes.
func (a *App) analysisCall(ctx context.Context, method, route string, body io.Reader, size int64, contentType string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(a.cfg.AnalysisURL, "/")+"/internal/analyses"+route, body)
	if err != nil {
		return nil, err
	}
	if size >= 0 {
		req.ContentLength = size
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.AnalysisToken)
	return a.analysisClient().Do(req)
}

// analysisWorkerError maps a worker refusal to the job's end: a video the worker refused keeps the worker's message.
func analysisWorkerError(status int, raw []byte) error {
	var reply struct {
		Error struct {
			Code, Message, Detail, Field string
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &reply)
	e := reply.Error
	switch {
	case status == 400 && e.Code == "INVALID_ANALYSIS":
		return analysisError{"analysis_rejected", firstRunes(e.Message, 500)}
	case status == 400 && e.Code == "ANALYSIS_FILE_MISMATCH":
		return analysisError{"analysis_file_mismatch", ""}
	case status == 400 && e.Code == "ANALYSIS_FILE_UNSUPPORTED":
		return analysisError{"analysis_rejected", firstRunes(e.Message, 500)}
	case status == 413:
		return analysisError{"analysis_rejected", "The request is larger than the worker takes"}
	case status == 429:
		return analysisError{"analysis_busy", ""}
	case status == 401 || status == 404 || status == 409 || status == 503:
		// No token, a worker without this job any more (stopped, removed, restarted), or one that cannot: the
		// platform's, not the video's.
		return analysisError{"analysis_unavailable", ""}
	case status == 422 && e.Detail == "timeout":
		return analysisError{"timeout", ""}
	case status == 422:
		return analysisError{"analysis_failed", firstRunes(e.Detail, 80)}
	case status >= 500:
		return analysisError{"analysis_unavailable", ""}
	}
	return analysisError{"analysis_failed", ""}
}

func readAnalysisReply(resp *http.Response, limit int64) ([]byte, error) {
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, analysisError{"analysis_failed", "reply_unreadable"}
	}
	return raw, nil
}

// analysisDisplayName is the video's name as the worker's manifest takes it: 1–200 characters, no slashes or control
// characters (it is a label only; the worker stores the file under a name of its own).
func analysisDisplayName(name string) string {
	clean := strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || unicode.IsControl(r) {
			return '_'
		}
		return r
	}, name)
	clean = firstRunes(strings.TrimSpace(clean), 200)
	if clean == "" {
		return "video"
	}
	return clean
}

// createWorkerAnalysis hands the worker the job's manifest, asking again while it answers busy (analysisBusyRetry).
// A job of the same id an earlier attempt left on the worker (the API restarted mid-analysis) is removed first.
func (a *App) createWorkerAnalysis(ctx context.Context, job *analysisJob) error {
	options := job.Options
	if !json.Valid(options) {
		options = json.RawMessage(`{}`)
	}
	body, err := json.Marshal(map[string]any{"analysisId": job.ID,
		"file": map[string]any{"name": analysisDisplayName(job.Source.Name), "size": job.Source.Size, "sha256": job.Source.SHA256}, "options": options})
	if err != nil {
		return analysisError{"analysis_failed", "manifest"}
	}
	a.deleteWorkerAnalysis(job.ID)
	deadline := time.Now().Add(analysisBusyRetry)
	for attempt := 1; ; attempt++ {
		resp, err := a.analysisCall(ctx, http.MethodPost, "", bytes.NewReader(body), int64(len(body)), "application/json")
		if err != nil {
			return analysisError{"analysis_unavailable", ""}
		}
		raw, err := readAnalysisReply(resp, 64<<10)
		if err != nil {
			return err
		}
		if resp.StatusCode == http.StatusCreated {
			return nil
		}
		pause := min(time.Duration(attempt)*time.Second, 5*time.Second)
		if resp.StatusCode != http.StatusTooManyRequests || time.Now().Add(pause).After(deadline) {
			return analysisWorkerError(resp.StatusCode, raw)
		}
		select {
		case <-time.After(pause):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// putWorkerAnalysisFile streams the stored video to the worker.
func (a *App) putWorkerAnalysisFile(ctx context.Context, tid string, job *analysisJob) error {
	path, ok := a.mediaFile(tid, job.Source.Path)
	if !ok {
		return analysisError{"analysis_file_missing", ""}
	}
	file, err := os.Open(path)
	if err != nil {
		return analysisError{"analysis_file_missing", ""}
	}
	defer file.Close()
	resp, err := a.analysisCall(ctx, http.MethodPut, "/"+job.ID+"/file", file, job.Source.Size, "application/octet-stream")
	if err != nil {
		return analysisError{"analysis_unavailable", ""}
	}
	raw, err := readAnalysisReply(resp, 64<<10)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusNoContent {
		return analysisWorkerError(resp.StatusCode, raw)
	}
	return nil
}

// runAnalysisJob runs the job on the worker, each step under its own time (analysisStep), and keeps its outputs; the
// worker's job is removed however it ends.
func (a *App) runAnalysisJob(ctx context.Context, tid string, job *analysisJob, runTime time.Duration) error {
	defer a.deleteWorkerAnalysis(job.ID)
	if err := analysisStep(ctx, analysisBusyRetry+2*time.Minute, func(step context.Context) error { return a.createWorkerAnalysis(step, job) }); err != nil {
		return err
	}
	if err := analysisStep(ctx, analysisUploadTime, func(step context.Context) error { return a.putWorkerAnalysisFile(step, tid, job) }); err != nil {
		return err
	}
	var reply *analysisReply
	if err := analysisStep(ctx, runTime, func(step context.Context) (err error) { reply, err = a.runWorkerAnalysis(step, job); return err }); err != nil {
		return err
	}
	return analysisStep(ctx, analysisKeepTime, func(step context.Context) error {
		kept, err := a.fetchAnalysisOutputs(step, tid, job, reply.Outputs)
		defer kept.discard()
		if err != nil {
			return err
		}
		return a.saveAnalysis(step, tid, job, reply, kept)
	})
}

// runWorkerAnalysis has the worker analyse the job whose video it has, and reads its reply.
func (a *App) runWorkerAnalysis(ctx context.Context, job *analysisJob) (*analysisReply, error) {
	resp, err := a.analysisCall(ctx, http.MethodPost, "/"+job.ID+"/run", nil, 0, "")
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, analysisError{"analysis_unavailable", ""}
	}
	raw, err := readAnalysisReply(resp, 4<<20)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, analysisWorkerError(resp.StatusCode, raw)
	}
	var reply analysisReply
	if json.Unmarshal(raw, &reply) != nil || reply.AnalysisID != job.ID {
		return nil, analysisError{"analysis_failed", "reply_invalid"}
	}
	return &reply, nil
}

func (a *App) deleteWorkerAnalysis(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if resp, err := a.analysisCall(ctx, http.MethodDelete, "/"+id, nil, 0, ""); err == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()
	}
}
