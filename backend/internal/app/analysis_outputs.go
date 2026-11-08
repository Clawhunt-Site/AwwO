package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// An analysis's outputs (apps/video-analysis-worker README, "Reply 200"): the report files and the summary, kept in
// the artifact row itself; the storyboard, the shot sheets, the packaging frames and the stems, kept as files in the
// job's media directory. Each becomes an artifact of the node, named as the worker names it with "/" turned into "-".

const (
	maxAnalysisOutputs = 1200
	// maxAnalysisDeliveryBytes bounds the text the node delivers to the nodes it feeds (analysisDelivery).
	maxAnalysisDeliveryBytes = 48 << 10
	maxAnalysisSummaryBytes  = 24 << 10
	maxAnalysisListedFiles   = 40
)

const analysisFile = `[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}`

// analysisOutputRules say what a worker output may be: its name, its type, whether it is kept in the row, and its cap.
var analysisOutputRules = []struct {
	name        *regexp.Regexp
	contentType string
	inline      bool
	max         int64
}{
	{regexp.MustCompile(`^breakdown\.json$`), "application/json", true, 16 << 20},
	{regexp.MustCompile(`^summary\.txt$`), "text/plain; charset=utf-8", true, 64 << 10},
	{regexp.MustCompile(`^report\.html$`), "text/html; charset=utf-8", true, 8 << 20},
	{regexp.MustCompile(`^report\.md$`), "text/markdown; charset=utf-8", true, 4 << 20},
	{regexp.MustCompile(`^review_(tasks|answers)\.json$`), "application/json", true, 8 << 20},
	{regexp.MustCompile(`^storyboard\.jpg$`), "image/jpeg", false, 32 << 20},
	{regexp.MustCompile(`^audio\.png$`), "image/png", false, 16 << 20},
	{regexp.MustCompile(`^shots/` + analysisFile + `\.jpg$`), "image/jpeg", false, 16 << 20},
	{regexp.MustCompile(`^packaging/` + analysisFile + `\.srt$`), "application/x-subrip", true, 2 << 20},
	{regexp.MustCompile(`^packaging/` + analysisFile + `\.ass$`), "text/x-ssa; charset=utf-8", true, 4 << 20},
	{regexp.MustCompile(`^packaging/` + analysisFile + `\.json$`), "application/json", true, 8 << 20},
	{regexp.MustCompile(`^packaging/` + analysisFile + `\.jpg$`), "image/jpeg", false, 16 << 20},
	{regexp.MustCompile(`^packaging/` + analysisFile + `\.png$`), "image/png", false, 16 << 20},
	{regexp.MustCompile(`^stems/(original|vocals|music)\.wav$`), "audio/wav", false, 1 << 30},
}

// analysisKept is one output read back from the worker: in memory (text) or in a file renamed into the job's media
// directory once checked.
type analysisKept struct {
	editOutput
	inline bool
	data   []byte
	final  string
}

type analysisKeptOutputs struct {
	items   []analysisKept
	written []string
	saved   bool
}

func (k *analysisKeptOutputs) discard() {
	if k == nil || k.saved {
		return
	}
	for _, path := range k.written {
		_ = os.Remove(path)
	}
}

// analysisArtifactName is an output's artifact name: the worker's name with "/" turned into "-".
func analysisArtifactName(name string) string {
	return strings.ReplaceAll(name, "/", "-")
}

// analysisField is an output's artifact field: analysis-breakdown.json, analysis-shots-shot_001.jpg…
func analysisField(name string) string {
	return "analysis-" + analysisArtifactName(name)
}

// checkAnalysisOutputs matches every output the worker reported to its rule, within its cap; the breakdown and the
// summary must be there.
func checkAnalysisOutputs(outputs []editOutput) ([]analysisKept, int64, error) {
	if len(outputs) > maxAnalysisOutputs {
		return nil, 0, analysisError{"analysis_output_invalid", "count"}
	}
	items := []analysisKept{}
	seen := map[string]bool{}
	var files int64
	breakdown := false
	for _, out := range outputs {
		matched := false
		for _, rule := range analysisOutputRules {
			if out.ContentType != rule.contentType || !rule.name.MatchString(out.Name) {
				continue
			}
			flat := analysisArtifactName(out.Name)
			if out.Size <= 0 || out.Size > rule.max || seen[flat] || len(out.SHA256) != 64 {
				return nil, 0, analysisError{"analysis_output_invalid", firstRunes(out.Name, 60)}
			}
			seen[flat], matched = true, true
			if !rule.inline {
				files += out.Size
			}
			breakdown = breakdown || out.Name == "breakdown.json"
			items = append(items, analysisKept{editOutput: out, inline: rule.inline})
			break
		}
		if !matched {
			return nil, 0, analysisError{"analysis_output_invalid", firstRunes(out.Name, 60)}
		}
	}
	if !breakdown {
		return nil, 0, analysisError{"analysis_output_invalid", "breakdown.json"}
	}
	return items, files, nil
}

