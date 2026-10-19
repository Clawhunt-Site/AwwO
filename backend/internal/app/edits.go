package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Edit nodes (kind "edit"; migration 040; the render worker's edit-*.mjs): a canvas run's edit node joins the clips,
// sounds and pictures wired into it (ports clips, sounds, pictures) into one film, by an awwo.timeline/1 document
// wired into its timeline port (an agent's answer) or written on the node itself. No model runs and no provider is
// paid: the render worker gets only the stored files the timeline names, each one a file the node it names produced
// (a generation or another edit), renders with ffmpeg, and the film, its stills, subtitles and report become
// artifacts of the canvas. The node delivers an awwo.media record of kind video, so a later node takes the film like
// a generated clip (mediaDeliveryText lists the extra files too).

const (
	editTimelineSchema   = "awwo.timeline/1"
	editModelID          = "awwo-edit"
	maxEditTimelineBytes = 2 << 20
	maxEditFiles         = 300
	maxEditAttempts      = 3
	maxEditInputBytes    = 6 << 30
	// editAllowanceLock serializes the site-wide count of today's edits (renders take 84321013).
	editAllowanceLock = 84321040
)

// editSourceName is a file a timeline names: <node id>/<file name>, as the render worker checks it.
var editSourceName = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}$`)

// editUserError is a failure the node shows as it is: what is wrong with the timeline or its files.
type editUserError struct{ message string }

func (e editUserError) Error() string { return e.message }

func editUserErrorf(format string, args ...any) error {
	return editUserError{fmt.Sprintf(format, args...)}
}

// errEditWaiting: the workspace's other edit is still queued or running; this one is admitted when it ends.
var errEditWaiting = errors.New("edit_waiting")

// editWaitPause is how long a node waiting for its workspace's other edit waits before it looks again (its graph
// passes every 70 ms); a variable so tests can shorten it.
var editWaitPause = 3 * time.Second

// editAdmissionCodes are the stable codes admission fails with; any other error (the database's) shows as one code.
var editAdmissionCodes = map[string]bool{"edit_unavailable": true, "edit_allowance": true, "execution_revoked": true, "graph_not_running": true, "plan_required": true}

// editAdmissionDetail is what a node whose edit was not admitted shows: the user's error, a stable code, never
// another error's text.
func editAdmissionDetail(err error) string {
	var user editUserError
	switch {
	case errors.As(err, &user):
		return user.message
	case editAdmissionCodes[err.Error()]:
		return err.Error()
	case errors.Is(err, errPlanRequired):
		return "plan_required"
	}
	return "edit_unavailable"
}

// editPort is an edit node's port type: the timeline (text) and the media it joins coming in, the film going out.
func editPort(id string, input bool) (string, bool) {
	if !input {
		return mediaKindVideo, id == "result"
	}
	switch id {
	case "timeline":
		return "text", true
	case "clips":
		return mediaKindVideo, true
	case "sounds":
		return mediaKindAudio, true
	case "pictures":
		return mediaKindImage, true
	}
	return "", false
}

// graphMediaSource reports whether n delivers an awwo.media record: a media node, or an edit node (its film).
func graphMediaSource(n graphNode) bool {
	return graphMediaNode(n) || n.Kind == "edit"
}

// scopeHasEdit reports whether a graph run would execute an edit node.
func scopeHasEdit(d graphDocument, scope []string) bool {
	in := map[string]bool{}
	for _, id := range scope {
		in[id] = true
	}
	for _, n := range d.Nodes {
		if n.Kind == "edit" && in[n.ID] {
			return true
		}
	}
	return false
}

// validateEditNode checks an in-scope edit node as parseGraph reads it: one timeline, wired or its own.
func validateEditNode(n graphNode, timelineSources int) error {
	if timelineSources > 1 {
		return errors.New("An edit node takes one timeline")
	}
	own := strings.TrimSpace(n.Timeline)
	if timelineSources == 0 && own == "" {
		return errors.New("An edit node needs a timeline: wire one into it, or write its own")
	}
	if len(own) > maxEditTimelineBytes {
		return errors.New("An edit node's timeline is larger than 2 MiB")
	}
	return nil
}

// editTimelineText is the node's timeline: the text wired into its timeline port (an agent's answer, or one field of
// a contract node), else its own.
func editTimelineText(n graphNode, d graphDocument, outputs map[string]string) (string, error) {
	for _, e := range d.Edges {
		if e.ToNode != n.ID || e.ToPort != "timeline" {
			continue
		}
		for _, src := range d.Nodes {
			if src.ID != e.FromNode {
				continue
			}
			out := stripReasoningPreamble(outputs[src.ID])
			if src.Contract != nil {
				values, err := graphOutput(src, out)
				if err != nil {
					return "", editUserErrorf("The timeline's node did not deliver its fields: %s", firstRunes(err.Error(), 200))
				}
				out = values[strings.TrimPrefix(e.FromPort, "out:")]
			}
			return out, nil
		}
	}
	return n.Timeline, nil
}

// timelineJSON finds the timeline in an answer: the whole text when it is one JSON object, else the first fenced
// block (```json … ```), else the text from its first { to its last }.
func timelineJSON(text string) string {
	body := strings.TrimSpace(text)
	if strings.HasPrefix(body, "{") && json.Valid([]byte(body)) {
		return body
	}
	if start := strings.Index(body, "```"); start >= 0 {
		rest := body[start+3:]
		if newline := strings.IndexByte(rest, '\n'); newline >= 0 {
			rest = rest[newline+1:]
		}
		if end := strings.Index(rest, "```"); end >= 0 {
			return strings.TrimSpace(rest[:end])
		}
	}
	if first, last := strings.IndexByte(body, '{'), strings.LastIndexByte(body, '}'); first >= 0 && last > first {
		return body[first : last+1]
	}
	return body
}

