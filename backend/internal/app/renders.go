package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Motion renders: a member turns an HTML deliverable into a video. The render worker (apps/render-worker) freezes
// the page at every frame in a fresh headless browser that may reach only the preview's CDN allowlist, and encodes
// an MP4 (and optionally a GIF and a contact sheet). A page that defines window.renderAt(t) renders exactly; any
// other page runs on the worker's virtual clock. The videos become artifacts of the canvas, stored and served like
// generated media. Off unless AWWO_RENDER_URL and AWWO_RENDER_TOKEN are set.

const (
	maxRenderHTMLBytes  = 6 << 20
	maxRenderBodyBytes  = 7 << 20
	maxRenderSeconds    = 20.0
	maxRenderFrames     = 1800
	maxRenderReplyBytes = 160 << 20
	// The render worker reads request bodies of at most 8 MiB (apps/render-worker/config.mjs).
	maxRenderWorkerBody  = 8 << 20
	maxRenderOutputBytes = 100 << 20
)

const renderJSON = `jsonb_build_object('id',j.id,'canvasId',j.canvas_id,'nodeId',j.node_id,'status',j.status,'params',j.params,'htmlBytes',j.html_bytes,'htmlSha256',j.html_sha256,'result',j.result,'errorCode',j.error_code,'createdAt',j.created_at,'startedAt',j.started_at,'finishedAt',j.finished_at)`

// Failures that are not the workspace's doing give their allowance back (the worker down or busy, the API
// restarting), as does a render stopped before it reached the worker.
const renderCountedToday = "j.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND NOT (j.status='failed' AND j.error_code IN ('render_unavailable','render_busy','interrupted')) AND NOT (j.status='cancelled' AND j.started_at IS NULL)"

type renderParams struct {
	Width   int     `json:"width"`
	Height  int     `json:"height"`
	FPS     int     `json:"fps"`
	Seconds float64 `json:"seconds"`
	Loop    bool    `json:"loop"`
	GIF     bool    `json:"gif"`
	Contact bool    `json:"contact"`
}

type renderInput struct {
	OperationID string `json:"operationId"`
	NodeID      string `json:"nodeId"`
	HTML        string `json:"html"`
	renderParams
}

func (p *renderParams) frames() int { return int(math.Round(p.Seconds * float64(p.FPS))) }

func (p *renderParams) validate() error {
	if p.Width < 64 || p.Width > 1920 || p.Height < 64 || p.Height > 1920 {
		return renderInvalid("Width and height are 64–1920 pixels")
	}
	p.Width, p.Height = p.Width&^1, p.Height&^1
	if p.FPS < 1 || p.FPS > 60 {
		return renderInvalid("Frames per second is 1–60")
	}
	if math.IsNaN(p.Seconds) || p.Seconds < 0.5 || p.Seconds > maxRenderSeconds {
		return renderInvalid("A render is 0.5–20 seconds long")
	}
	if n := p.frames(); n < 1 || n > maxRenderFrames {
		return renderInvalid("A render has at most 1,800 frames")
	}
	return nil
}

type renderError struct {
	status        int
	code, message string
}

func (e renderError) Error() string { return e.message }
func renderInvalid(message string) error {
	return renderError{400, "invalid_render", message}
}

func (a *App) renderFailure(w http.ResponseWriter, e error) {
	var input renderError
	if errors.As(e, &input) {
		fail(w, input.status, input.code, input.message)
		return
	}
	if noRows(e) {
		fail(w, 404, "not_found", "Render not found")
		return
	}
	a.dbError(w, e)
}

func renderPageShape(html string) bool {
	head := strings.ToLower(html[:min(len(html), 4096)])
	return strings.Contains(head, "<html") || strings.Contains(head, "<!doctype html")
}