// fetchAnalysisOutputs reads every output back; files go to the media scratch directory and, checked, into the job's
// own media directory under their digest.
func (a *App) fetchAnalysisOutputs(ctx context.Context, tid string, job *analysisJob, outputs []editOutput) (*analysisKeptOutputs, error) {
	kept := &analysisKeptOutputs{}
	items, total, err := checkAnalysisOutputs(outputs)
	if err != nil {
		return kept, err
	}
	release, ok := a.reserveMediaSpace(total)
	if !ok {
		return kept, analysisError{"media_storage_full", ""}
	}
	defer release()
	for i := range items {
		if err = a.fetchAnalysisOutput(ctx, tid, job.ID, &items[i], kept); err != nil {
			return kept, err
		}
	}
	kept.items = items
	return kept, nil
}

func (a *App) fetchAnalysisOutput(ctx context.Context, tid, jobID string, item *analysisKept, kept *analysisKeptOutputs) error {
	resp, err := a.analysisCall(ctx, http.MethodGet, "/"+jobID+"/outputs/"+item.Name, nil, 0, "")
	if err != nil {
		return analysisError{"analysis_unavailable", ""}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return analysisWorkerError(resp.StatusCode, raw)
	}
	body := io.LimitReader(resp.Body, item.Size+1)
	if item.inline {
		data, err := io.ReadAll(body)
		if err != nil || int64(len(data)) != item.Size || sha256Hex(data) != item.SHA256 {
			return analysisError{"analysis_output_invalid", item.Name}
		}
		item.data = data
		return nil
	}
	return a.keepAnalysisFile(tid, jobID, item, body, kept)
}

// keepAnalysisFile streams a picture or a stem to a scratch file, checks it (size, digest, and that its bytes are the
// type the worker named), and renames it to <tid>/<job>/<sha256>.<ext>.
func (a *App) keepAnalysisFile(tid, jobID string, item *analysisKept, body io.Reader, kept *analysisKeptOutputs) error {
	scratch := filepath.Join(a.cfg.MediaDir, ".tmp")
	if os.MkdirAll(scratch, 0o750) != nil {
		return analysisError{"analysis_storage_failed", ""}
	}
	file, err := os.CreateTemp(scratch, "download-analysis-*")
	if err != nil {
		return analysisError{"analysis_storage_failed", ""}
	}
	temp := file.Name()
	defer os.Remove(temp)
	hash := sha256.New()
	head := &headWriter{limit: 64}
	written, err := io.Copy(io.MultiWriter(file, hash, head), body)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil || written != item.Size || hex.EncodeToString(hash.Sum(nil)) != item.SHA256 {
		return analysisError{"analysis_output_invalid", item.Name}
	}
	ext := strings.TrimPrefix(filepath.Ext(item.Name), ".")
	if contentType, sniffed, _ := sniffMedia(head.data); contentType != item.ContentType || sniffed != ext {
		return analysisError{"analysis_output_invalid", item.Name}
	}
	final := filepath.Join(a.cfg.MediaDir, tid, jobID, item.SHA256+"."+ext)
	if os.MkdirAll(filepath.Dir(final), 0o750) != nil {
		return analysisError{"analysis_storage_failed", ""}
	}
	kept.written = append(kept.written, final)
	if os.Chmod(temp, 0o640) != nil || os.Rename(temp, final) != nil {
		return analysisError{"analysis_storage_failed", ""}
	}
	item.final = tid + "/" + jobID + "/" + item.SHA256 + "." + ext
	return nil
}

