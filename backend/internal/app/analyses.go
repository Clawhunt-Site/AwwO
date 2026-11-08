package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Video breakdown nodes (kind "analyze", 「视频拆解」; migration 057; apps/video-analysis-worker): a canvas run's analyze
// node tells how one video was made, shot by shot (filmed, generated, rendered in 3D or code, screen-recorded, a
// still), what was laid over it (subtitles and their timings, titles, stickers), how its sound was made and how a
// same-structure remake would split into generation units. The video is the one wired into its video port (a video
// node's clip or an edit's film) or, with nothing wired, the upload of this canvas its settings name. No model runs
// and no provider is paid: the analysis worker runs rea-video offline, and its report, summary, storyboard, shot
// sheets and subtitles become artifacts of the canvas. The node delivers text (analysisDelivery): the summary, the
// public report and the names of its files, which a later agent reads as context.

const (
	analysisModelID       = "awwo-analysis"
	maxAnalysisAttempts   = 3
	maxAnalysisInputBytes = 1 << 30
	// analysisAllowanceLock serializes the site-wide count of today's analyses (edits take 84321040).
	analysisAllowanceLock = 84321057
)

// analyzeSettings is an analyze node's own settings (canvasDoc.ts AnalyzeNode.analyze); every field may be absent.
type analyzeSettings struct {
	// Source is an upload of this canvas (an artifact id), analysed when no video is wired into the node.
	Source string `json:"source,omitempty"`
	// Lang is the language of the report and summary: zh (the default) or en.
	Lang string `json:"lang,omitempty"`
	// OCR reads subtitles and on-screen text (default on); OCRLang zh (default) or ja picks the recognition model.
	OCR     *bool  `json:"ocr,omitempty"`
	OCRLang string `json:"ocrLang,omitempty"`
	// Packaging reads the subtitle timeline, titles and stickers (default on; about half the analysis time).
	Packaging *bool `json:"packaging,omitempty"`
	// Stems keeps the voice and music stems as files (default off: about 10 MB a minute each).
	Stems bool `json:"stems,omitempty"`
}

var analysisSourceID = regexp.MustCompile(`^a[A-Za-z0-9_-]{8,64}$`)

// analysisOptions is what the worker takes as the job's options (apps/video-analysis-worker/config.mjs).
func analysisOptions(s *analyzeSettings) map[string]any {
	options := map[string]any{"lang": "zh", "ocr": true, "ocrLang": "zh", "packaging": true, "stems": false, "review": true}
	if s == nil {
		return options
	}
	if s.Lang != "" {
		options["lang"] = s.Lang
	}
	if s.OCR != nil {
		options["ocr"] = *s.OCR
	}
	if s.OCRLang != "" {
		options["ocrLang"] = s.OCRLang
	}
	if s.Packaging != nil {
		options["packaging"] = *s.Packaging
	}
	options["stems"] = s.Stems
	return options
}

// analysisUserError is a failure the node shows as it is: what is wrong with its video or its settings.
type analysisUserError struct{ message string }

func (e analysisUserError) Error() string { return e.message }

func analysisUserErrorf(format string, args ...any) error {
	return analysisUserError{fmt.Sprintf(format, args...)}
}

// errAnalysisWaiting: the workspace's other analysis is still queued or running; this one is admitted when it ends.
var errAnalysisWaiting = errors.New("analysis_waiting")

// analysisWaitPause is how long a node waiting for its workspace's other analysis waits before it looks again; a
// variable so tests can shorten it.
var analysisWaitPause = 3 * time.Second

var analysisAdmissionCodes = map[string]bool{"analysis_unavailable": true, "analysis_allowance": true, "execution_revoked": true, "graph_not_running": true, "plan_required": true}

// analysisAdmissionDetail is what a node whose analysis was not admitted shows: the user's error, a stable code, never
// another error's text.
func analysisAdmissionDetail(err error) string {
	var user analysisUserError
	switch {
	case errors.As(err, &user):
		return user.message
	case analysisAdmissionCodes[err.Error()]:
		return err.Error()
	case errors.Is(err, errPlanRequired):
		return "plan_required"
	}
	return "analysis_unavailable"
}

// analysisPort is an analyze node's port type: one video coming in, text going out.
func analysisPort(id string, input bool) (string, bool) {
	if !input {
		return "text", id == "result"
	}
	return mediaKindVideo, id == "video"
}