func (a *App) createRender(w http.ResponseWriter, r *http.Request) {
	if a.cfg.RenderURL == "" {
		fail(w, 503, "render_unavailable", "Video rendering is not configured on this server")
		return
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		fail(w, 415, "unsupported_media_type", "Use application/json")
		return
	}
	var b renderInput
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRenderBodyBytes))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&b); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			fail(w, 413, "render_too_large", "The page is too large to render (at most 6 MiB)")
		} else {
			fail(w, 400, "invalid_json", "Invalid JSON request")
		}
		return
	}
	if len(b.OperationID) < 8 || len(b.OperationID) > 200 || len(b.NodeID) > 200 {
		a.renderFailure(w, renderInvalid("operationId (8–200 bytes) is required"))
		return
	}
	if len(b.HTML) == 0 || len(b.HTML) > maxRenderHTMLBytes || !renderPageShape(b.HTML) || strings.IndexByte(b.HTML, 0) >= 0 {
		a.renderFailure(w, renderInvalid("A complete HTML document of at most 6 MiB is required"))
		return
	}
	if err = b.renderParams.validate(); err != nil {
		a.renderFailure(w, err)
		return
	}
	if len(renderRequestBody(strings.Repeat("x", 44), b.HTML, b.renderParams)) > maxRenderWorkerBody {
		fail(w, 413, "render_too_large", "The page is too large to render (at most 6 MiB)")
		return
	}
	params := jsonBytes(b.renderParams)
	sum := sha256.Sum256([]byte(b.HTML))
	htmlHash := hex.EncodeToString(sum[:])
	tid, cid := r.PathValue("tenantId"), r.PathValue("canvasId")
	requestHash := tokenHash(cid + "\x00" + b.NodeID + "\x00" + htmlHash + "\x00" + string(params))
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	var existingHash string
	var existing json.RawMessage
	err = tx.QueryRow(r.Context(), "SELECT j.request_hash,"+renderJSON+" FROM render_jobs j WHERE j.tenant_id=$1 AND j.operation_id=$2", tid, b.OperationID).Scan(&existingHash, &existing)
	if err == nil {
		if existingHash != requestHash {
			fail(w, 409, "idempotency_conflict", "operationId was used for a different render")
			return
		}
		writeJSON(w, 200, existing)
		return
	}
	if !noRows(err) {
		a.dbError(w, err)
		return
	}
	// The canvas row stays share-locked until the render is recorded, so a deletion either went first (not found)
	// or waits and then sees the render as active and refuses (resources.go).
	var canvas string
	if err = tx.QueryRow(r.Context(), "SELECT id FROM canvases WHERE tenant_id=$1 AND id=$2 FOR SHARE", tid, cid).Scan(&canvas); noRows(err) {
		fail(w, 404, "not_found", "Canvas not found")
		return
	} else if err != nil {
		a.dbError(w, err)
		return
	}
	// The site-wide count takes its own lock after the workspace's, so renders from different workspaces cannot
	// pass the site's daily limit together.
	if _, err = tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(84321013)"); err != nil {
		a.dbError(w, err)
		return
	}
	var active, today, site int
	if err = tx.QueryRow(r.Context(), "SELECT (SELECT count(*) FROM render_jobs j WHERE j.tenant_id=$1 AND j.status IN ('queued','running')),(SELECT count(*) FROM render_jobs j WHERE j.tenant_id=$1 AND "+renderCountedToday+"),(SELECT count(*) FROM render_jobs j WHERE "+renderCountedToday+")", tid).Scan(&active, &today, &site); err != nil {
		a.dbError(w, err)
		return
	}
	switch {
	case active > 0:
		fail(w, 429, "render_busy", "This workspace is already rendering a video; wait for it to finish")
		return
	case today >= a.cfg.RendersPerDay:
		fail(w, 429, "render_quota", "This workspace has used today's video renders")
		return
	case site >= a.cfg.RendersSitePerDay:
		fail(w, 429, "render_quota", "Video rendering has reached today's limit; try again tomorrow")
		return
	}
	id := randomID()
	value, err := oneJSON(r.Context(), tx, "INSERT INTO render_jobs AS j(id,tenant_id,canvas_id,node_id,actor_id,operation_id,request_hash,status,params,html_sha256,html_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10) RETURNING "+renderJSON,
		id, tid, cid, b.NodeID, currentUser(r).ID, b.OperationID, requestHash, params, htmlHash, len(b.HTML))
	if err != nil {
		a.dbError(w, err)
		return
	}
	if err = audit(r.Context(), tx, currentUser(r).ID, tid, "render.created", id); err != nil {
		a.dbError(w, err)
		return
	}
	if !a.workerAvailable(w) {
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		a.dbError(w, err)
		return
	}
	a.startRender(tid, id, cid, b.NodeID, b.HTML, b.renderParams)
	writeJSON(w, 202, value)
}