// analysisPublicReport is the part of the worker's report the job row and the delivery keep.
type analysisPublicReport struct {
	Schema string `json:"schema"`
	Tool   struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"tool"`
	Lang  string `json:"lang"`
	Video struct {
		Seconds float64 `json:"seconds"`
		Width   int     `json:"width"`
		Height  int     `json:"height"`
		FPS     float64 `json:"fps"`
		Aspect  string  `json:"aspect"`
		Sound   bool    `json:"sound"`
	} `json:"video"`
	Verdict            string   `json:"verdict"`
	Shots              int      `json:"shots"`
	Confidence         float64  `json:"confidence"`
	AverageShotSeconds float64  `json:"averageShotSeconds"`
	Production         string   `json:"production"`
	VLM                string   `json:"vlm"`
	Warnings           []string `json:"warnings"`
}

func readAnalysisReport(raw json.RawMessage) analysisPublicReport {
	var report analysisPublicReport
	_ = json.Unmarshal(raw, &report)
	report.Verdict = firstRunes(report.Verdict, 2000)
	report.Production = firstRunes(report.Production, 600)
	if len(report.Warnings) > 20 {
		report.Warnings = report.Warnings[:20]
	}
	report.Warnings = nonNil(report.Warnings)
	return report
}

// cutUTF8 is text cut to at most max bytes on a character boundary, at the last line break in its second half when
// there is one.
func cutUTF8(text string, max int) (string, bool) {
	if len(text) <= max {
		return text, false
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	out := text[:cut]
	if i := strings.LastIndexByte(out, '\n'); i > max/2 {
		out = out[:i]
	}
	return out, true
}

// analysisDelivery is the text the node delivers: what was analysed, the summary, the public report and the files a
// later node may name as <node id>/<file name>. It never holds a path on any disk.
func analysisDelivery(job *analysisJob, report analysisPublicReport, summary string, items []analysisKept) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Video breakdown of %s", analysisDisplayName(job.Source.Name))
	if report.Video.Seconds > 0 {
		fmt.Fprintf(&b, " (%.1f s, %dx%d, %d shots)", report.Video.Seconds, report.Video.Width, report.Video.Height, report.Shots)
	}
	b.WriteString(". Measured from the file without a model: where it says unconfirmed, look at the shot sheets before relying on it.\n\n")
	if text, cut := cutUTF8(strings.TrimSpace(summary), maxAnalysisSummaryBytes); text != "" {
		b.WriteString(text)
		if cut {
			b.WriteString("\n(summary cut here; the whole of it is in summary.txt)")
		}
		b.WriteString("\n\n")
	} else if report.Verdict != "" {
		b.WriteString(report.Verdict + "\n\n")
	}
	if raw, err := json.Marshal(report); err == nil {
		b.WriteString("Report: ")
		b.Write(raw)
		b.WriteString("\n\n")
	}
	names := []string{}
	for _, item := range items {
		names = append(names, job.NodeID+"/"+analysisArtifactName(item.Name))
	}
	listed := names
	if len(listed) > maxAnalysisListedFiles {
		listed = listed[:maxAnalysisListedFiles]
	}
	fmt.Fprintf(&b, "Files (%d): %s", len(names), strings.Join(listed, ", "))
	if len(names) > len(listed) {
		fmt.Fprintf(&b, " and %d more", len(names)-len(listed))
	}
	text, _ := cutUTF8(b.String(), maxAnalysisDeliveryBytes)
	return text
}

// analysisResult is what the job row keeps of a completed analysis: the public report and its files.
func analysisResult(tid string, job *analysisJob, report analysisPublicReport, items []analysisKept) map[string]any {
	files := []map[string]any{}
	for _, item := range items {
		files = append(files, map[string]any{"artifactId": artifactID(tid, job.ID, job.NodeID, analysisField(item.Name)), "name": analysisArtifactName(item.Name),
			"contentType": item.ContentType, "size": item.Size})
	}
	return map[string]any{"model": analysisModelID, "report": report, "files": files}
}

// saveAnalysis keeps the outputs as artifacts and completes the job in one transaction (a job cancelled meanwhile
// keeps nothing); files of a transaction that does not commit are removed by discard or, unreferenced, by the sweep.
func (a *App) saveAnalysis(ctx context.Context, tid string, job *analysisJob, reply *analysisReply, kept *analysisKeptOutputs) error {
	report := readAnalysisReport(reply.Report)
	summary := ""
	if reply.Summary != nil {
		summary = *reply.Summary
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancel()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return analysisError{"analysis_storage_failed", ""}
	}
	defer tx.Rollback(context.Background())
	for _, item := range kept.items {
		var content []byte
		var path any
		if item.final != "" {
			content, path = []byte{}, item.final
		} else {
			content = item.data
		}
		field := analysisField(item.Name)
		if _, err = tx.Exec(ctx, `INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content,storage_path,content_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
			ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,size=EXCLUDED.size,sha256=EXCLUDED.sha256,content=EXCLUDED.content,storage_path=EXCLUDED.storage_path,content_type=EXCLUDED.content_type`,
			artifactID(tid, job.ID, job.NodeID, field), tid, job.CanvasID, job.ID, job.NodeID, field, analysisArtifactName(item.Name), item.Size, item.SHA256, content, path, item.ContentType); err != nil {
			return analysisError{"analysis_storage_failed", ""}
		}
	}
	output := analysisDelivery(job, report, summary, kept.items)
	tag, err := tx.Exec(ctx, "UPDATE analysis_jobs SET status='completed',output=$3,result=$4,error_code=NULL,error_detail=NULL,source='{}'::jsonb,finished_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='running'",
		tid, job.ID, output, jsonBytes(analysisResult(tid, job, report, kept.items)))
	if err != nil {
		return analysisError{"analysis_storage_failed", ""}
	}
	if tag.RowsAffected() != 1 {
		return analysisError{"cancelled", ""}
	}
	kept.saved = true
	if err = tx.Commit(ctx); err != nil {
		return analysisError{"analysis_storage_failed", ""}
	}
	return nil
}
