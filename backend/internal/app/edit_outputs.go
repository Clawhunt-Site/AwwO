package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// An edit's outputs: each read back from the worker and checked against the size and digest the worker reported and
// its own bytes (the film must be an MP4, a still a JPEG), then kept as artifacts of the canvas with the job's
// completion in one transaction, like a render's (saveRender).

const maxEditStills = 150

// checkEditOutputs matches every output the worker reported to its rule: one film, at most 150 stills, within caps.
func (a *App) checkEditOutputs(outputs []editOutput) ([]keptOutput, int64, error) {
	filmCap := a.cfg.MediaMaxFileBytes
	if filmCap <= 0 {
		filmCap = 300 << 20
	}
	items := []keptOutput{}
	seen := map[string]bool{}
	films, stills := 0, 0
	var total int64
	for _, out := range outputs {
		matched := false
		for _, rule := range editOutputRules {
			if out.Kind != rule.kind || out.ContentType != rule.contentType || !rule.name.MatchString(out.Name) {
				continue
			}
			limit := rule.max
			if rule.role == "film" {
				limit, films = filmCap, films+1
			}
			if rule.role == "still" {
				stills++
			}
			if out.Size <= 0 || out.Size > limit || seen[out.Name] || len(out.SHA256) != 64 {
				return nil, 0, editError{"edit_output_invalid", out.Name}
			}
			seen[out.Name], matched = true, true
			total += out.Size
			items = append(items, keptOutput{editOutput: out, role: rule.role})
		}
		if !matched {
			return nil, 0, editError{"edit_output_invalid", firstRunes(out.Name, 60)}
		}
	}
	if films != 1 || stills > maxEditStills {
		return nil, 0, editError{"edit_output_invalid", "film"}
	}
	return items, total, nil
}

// fetchEditOutputs reads every output back; files go to the media scratch directory and, checked, into the job's own
// media directory under their digest.
func (a *App) fetchEditOutputs(ctx context.Context, tid string, job *editJob, outputs []editOutput) (*keptOutputs, error) {
	kept := &keptOutputs{}
	items, total, err := a.checkEditOutputs(outputs)
	if err != nil {
		return kept, err
	}
	release, ok := a.reserveMediaSpace(total)
	if !ok {
		return kept, editError{"media_storage_full", ""}
	}
	defer release()
	for i := range items {
		if err = a.fetchEditOutput(ctx, tid, job.ID, &items[i], kept); err != nil {
			return kept, err
		}
	}
	kept.items = items
	return kept, nil
}