// parseEditTimeline reads a timeline far enough to know which files it names (in their first order); the render
// worker checks everything else. A text that is not a timeline fails with a message the node shows.
func parseEditTimeline(text string) (json.RawMessage, []string, error) {
	body := timelineJSON(text)
	if len(body) > maxEditTimelineBytes {
		return nil, nil, editUserErrorf("The timeline is larger than 2 MiB")
	}
	if !json.Valid([]byte(body)) {
		return nil, nil, editUserErrorf("The timeline is not a JSON object with tracks of items")
	}
	// The job row keeps it as jsonb, which holds no lone UTF-16 surrogate and no NUL character: it is read and written
	// again (a lone surrogate reads as U+FFFD), and one that still holds a NUL is refused (a timeline needs none).
	body, err := normalizedJSON(body)
	if err != nil {
		return nil, nil, editUserErrorf("The timeline is not a JSON object with tracks of items")
	}
	if len(body) > maxEditTimelineBytes { // written again it can grow (U+2028 and U+2029 are escaped)
		return nil, nil, editUserErrorf("The timeline is larger than 2 MiB")
	}
	if strings.Contains(body, `\u0000`) {
		return nil, nil, editUserErrorf("The timeline holds a NUL character")
	}
	var doc struct {
		Schema string                       `json:"schema"`
		Tracks map[string][]json.RawMessage `json:"tracks"`
	}
	if json.Unmarshal([]byte(body), &doc) != nil {
		return nil, nil, editUserErrorf("The timeline is not a JSON object with tracks of items")
	}
	if doc.Schema != editTimelineSchema {
		return nil, nil, editUserErrorf("The timeline's schema must be %q", editTimelineSchema)
	}
	seen := map[string]bool{}
	sources := []string{}
	for _, track := range []string{"video", "dialogue", "music", "sfx"} {
		for _, raw := range doc.Tracks[track] {
			var item struct {
				Source string `json:"source"`
			}
			if json.Unmarshal(raw, &item) != nil || item.Source == "" || seen[item.Source] {
				continue
			}
			if !editSourceName.MatchString(item.Source) {
				return nil, nil, editUserErrorf("The timeline names %q, which is not a <node>/<file> name", firstRunes(item.Source, 120))
			}
			seen[item.Source] = true
			sources = append(sources, item.Source)
		}
	}
	if len(sources) > maxEditFiles {
		return nil, nil, editUserErrorf("The timeline names more than %d files", maxEditFiles)
	}
	return json.RawMessage(body), sources, nil
}

// normalizedJSON is a valid JSON text read and written again: numbers as they were written, markup unescaped (a
// card's <, > and &), every string valid UTF-8.
func normalizedJSON(text string) (string, error) {
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", err
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buffer.String(), "\n"), nil
}