func (a *App) startRender(tid, id, canvasID, nodeID, html string, p renderParams) {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	// Cancelled by a member's stop or the API closing; the render's own time limit starts when it reaches the worker.
	ctx, cancel := context.WithCancel(context.Background())
	a.running[id] = cancel
	a.tasks.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.tasks.Done()
		defer cancel()
		defer func() { a.mu.Lock(); delete(a.running, id); a.mu.Unlock() }()
		a.executeRender(ctx, tid, id, canvasID, nodeID, html, p)
	}()
}

type renderOutput struct {
	Kind        string `json:"kind"`
	Frame       *int   `json:"frame,omitempty"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	Data        string `json:"data"`
}

type renderReply struct {
	RenderID       string          `json:"renderId"`
	Mode           string          `json:"mode"`
	Frames         int             `json:"frames"`
	FPS            int             `json:"fps"`
	Width          int             `json:"width"`
	Height         int             `json:"height"`
	Seconds        float64         `json:"seconds"`
	DistinctFrames int             `json:"distinctFrames"`
	ElapsedMS      int64           `json:"elapsedMs"`
	Probe          json.RawMessage `json:"probe"`
	Warnings       []string        `json:"warnings"`
	PageErrors     []string        `json:"pageErrors"`
	Outputs        []renderOutput  `json:"outputs"`
}

type renderStored struct {
	Kind        string `json:"kind"`
	ArtifactID  string `json:"artifactId"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
}

// renderClient talks only to the configured worker: no proxy variables, no redirects.
func (a *App) renderClient() *http.Client {
	return &http.Client{Timeout: a.cfg.RenderTimeout, Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext, ResponseHeaderTimeout: a.cfg.RenderTimeout},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// settleRender ends a render still queued or running. It tries again after a database error: a render left running
// would block its workspace's next one until the API restarts.
func (a *App) settleRender(tid, id, status, code string, result any) {
	raw := []byte(`{}`)
	if result != nil {
		raw = jsonBytes(result)
	}
	var errorCode any
	if code != "" {
		errorCode = code
	}
	for attempt := 1; ; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, err := a.db.Exec(ctx, "UPDATE render_jobs SET status=$3,error_code=$4,result=$5,finished_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running')", tid, id, status, errorCode, raw)
		cancel()
		if err == nil {
			return
		}
		a.log.Error("render settle failed", "error_type", fmt.Sprintf("%T", err), "attempt", attempt)
		if attempt == 3 {
			return
		}
		time.Sleep(time.Duration(attempt) * 500 * time.Millisecond)
	}
}

// renderQueue lets one render at a time go to the worker (it renders one at a time and refuses a second); the others
// wait queued instead of failing.
func (a *App) renderQueue() chan struct{} {
	a.renderSlotOnce.Do(func() { a.renderSlot = make(chan struct{}, 1) })
	return a.renderSlot
}

func (a *App) closing() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.closed
}

// renderEndCode names why a render's context ended: the API closing (a deploy, a lost database lock) is the
// server's doing and charged to nobody, the render's time limit is a timeout, a member's stop a cancellation.
func (a *App) renderEndCode(ctx context.Context, code string) string {
	switch {
	case a.closing():
		return "interrupted"
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return "timeout"
	case ctx.Err() != nil:
		return "cancelled"
	}
	return code
}