func (a *App) fetchEditOutput(ctx context.Context, tid, jobID string, item *keptOutput, kept *keptOutputs) error {
	resp, err := a.editCall(ctx, http.MethodGet, "/"+jobID+"/outputs/"+item.Name, nil, 0, "")
	if err != nil {
		return editError{"edit_unavailable", ""}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return editWorkerError(resp.StatusCode, raw)
	}
	body := io.LimitReader(resp.Body, item.Size+1)
	if item.role == "subtitles" || item.role == "report" {
		data, err := io.ReadAll(body)
		if err != nil || int64(len(data)) != item.Size || sha256Hex(data) != item.SHA256 {
			return editError{"edit_output_invalid", item.Name}
		}
		item.data = data
		return nil
	}
	return a.keepEditFile(tid, jobID, item, body, kept)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// keepEditFile streams a film or a still to a scratch file, checks it, and renames it to <tid>/<job>/<sha256>.<ext>.
func (a *App) keepEditFile(tid, jobID string, item *keptOutput, body io.Reader, kept *keptOutputs) error {
	scratch := filepath.Join(a.cfg.MediaDir, ".tmp")
	if os.MkdirAll(scratch, 0o750) != nil {
		return editError{"edit_storage_failed", ""}
	}
	file, err := os.CreateTemp(scratch, "download-edit-*")
	if err != nil {
		return editError{"edit_storage_failed", ""}
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
		return editError{"edit_output_invalid", item.Name}
	}
	ext := "mp4"
	if item.role == "still" {
		ext = "jpg"
	}
	if contentType, sniffed, _ := sniffMedia(head.data); contentType != item.ContentType || sniffed != ext {
		return editError{"edit_output_invalid", item.Name}
	}
	final := filepath.Join(a.cfg.MediaDir, tid, jobID, item.SHA256+"."+ext)
	if os.MkdirAll(filepath.Dir(final), 0o750) != nil {
		return editError{"edit_storage_failed", ""}
	}
	kept.written = append(kept.written, final)
	// Readable by the group like every stored media file (the scratch file was made private).
	if os.Chmod(temp, 0o640) != nil || os.Rename(temp, final) != nil {
		return editError{"edit_storage_failed", ""}
	}
	item.final = tid + "/" + jobID + "/" + item.SHA256 + "." + ext
	return nil
}

// headWriter keeps the first bytes written to it (for sniffMedia).
type headWriter struct {
	limit int
	data  []byte
}

func (h *headWriter) Write(p []byte) (int, error) {
	if room := h.limit - len(h.data); room > 0 {
		h.data = append(h.data, p[:min(room, len(p))]...)
	}
	return len(p), nil
}

// editField is an output's artifact field: edit-film, edit-subtitles, edit-report, edit-still-001…
func editField(item keptOutput) string {
	if item.role == "still" {
		return "edit-" + strings.TrimSuffix(item.Name, ".jpg")
	}
	return "edit-" + item.role
}

// editRecord is the node's delivery: an awwo.media record of kind video naming the film, with the edit's facts and its
// other files (subtitles, report, stills) beside it.
func editRecord(tid string, job *editJob, items []keptOutput, report json.RawMessage) string {
	var facts struct {
		Seconds  float64         `json:"seconds"`
		Frames   int             `json:"frames"`
		FPS      int             `json:"fps"`
		Width    int             `json:"width"`
		Height   int             `json:"height"`
		Loudness json.RawMessage `json:"loudness"`
		Warnings []string        `json:"warnings"`
	}
	_ = json.Unmarshal(report, &facts)
	if len(facts.Warnings) > 40 {
		facts.Warnings = facts.Warnings[:40]
	}
	film := []mediaItem{}
	files := []map[string]any{}
	for _, item := range items {
		id := artifactID(tid, job.ID, job.NodeID, editField(item))
		if item.role == "film" {
			film = append(film, mediaItem{ArtifactID: id, Name: item.Name, ContentType: item.ContentType, Size: item.Size})
			continue
		}
		files = append(files, map[string]any{"artifactId": id, "name": item.Name, "contentType": item.ContentType, "size": item.Size, "role": item.role})
	}
	edit := map[string]any{"seconds": facts.Seconds, "frames": facts.Frames, "fps": facts.FPS, "width": facts.Width, "height": facts.Height,
		"loudness": facts.Loudness, "warnings": nonNil(facts.Warnings), "files": files}
	output, _ := json.Marshal(map[string]any{"type": mediaOutputType, "version": 1, "kind": mediaKindVideo, "model": editModelID, "items": film, "edit": edit})
	return string(output)
}

// saveEdit keeps the outputs as artifacts and completes the job in one transaction (a job cancelled meanwhile keeps
// nothing); files of a transaction that does not commit are removed by keptOutputs.discard or, unreferenced, by the
// media sweep.
func (a *App) saveEdit(ctx context.Context, tid string, job *editJob, report json.RawMessage, kept *keptOutputs) error {
	if !json.Valid(report) || len(report) > 1<<20 {
		report = json.RawMessage(`{}`)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancel()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return editError{"edit_storage_failed", ""}
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
		if _, err = tx.Exec(ctx, `INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content,storage_path,content_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
			ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,size=EXCLUDED.size,sha256=EXCLUDED.sha256,content=EXCLUDED.content,storage_path=EXCLUDED.storage_path,content_type=EXCLUDED.content_type`,
			artifactID(tid, job.ID, job.NodeID, editField(item)), tid, job.CanvasID, job.ID, job.NodeID, editField(item), item.Name, item.Size, item.SHA256, content, path, item.ContentType); err != nil {
			return editError{"edit_storage_failed", ""}
		}
	}
	record := editRecord(tid, job, kept.items, report)
	// Like every job that ended (settleEdit), a completed one keeps no copy of its timeline or file list.
	tag, err := tx.Exec(ctx, "UPDATE edit_jobs SET status='completed',output=$3,result=$4,error_code=NULL,error_detail=NULL,timeline='{}'::jsonb,files='[]'::jsonb,finished_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='running'",
		tid, job.ID, record, []byte(report))
	if err != nil {
		return editError{"edit_storage_failed", ""}
	}
	if tag.RowsAffected() != 1 {
		return editError{"cancelled", ""}
	}
	// From here the files stay whatever COMMIT answers (a commit whose reply was lost may have succeeded).
	kept.saved = true
	if err = tx.Commit(ctx); err != nil {
		return editError{"edit_storage_failed", ""}
	}
	return nil
}