// scopeHasAnalysis reports whether a graph run would execute an analyze node.
func scopeHasAnalysis(d graphDocument, scope []string) bool {
	in := map[string]bool{}
	for _, id := range scope {
		in[id] = true
	}
	for _, n := range d.Nodes {
		if n.Kind == "analyze" && in[n.ID] {
			return true
		}
	}
	return false
}

// validateAnalyzeNode checks an in-scope analyze node as parseGraph reads it: one video, wired or its own upload, and
// options the worker takes.
func validateAnalyzeNode(n graphNode, videoSources int) error {
	if videoSources > 1 {
		return errors.New("A video breakdown node takes one video")
	}
	s := n.Analyze
	source := ""
	if s != nil {
		source = strings.TrimSpace(s.Source)
	}
	if videoSources == 0 && source == "" {
		return errors.New("A video breakdown node needs a video: wire a video node's clip or an edit's film into it, or choose an uploaded video in its settings")
	}
	if s == nil {
		return nil
	}
	if source != "" && !analysisSourceID.MatchString(source) {
		return errors.New("A video breakdown node's uploaded video is not a stored file of this canvas")
	}
	if s.Lang != "" && s.Lang != "zh" && s.Lang != "en" {
		return errors.New("A video breakdown node's language is zh or en")
	}
	if s.OCRLang != "" && s.OCRLang != "zh" && s.OCRLang != "ja" {
		return errors.New("A video breakdown node reads Chinese (zh) or Japanese (ja) text")
	}
	return nil
}

// analysisVideoFor resolves the node's video to a stored artifact of this canvas: the first video the node wired into
// its video port delivered (a generation's media-N field or an edit's film, as edits resolve theirs), else the upload
// its settings name. A record written by a model or a client cannot point the analysis at any other stored file.
func analysisVideoFor(ctx context.Context, tx pgx.Tx, tid, canvasID string, n graphNode, d graphDocument, outputs map[string]string) (editFile, error) {
	f := editFile{}
	for _, e := range d.Edges {
		if e.ToNode != n.ID || e.ToPort != "video" {
			continue
		}
		var record struct {
			Type  string      `json:"type"`
			Items []mediaItem `json:"items"`
		}
		_ = json.Unmarshal([]byte(strings.TrimSpace(outputs[e.FromNode])), &record)
		var item *mediaItem
		for i := range record.Items {
			if record.Type == mediaOutputType && strings.HasPrefix(record.Items[i].ContentType, "video/") {
				item = &record.Items[i]
				break
			}
		}
		if item == nil {
			return f, analysisUserErrorf("The node wired into this video breakdown delivered no video")
		}
		f = editFile{Name: item.Name, ArtifactID: item.ArtifactID}
		err := tx.QueryRow(ctx, `SELECT size,sha256,storage_path,content_type FROM artifacts WHERE tenant_id=$1 AND canvas_id=$2 AND id=$3 AND node_id=$4
			AND (field_id LIKE 'media-%' OR field_id='edit-film') AND storage_path IS NOT NULL AND content_type IS NOT NULL`,
			tid, canvasID, item.ArtifactID, e.FromNode).Scan(&f.Size, &f.SHA256, &f.Path, &f.ContentType)
		if noRows(err) {
			return f, analysisUserErrorf("The video %s/%s is not a stored file of the node it came from", e.FromNode, item.Name)
		}
		if err != nil {
			return f, err
		}
		return f, checkAnalysisVideo(f)
	}
	source := ""
	if n.Analyze != nil {
		source = strings.TrimSpace(n.Analyze.Source)
	}
	f.ArtifactID = source
	err := tx.QueryRow(ctx, `SELECT name,size,sha256,storage_path,content_type FROM artifacts WHERE tenant_id=$1 AND canvas_id=$2 AND id=$3 AND field_id=$4
		AND storage_path IS NOT NULL AND content_type IS NOT NULL`, tid, canvasID, source, uploadField).Scan(&f.Name, &f.Size, &f.SHA256, &f.Path, &f.ContentType)
	if noRows(err) {
		return f, analysisUserErrorf("The uploaded video this node names is no longer on this canvas: choose another in its settings")
	}
	if err != nil {
		return f, err
	}
	return f, checkAnalysisVideo(f)
}