// renderRequestBody is the worker request. HTML is not escaped (json.Marshal would turn every <, > and & into six
// bytes), so its size is the page's own plus what control characters need; admission checks it against the worker's
// body limit before a render is counted.
func renderRequestBody(id, html string, p renderParams) []byte {
	outputs := []string{"mp4"}
	if p.GIF {
		outputs = append(outputs, "gif")
	}
	if p.Contact {
		outputs = append(outputs, "contact")
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(map[string]any{"renderId": id, "html": html, "width": p.Width, "height": p.Height, "fps": p.FPS, "seconds": p.Seconds, "loop": p.Loop, "outputs": outputs, "stills": []int{}})
	return buffer.Bytes()
}

func (a *App) executeRender(stop context.Context, tid, id, canvasID, nodeID, html string, p renderParams) {
	// Waiting for the worker: a render still queued when its wait runs out never reached the worker, so it is
	// charged to nobody (render_busy), as is one the API stopped while closing.
	queue := a.renderQueue()
	wait := time.NewTimer(a.cfg.RenderTimeout)
	select {
	case queue <- struct{}{}:
		wait.Stop()
		defer func() { <-queue }()
	case <-wait.C:
		a.settleRender(tid, id, "failed", "render_busy", nil)
		return
	case <-stop.Done():
		wait.Stop()
		a.settleRender(tid, id, "failed", a.renderEndCode(stop, "render_busy"), nil)
		return
	}
	ctx, done := context.WithTimeout(stop, a.cfg.RenderTimeout)
	defer done()
	tag, err := a.db.Exec(ctx, "UPDATE render_jobs SET status='running',started_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='queued'", tid, id)
	if err != nil {
		a.settleRender(tid, id, "failed", a.renderEndCode(ctx, "render_unavailable"), nil)
		return
	}
	if tag.RowsAffected() != 1 {
		return // stopped before it started
	}
	body := renderRequestBody(id, html, p)
	resp, err := a.postRender(ctx, body)
	if errors.Is(err, errRenderNeverTaken) {
		// Stopped while the worker was still busy: like a render stopped while queued, it is charged to nobody.
		bg, done := context.WithTimeout(context.Background(), 10*time.Second)
		_, _ = a.db.Exec(bg, "UPDATE render_jobs SET started_at=NULL WHERE tenant_id=$1 AND id=$2 AND status='cancelled'", tid, id)
		done()
		a.settleRender(tid, id, "failed", a.renderEndCode(ctx, "render_busy"), nil)
		return
	}
	if err != nil {
		a.settleRender(tid, id, "failed", a.renderEndCode(ctx, "render_unavailable"), nil)
		return
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxRenderReplyBytes+1))
	if err != nil || len(raw) > maxRenderReplyBytes {
		a.settleRender(tid, id, "failed", a.renderEndCode(ctx, "render_invalid_output"), nil)
		return
	}
	if resp.StatusCode != 200 {
		code, reason := renderWorkerFailure(resp.StatusCode, raw)
		var result any
		if reason != "" {
			result = map[string]string{"reason": reason}
		}
		a.settleRender(tid, id, "failed", code, result)
		return
	}
	var reply renderReply
	if json.Unmarshal(raw, &reply) != nil || reply.RenderID != id {
		a.settleRender(tid, id, "failed", "render_invalid_output", nil)
		return
	}
	files, err := checkRenderOutputs(reply.Outputs)
	if err != nil {
		a.settleRender(tid, id, "failed", "render_invalid_output", nil)
		return
	}
	if len(reply.PageErrors) > 3 {
		reply.PageErrors = reply.PageErrors[:3]
	}
	result := map[string]any{"mode": reply.Mode, "frames": reply.Frames, "fps": reply.FPS, "width": reply.Width, "height": reply.Height,
		"seconds": reply.Seconds, "distinctFrames": reply.DistinctFrames, "elapsedMs": reply.ElapsedMS, "probe": reply.Probe, "warnings": nonNil(reply.Warnings), "pageErrors": nonNil(reply.PageErrors)}
	if err = a.saveRender(ctx, tid, id, canvasID, nodeID, files, result); err != nil {
		code := "render_storage_failed"
		var input renderError
		if errors.As(err, &input) {
			code = input.code
		}
		a.settleRender(tid, id, "failed", a.renderEndCode(ctx, code), nil)
	}
}