// editFile is a stored file a job sends the worker, as the job row keeps it.
type editFile struct {
	Name        string `json:"name"`
	ArtifactID  string `json:"artifactId"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	Path        string `json:"path"`
}

// editDelivered is a file a wired node delivered: its record's item, the node and the port it came in by.
type editDelivered struct {
	item mediaItem
	node string
	port string
}

// editSources maps every file the nodes wired into the edit node delivered (<node id>/<file name>) to its artifact.
func editSources(n graphNode, d graphDocument, outputs map[string]string) map[string]editDelivered {
	files := map[string]editDelivered{}
	for _, e := range d.Edges {
		if e.ToNode != n.ID || (e.ToPort != "clips" && e.ToPort != "sounds" && e.ToPort != "pictures") {
			continue
		}
		var record struct {
			Type  string      `json:"type"`
			Items []mediaItem `json:"items"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(outputs[e.FromNode])), &record) != nil || record.Type != mediaOutputType {
			continue
		}
		for _, item := range record.Items {
			files[e.FromNode+"/"+item.Name] = editDelivered{item: item, node: e.FromNode, port: e.ToPort}
		}
	}
	return files
}

// editPortTypes is the content a port takes: a clip is a video, a sound audio, a picture an image.
var editPortTypes = map[string]string{"clips": "video/", "sounds": "audio/", "pictures": "image/"}

// editFilesFor resolves the timeline's files to stored artifacts of this canvas: each must be a file the node it is
// named after produced (a generation's media-N field, or another edit's film) of the kind its port takes. A record
// written by a model or a client cannot point the edit at any other stored file.
func editFilesFor(ctx context.Context, tx pgx.Tx, tid, canvasID string, names []string, delivered map[string]editDelivered) ([]editFile, error) {
	files := []editFile{}
	var total int64
	for _, name := range names {
		got, ok := delivered[name]
		if !ok {
			return nil, editUserErrorf("The timeline names %s, which none of the nodes wired into this edit delivered", name)
		}
		f := editFile{Name: name, ArtifactID: got.item.ArtifactID}
		err := tx.QueryRow(ctx, `SELECT size,sha256,storage_path,content_type FROM artifacts WHERE tenant_id=$1 AND canvas_id=$2 AND id=$3 AND node_id=$4
			AND (field_id LIKE 'media-%' OR field_id='edit-film') AND storage_path IS NOT NULL AND content_type IS NOT NULL`,
			tid, canvasID, got.item.ArtifactID, got.node).Scan(&f.Size, &f.SHA256, &f.Path, &f.ContentType)
		if noRows(err) {
			return nil, editUserErrorf("The file %s is not a stored file of the node it names", name)
		}
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(f.ContentType, editPortTypes[got.port]) {
			return nil, editUserErrorf("The file %s (%s) is not what the %s input takes", name, f.ContentType, got.port)
		}
		total += f.Size
		files = append(files, f)
	}
	if total > maxEditInputBytes {
		return nil, editUserErrorf("The timeline's files add up to more than 6 GiB")
	}
	return files, nil
}

// editCountedToday: the UTC day's edits a workspace is charged for, as renders count theirs (renderCountedToday): an
// edit the platform failed (no worker, the worker busy, a restart, a stored file it could not read or that is not the
// file its record says, no room to keep the film) or one cancelled before it started is not charged.
const editCountedToday = "created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND NOT (status='failed' AND error_code IN " +
	"('edit_unavailable','edit_busy','interrupted','edit_file_missing','edit_file_mismatch','edit_storage_failed','media_storage_full')) AND NOT (status='cancelled' AND started_at IS NULL)"

// editAllowance waits for the workspace's edit in progress and refuses one past today's allowance (the job rows are
// the ledger); the site-wide count is taken under its own lock.
func (a *App) editAllowance(ctx context.Context, tx pgx.Tx, tid string) error {
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", editAllowanceLock); err != nil {
		return err
	}
	var active, mine, all int
	if err := tx.QueryRow(ctx, "SELECT (SELECT count(*) FROM edit_jobs WHERE tenant_id=$1 AND status IN ('queued','running')),(SELECT count(*) FROM edit_jobs WHERE tenant_id=$1 AND "+editCountedToday+"),(SELECT count(*) FROM edit_jobs WHERE "+editCountedToday+")", tid).
		Scan(&active, &mine, &all); err != nil {
		return err
	}
	if active > 0 {
		return errEditWaiting
	}
	perDay, sitePerDay, _, _ := a.editLimits()
	if mine >= perDay || all >= sitePerDay {
		return errors.New("edit_allowance")
	}
	return nil
}