func checkAnalysisVideo(f editFile) error {
	if !strings.HasPrefix(f.ContentType, "video/") {
		return analysisUserErrorf("%s (%s) is not a video", firstRunes(f.Name, 120), f.ContentType)
	}
	if f.Size <= 0 || f.Size > maxAnalysisInputBytes {
		return analysisUserErrorf("%s is larger than the 1 GiB a video breakdown takes", firstRunes(f.Name, 120))
	}
	return nil
}

// analysisCountedToday: the UTC day's analyses a workspace is charged for, as edits count theirs: one the platform
// failed (no worker, the worker busy, a restart, a stored file it could not read or that is not the file its record
// says, no room to keep the outputs) or one cancelled before it started is not charged.
const analysisCountedToday = "created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND NOT (status='failed' AND error_code IN " +
	"('analysis_unavailable','analysis_busy','interrupted','analysis_file_missing','analysis_file_mismatch','analysis_storage_failed','media_storage_full')) AND NOT (status='cancelled' AND started_at IS NULL)"

// analysisAllowance waits for the workspace's analysis in progress and refuses one past today's allowance (the job
// rows are the ledger); the site-wide count is taken under its own lock.
func (a *App) analysisAllowance(ctx context.Context, tx pgx.Tx, tid string) error {
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", analysisAllowanceLock); err != nil {
		return err
	}
	var active, mine, all int
	if err := tx.QueryRow(ctx, "SELECT (SELECT count(*) FROM analysis_jobs WHERE tenant_id=$1 AND status IN ('queued','running')),(SELECT count(*) FROM analysis_jobs WHERE tenant_id=$1 AND "+analysisCountedToday+"),(SELECT count(*) FROM analysis_jobs WHERE "+analysisCountedToday+")", tid).
		Scan(&active, &mine, &all); err != nil {
		return err
	}
	if active > 0 {
		return errAnalysisWaiting
	}
	perDay, sitePerDay, _, _ := a.analysisLimits()
	if mine >= perDay || all >= sitePerDay {
		return errors.New("analysis_allowance")
	}
	return nil
}

// admitGraphAnalysis starts the analysis of a ready analyze node: its video is resolved, it is checked as any node's
// admission is (editAdmissible), its allowance counted, its job recorded and the node set running in one transaction,
// and then the job is dispatched. errAnalysisWaiting leaves the node waiting for the workspace's other analysis.
func (a *App) admitGraphAnalysis(ctx context.Context, tid, gid, canvasID string, n graphNode, d graphDocument, outputs map[string]string) error {
	if a.cfg.AnalysisURL == "" || a.cfg.AnalysisToken == "" {
		return errors.New("analysis_unavailable")
	}
	key := tid + "/" + gid + "/" + n.ID
	if next, ok := a.analysisWaits.Load(key); ok && time.Now().Before(next.(time.Time)) {
		return errAnalysisWaiting
	}
	var active bool
	if err := a.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM analysis_jobs WHERE tenant_id=$1 AND status IN ('queued','running'))", tid).Scan(&active); err != nil {
		return err
	}
	if active {
		a.waitForAnalysis(key)
		return errAnalysisWaiting
	}
	a.analysisWaits.Delete(key)
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if err = editAdmissible(ctx, tx, tid, gid); err != nil {
		return err
	}
	if err = a.analysisAllowance(ctx, tx, tid); err != nil {
		if errors.Is(err, errAnalysisWaiting) {
			a.waitForAnalysis(key)
		}
		return err
	}
	video, err := analysisVideoFor(ctx, tx, tid, canvasID, n, d, outputs)
	if err != nil {
		return err
	}
	id := "an" + strings.TrimPrefix(randomID(), "a")[:30]
	if _, err = tx.Exec(ctx, "INSERT INTO analysis_jobs(id,tenant_id,canvas_id,graph_id,node_id,status,source,options) VALUES($1,$2,$3,$4,$5,'queued',$6,$7)",
		id, tid, canvasID, gid, n.ID, jsonBytes(video), jsonBytes(analysisOptions(n.Analyze))); err != nil {
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
	a.dispatchAnalysis(tid, id)
	return nil
}