// renderBusyRetry is how long a render that holds the queue keeps asking a worker that still answers busy: after a
// stopped render the worker closes its browser before it takes the next one. A variable so tests can shorten it.
var renderBusyRetry = 15 * time.Second

// postRender sends the render to the worker, asking again (with a growing pause) while it answers busy, for up to
// renderBusyRetry. Its last answer is returned whatever it is.
func (a *App) postRender(ctx context.Context, body []byte) (*http.Response, error) {
	deadline := time.Now().Add(renderBusyRetry)
	for attempt := 1; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(a.cfg.RenderURL, "/")+"/internal/renders", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+a.cfg.RenderToken)
		resp, err := a.renderClient().Do(req)
		if err != nil || resp.StatusCode != http.StatusTooManyRequests {
			return resp, err
		}
		pause := min(time.Duration(attempt)*250*time.Millisecond, 2*time.Second)
		if time.Now().Add(pause).After(deadline) {
			return resp, nil
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()
		select {
		case <-time.After(pause):
		case <-ctx.Done():
			return nil, errRenderNeverTaken
		}
	}
}

// errRenderNeverTaken: the render was stopped while the worker was still refusing it as busy, so the worker never
// rendered any of it.
var errRenderNeverTaken = errors.New("the render stopped before the worker took it")

func nonNil(items []string) []string {
	if items == nil {
		return []string{}
	}
	return items
}

// renderWorkerFailure maps the worker's refusal to a stable code. A page it refused for waiting on its own clock also
// keeps the worker's words, which name what waited (the render's result.reason, as a refused edit keeps its words,
// edit_worker.go); the worker's other messages are never shown.
func renderWorkerFailure(status int, raw []byte) (code, reason string) {
	var reply struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Detail  string `json:"detail"`
		} `json:"error"`
	}
	// A field of another type is left empty and the others are still read (json.Unmarshal goes on past it).
	_ = json.Unmarshal(raw, &reply)
	switch {
	case status == 429:
		return "render_busy", ""
	case status == 503 || status == 401:
		return "render_unavailable", ""
	case status == 422 && reply.Error.Detail == "timeout":
		return "timeout", ""
	case status == 422 && reply.Error.Detail == "page_load_failed":
		return "render_page_failed", ""
	case status == 422 && reply.Error.Detail == "output_too_large":
		return "render_output_too_large", ""
	case status == 400 && reply.Error.Code == "INVALID_RENDER" && reply.Error.Detail == "page_waits_on_timers":
		return "render_page_waits_on_timers", renderReason(reply.Error.Message)
	case status == 400 || status == 413:
		return "render_rejected", ""
	}
	return "render_failed", ""
}

// renderReason is the worker's message as a render keeps it: one line of plain text of at most 500 characters (as many
// as an edit keeps of a refusal's words), without control characters (PostgreSQL's jsonb refuses a NUL), invisible
// format characters or broken UTF-8, its white space one space between words. It stops as soon as it can keep no
// more, so cleaning a broken worker's long message costs no more memory than the words kept.
func renderReason(message string) string {
	var kept strings.Builder
	count, space := 0, false
	for _, r := range message {
		if r == utf8.RuneError || unicode.Is(unicode.Cf, r) {
			continue
		}
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			if count >= 499 { // no room for a space and a character after it
				break
			}
			space = count > 0
			continue
		}
		if space {
			kept.WriteByte(' ')
			count, space = count+1, false
		}
		kept.WriteRune(r)
		if count++; count == 500 {
			break
		}
	}
	return kept.String()
}