// editAdmissible checks, inside admission's transaction, what any node's admission checks (admitGraphChild): the
// workspace may run, the graph still runs (its row locked, so a cancel cannot slip between), its actor may run it,
// and the owner's plan covers the workspace.
func editAdmissible(ctx context.Context, tx pgx.Tx, tid, gid string) error {
	var tenantStatus string
	var needsPlan bool
	if err := tx.QueryRow(ctx, "SELECT status,requires_plan FROM tenants WHERE id=$1 FOR UPDATE", tid).Scan(&tenantStatus, &needsPlan); err != nil {
		return err
	}
	if tenantStatus != "active" {
		return errors.New("execution_revoked")
	}
	var actor, status string
	if err := tx.QueryRow(ctx, "SELECT actor_id,status FROM graph_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, gid).Scan(&actor, &status); err != nil {
		return err
	}
	if status != "running" {
		return errors.New("graph_not_running")
	}
	var role string
	if err := tx.QueryRow(ctx, "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2", tid, actor).Scan(&role); err != nil || roleLevel(role) < 2 {
		return errors.New("execution_revoked")
	}
	owner, err := ownerPlan(ctx, tx, tid, false)
	if err != nil {
		return err
	}
	return requiresPlan(ctx, tx, tid, needsPlan, owner)
}

// admitGraphEdit starts the edit of a ready edit node: its timeline and files are resolved, it is checked as any
// node's admission is, its allowance counted, its job recorded and the node set running in one transaction, and then
// the job is dispatched. errEditWaiting leaves the node waiting for the workspace's other edit.
func (a *App) admitGraphEdit(ctx context.Context, tid, gid, canvasID string, n graphNode, d graphDocument, outputs map[string]string) error {
	if a.cfg.RenderURL == "" || a.cfg.RenderToken == "" {
		return errors.New("edit_unavailable")
	}
	// While the workspace's other edit runs, the node looks again only every editWaitPause, and without reading its
	// timeline or taking a lock (the allowance below checks again under its locks).
	key := tid + "/" + gid + "/" + n.ID
	if next, ok := a.editWaits.Load(key); ok && time.Now().Before(next.(time.Time)) {
		return errEditWaiting
	}
	var active bool
	if err := a.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM edit_jobs WHERE tenant_id=$1 AND status IN ('queued','running'))", tid).Scan(&active); err != nil {
		return err
	}
	if active {
		a.waitForEdit(key)
		return errEditWaiting
	}
	a.editWaits.Delete(key)
	text, err := editTimelineText(n, d, outputs)
	if err != nil {
		return err
	}
	timeline, names, err := parseEditTimeline(text)
	if err != nil {
		return err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if err = editAdmissible(ctx, tx, tid, gid); err != nil {
		return err
	}
	if err = a.editAllowance(ctx, tx, tid); err != nil {
		if errors.Is(err, errEditWaiting) {
			a.waitForEdit(key)
		}
		return err
	}
	files, err := editFilesFor(ctx, tx, tid, canvasID, names, editSources(n, d, outputs))
	if err != nil {
		return err
	}
	id := "ed" + strings.TrimPrefix(randomID(), "a")[:30]
	if _, err = tx.Exec(ctx, "INSERT INTO edit_jobs(id,tenant_id,canvas_id,graph_id,node_id,status,timeline,files) VALUES($1,$2,$3,$4,$5,'queued',$6,$7)",
		id, tid, canvasID, gid, n.ID, []byte(timeline), jsonBytes(files)); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, "UPDATE graph_run_nodes SET state='running',detail='' WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3 AND state='waiting'", tid, gid, n.ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return nil // the node moved meanwhile: nothing is admitted
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	a.observeGraphNodeState("running")
	a.dispatchEdit(tid, id)
	return nil
}

// waitForEdit has the node look again after editWaitPause; the pauses of nodes that stopped waiting long ago (their
// graph cancelled or ended) are dropped then.
func (a *App) waitForEdit(key string) {
	now := time.Now()
	a.editWaits.Range(func(other, next any) bool {
		if now.Sub(next.(time.Time)) > time.Minute {
			a.editWaits.Delete(other)
		}
		return true
	})
	a.editWaits.Store(key, now.Add(editWaitPause))
}