// waitForAnalysis has the node look again after analysisWaitPause; pauses of nodes that stopped waiting long ago are
// dropped then.
func (a *App) waitForAnalysis(key string) {
	now := time.Now()
	a.analysisWaits.Range(func(other, next any) bool {
		if now.Sub(next.(time.Time)) > time.Minute {
			a.analysisWaits.Delete(other)
		}
		return true
	})
	a.analysisWaits.Store(key, now.Add(analysisWaitPause))
}

// settleGraphAnalysis projects a running analyze node's latest job onto the node: done with its delivery, failed with
// its message, cancelled; a job its process no longer runs (the API restarted) is dispatched again, up to
// maxAnalysisAttempts starts, since an analysis is deterministic and charges no provider.
func (a *App) settleGraphAnalysis(ctx context.Context, tid, gid string, n graphNode) {
	var id, status, output, code, detail string
	var attempts int
	err := a.db.QueryRow(ctx, "SELECT id,status,output,COALESCE(error_code,''),COALESCE(error_detail,''),attempts FROM analysis_jobs WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3 ORDER BY created_at DESC LIMIT 1",
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
		a.setGraphNode(ctx, tid, gid, n.ID, "failed", "", analysisFailureDetail(code, detail))
	case "cancelled":
		a.setGraphNode(ctx, tid, gid, n.ID, "cancelled", "", "cancelled")
	default:
		a.mu.Lock()
		_, executing := a.running["analysis:"+id]
		a.mu.Unlock()
		if executing {
			return
		}
		if attempts >= maxAnalysisAttempts {
			a.settleAnalysis(tid, id, "failed", "", "interrupted", "", nil)
			return
		}
		if tag, e := a.db.Exec(ctx, "UPDATE analysis_jobs SET status='queued',started_at=NULL WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running')", tid, id); e == nil && tag.RowsAffected() == 1 {
			a.dispatchAnalysis(tid, id)
		}
	}
}

// analysisFailureDetail is what a failed analyze node shows: the worker's own words for a video it refused (too long,
// too large, no picture), else the stable code.
func analysisFailureDetail(code, detail string) string {
	if code == "analysis_rejected" && detail != "" {
		return "analysis_rejected: " + detail
	}
	return code
}

// cancelGraphAnalyses stops the analyses of a cancelled graph run (inside its cancellation's transaction) and returns
// their ids, whose executors are stopped once it commits.
func cancelGraphAnalyses(ctx context.Context, tx pgx.Tx, tid, gid string) ([]string, error) {
	rows, err := tx.Query(ctx, "UPDATE analysis_jobs SET status='cancelled',error_code='cancelled',source='{}'::jsonb,finished_at=clock_timestamp() WHERE tenant_id=$1 AND graph_id=$2 AND status IN ('queued','running') RETURNING id", tid, gid)
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

// stopAnalyses stops the executors of analyses that were cancelled.
func (a *App) stopAnalyses(ids []string) {
	for _, id := range ids {
		a.mu.Lock()
		stop := a.running["analysis:"+id]
		a.mu.Unlock()
		if stop != nil {
			stop()
		}
	}
}

// interruptAnalyses fails, at startup, the analyses an earlier process left queued or running whose graph run no
// longer runs (one that still runs dispatches its analysis again: settleGraphAnalysis).
func interruptAnalyses(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `UPDATE analysis_jobs j SET status='failed',error_code='interrupted',source='{}'::jsonb,finished_at=clock_timestamp() WHERE j.status IN ('queued','running')
		AND NOT EXISTS(SELECT 1 FROM graph_runs g WHERE g.tenant_id=j.tenant_id AND g.id=j.graph_id AND g.status IN ('queued','running'))`)
	return err
}

// settleAnalysis ends a job still queued or running, trying again after a database error (a job left running would
// hold its node until the next start). A job that ended keeps no copy of its source file's record; the row stays as
// the allowance's ledger.
func (a *App) settleAnalysis(tid, id, status, output, code, detail string, result any) {
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
		_, err := a.db.Exec(ctx, "UPDATE analysis_jobs SET status=$3,output=$4,error_code=$5,error_detail=$6,result=$7,source='{}'::jsonb,finished_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running')",
			tid, id, status, output, errorCode, errorDetail, raw)
		cancel()
		if err == nil {
			return
		}
		a.log.Error("analysis settle failed", "error_type", fmt.Sprintf("%T", err), "attempt", attempt)
		time.Sleep(time.Duration(attempt) * 500 * time.Millisecond)
	}
}