var renderOutputKinds = map[string]struct{ field, name, ext, contentType string }{
	"mp4":     {"render-mp4", "motion.mp4", "mp4", "video/mp4"},
	"gif":     {"render-gif", "motion.gif", "gif", "image/gif"},
	"contact": {"render-contact", "contact-sheet.png", "png", "image/png"},
}

type renderFile struct {
	kind  string
	field string
	name  string
	ext   string
	mime  string
	hash  string
	data  []byte
}

// checkRenderOutputs reads every returned file before any of them is kept: each must match its digest and its own
// bytes (an MP4 must sniff as MP4, a GIF as GIF, a contact sheet as PNG), and there must be a video.
func checkRenderOutputs(outputs []renderOutput) ([]renderFile, error) {
	files := []renderFile{}
	seen := map[string]bool{}
	for _, out := range outputs {
		kind, ok := renderOutputKinds[out.Kind]
		if !ok || seen[out.Kind] {
			continue
		}
		seen[out.Kind] = true
		data, err := base64.StdEncoding.DecodeString(out.Data)
		if err != nil || len(data) == 0 || len(data) > maxRenderOutputBytes || int64(len(data)) != out.Size {
			return nil, renderError{0, "render_invalid_output", "invalid render output"}
		}
		sum := sha256.Sum256(data)
		hash := hex.EncodeToString(sum[:])
		if !strings.EqualFold(hash, out.SHA256) {
			return nil, renderError{0, "render_invalid_output", "render output digest mismatch"}
		}
		if contentType, ext, _ := sniffMedia(data[:min(len(data), 64)]); contentType != kind.contentType || ext != kind.ext {
			return nil, renderError{0, "render_invalid_output", "render output type mismatch"}
		}
		files = append(files, renderFile{kind: out.Kind, field: kind.field, name: kind.name, ext: kind.ext, mime: kind.contentType, hash: hash, data: data})
	}
	if !seen["mp4"] {
		return nil, renderError{0, "render_invalid_output", "the render returned no video"}
	}
	return files, nil
}

// saveRender keeps the checked files as the canvas's media and completes the render in one transaction: the
// artifacts and the completed job are recorded together or not at all (a render stopped meanwhile keeps nothing),
// and files written for a transaction that does not commit are removed again.
func (a *App) saveRender(ctx context.Context, tid, id, canvasID, nodeID string, files []renderFile, result map[string]any) error {
	var total int64
	for _, f := range files {
		total += int64(len(f.data))
	}
	release, ok := a.reserveMediaSpace(total)
	if !ok {
		return renderError{0, "media_storage_full", "media storage full"}
	}
	defer release()
	written, kept := []string{}, false
	defer func() {
		if !kept {
			for _, path := range written {
				_ = os.Remove(path)
			}
		}
	}()
	stored := []renderStored{}
	for _, f := range files {
		final := filepath.Join(a.cfg.MediaDir, tid, id, f.hash+"."+f.ext)
		if err := os.MkdirAll(filepath.Dir(final), 0o750); err != nil {
			return renderError{0, "render_storage_failed", "render storage failed"}
		}
		// Listed before it is written, so a write that fails halfway is removed too.
		written = append(written, final)
		if err := os.WriteFile(final, f.data, 0o640); err != nil {
			return renderError{0, "render_storage_failed", "render storage failed"}
		}
		stored = append(stored, renderStored{Kind: f.kind, ArtifactID: artifactID(tid, id, nodeID, f.field), Name: f.name, ContentType: f.mime, Size: int64(len(f.data))})
	}
	result["outputs"] = stored
	// The record is written outside the render's own deadline and stop: a COMMIT cut off halfway would leave its
	// outcome unknown. A member's stop is still honoured by the status guard below.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancel()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	for i, f := range files {
		if _, err = tx.Exec(ctx, `INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content,storage_path,content_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,''::bytea,$10,$11)
			ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,size=EXCLUDED.size,sha256=EXCLUDED.sha256,storage_path=EXCLUDED.storage_path,content_type=EXCLUDED.content_type`,
			stored[i].ArtifactID, tid, canvasID, id, nodeID, f.field, f.name, int64(len(f.data)), f.hash, tid+"/"+id+"/"+f.hash+"."+f.ext, f.mime); err != nil {
			return err
		}
	}
	tag, err := tx.Exec(ctx, "UPDATE render_jobs SET status='completed',error_code=NULL,result=$3,finished_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='running'", tid, id, jsonBytes(result))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return renderError{0, "cancelled", "the render was stopped while it was being saved"}
	}
	// From here the files stay whatever COMMIT answers: a commit whose reply was lost may have succeeded, and its
	// artifacts must not point at removed files. Files of a commit that did fail are unreferenced, and the media
	// sweep removes them (media_files.go).
	kept = true
	return tx.Commit(ctx)
}