// settleGraphEdit projects a running edit node's latest job onto the node: done with its record, failed with its
// message, cancelled; a job its process no longer runs (the API restarted) is dispatched again, up to
// maxEditAttempts starts, since an edit is deterministic and charges no provider.
func (a *App) settleGraphEdit(ctx context.Context, tid, gid string, n graphNode) {
	var id, status, output, code, detail string
	var attempts int
	err := a.db.QueryRow(ctx, "SELECT id,status,output,COALESCE(error_code,''),COALESCE(error_detail,''),attempts FROM edit_jobs WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3 ORDER BY created_at DESC LIMIT 1",
		tid, gid, n.ID).Scan(&id, &status, &output, &code, &detail, &attempts)
	if noRows(err) {
		a.setGraphNode(ctx, tid, gid, n.ID, "failed", "", "interrupted")
		return
	}
	if err != nil {
		return
	}
	switch status {
	case "completed":
		a.setGraphNode(ctx, tid, gid, n.ID, "done", output, "")
	case "failed":
		a.setGraphNode(ctx, tid, gid, n.ID, "failed", "", editFailureDetail(code, detail))
	case "cancelled":
		a.setGraphNode(ctx, tid, gid, n.ID, "cancelled", "", "cancelled")
	default:
		a.mu.Lock()
		_, executing := a.running["edit:"+id]
		a.mu.Unlock()
		if executing {
			return
		}
		if attempts >= maxEditAttempts {
			a.settleEdit(tid, id, "failed", "", "interrupted", "", nil)
			return
		}
		if tag, e := a.db.Exec(ctx, "UPDATE edit_jobs SET status='queued',started_at=NULL WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running')", tid, id); e == nil && tag.RowsAffected() == 1 {
			a.dispatchEdit(tid, id)
		}
	}
}

// editFailureDetail is what a failed edit node shows: the render worker's own words for a timeline it refused (so
// the agent or the member who wrote it can fix it), else the stable code.
func editFailureDetail(code, detail string) string {
	if code == "edit_rejected" && detail != "" {
		return "edit_rejected: " + detail
	}
	return code
}

// cancelGraphEdits stops the edits of a cancelled graph run (inside its cancellation's transaction) and returns their
// ids, whose executors are stopped once it commits.
func cancelGraphEdits(ctx context.Context, tx pgx.Tx, tid, gid string) ([]string, error) {
	rows, err := tx.Query(ctx, "UPDATE edit_jobs SET status='cancelled',error_code='cancelled',timeline='{}'::jsonb,files='[]'::jsonb,finished_at=clock_timestamp() WHERE tenant_id=$1 AND graph_id=$2 AND status IN ('queued','running') RETURNING id", tid, gid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// stopEdits stops the executors of edits that were cancelled.
func (a *App) stopEdits(ids []string) {
	for _, id := range ids {
		a.mu.Lock()
		stop := a.running["edit:"+id]
		a.mu.Unlock()
		if stop != nil {
			stop()
		}
	}
}

// interruptEdits fails, at startup, the edits an earlier process left queued or running whose graph run no longer
// runs (one that still runs dispatches its edit again: settleGraphEdit).
func interruptEdits(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `UPDATE edit_jobs e SET status='failed',error_code='interrupted',timeline='{}'::jsonb,files='[]'::jsonb,finished_at=clock_timestamp() WHERE e.status IN ('queued','running')
		AND NOT EXISTS(SELECT 1 FROM graph_runs g WHERE g.tenant_id=e.tenant_id AND g.id=e.graph_id AND g.status IN ('queued','running'))`)
	return err
}

// settleEdit ends a job still queued or running, trying again after a database error (a job left running would hold its
// node until the next start). A job that ended keeps no copy of its timeline or file list: the node's own input and
// output hold them; the row stays as the allowance's ledger.
func (a *App) settleEdit(tid, id, status, output, code, detail string, result any) {
	raw := []byte(`{}`)
	if result != nil {
		raw = jsonBytes(result)
	}
	var errorCode, errorDetail any
	if code != "" {
		errorCode = code
	}
	if detail != "" {
		errorDetail = firstRunes(detail, 600)
	}
	for attempt := 1; attempt <= 3; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, err := a.db.Exec(ctx, "UPDATE edit_jobs SET status=$3,output=$4,error_code=$5,error_detail=$6,result=$7,timeline='{}'::jsonb,files='[]'::jsonb,finished_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running')",
			tid, id, status, output, errorCode, errorDetail, raw)
		cancel()
		if err == nil {
			return
		}
		a.log.Error("edit settle failed", "error_type", fmt.Sprintf("%T", err), "attempt", attempt)
		time.Sleep(time.Duration(attempt) * 500 * time.Millisecond)
	}
}