func (a *App) getRender(w http.ResponseWriter, r *http.Request) {
	v, err := oneJSON(r.Context(), a.db, "SELECT "+renderJSON+" FROM render_jobs j WHERE j.tenant_id=$1 AND j.canvas_id=$2 AND j.id=$3", r.PathValue("tenantId"), r.PathValue("canvasId"), r.PathValue("id"))
	a.replyOne(w, v, err, 200)
}

func (a *App) listRenders(w http.ResponseWriter, r *http.Request) {
	node := r.URL.Query().Get("nodeId")
	if len(node) > 200 {
		fail(w, 400, "invalid_input", "Invalid node")
		return
	}
	items, err := rowsJSON(r.Context(), a.db, "SELECT "+renderJSON+" FROM render_jobs j WHERE j.tenant_id=$1 AND j.canvas_id=$2 AND ($3='' OR j.node_id=$3) ORDER BY j.created_at DESC,j.id DESC LIMIT 30", r.PathValue("tenantId"), r.PathValue("canvasId"), node)
	a.replyList(w, items, err)
}

func (a *App) cancelRender(w http.ResponseWriter, r *http.Request) {
	tid, cid, id := r.PathValue("tenantId"), r.PathValue("canvasId"), r.PathValue("id")
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	value, err := oneJSON(r.Context(), tx, "UPDATE render_jobs AS j SET status=CASE WHEN status IN ('queued','running') THEN 'cancelled' ELSE status END,finished_at=CASE WHEN status IN ('queued','running') THEN clock_timestamp() ELSE finished_at END WHERE j.tenant_id=$1 AND j.canvas_id=$2 AND j.id=$3 RETURNING "+renderJSON, tid, cid, id)
	if err != nil {
		a.renderFailure(w, err)
		return
	}
	if err = audit(r.Context(), tx, currentUser(r).ID, tid, "render.cancelled", id); err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		a.dbError(w, err)
		return
	}
	a.mu.Lock()
	stop := a.running[id]
	a.mu.Unlock()
	if stop != nil {
		stop()
	}
	writeJSON(w, 200, value)
}

func (a *App) registerRenderRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/canvases/{canvasId}/renders", a.tenant(a.listRenders, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/canvases/{canvasId}/renders", a.tenant(a.createRender, 2))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/canvases/{canvasId}/renders/{id}", a.tenant(a.getRender, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/canvases/{canvasId}/renders/{id}/cancel", a.tenant(a.cancelRender, 2))
}

// interruptRenders fails what an earlier process left queued or running: the page is not kept, and a render is
// never repeated without being asked for again.
func interruptRenders(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, "UPDATE render_jobs SET status='failed',error_code='interrupted',finished_at=clock_timestamp() WHERE status IN ('queued','running')")
	return err
}
