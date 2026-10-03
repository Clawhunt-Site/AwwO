package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Generated media on disk: downloading and storing results, serving them inline and as
// downloads, and sweeping files no artifact references any more. Paths are built only from
// server-generated identifiers and validated again on every read.

// storeMediaResults downloads each result into AWWO_MEDIA_DIR/<tenant>/<run>/<sha256>.<ext> and
// records it as an artifact of the run's canvas node. A file whose bytes are not an image (for an
// image node) or a video (for a video node) is refused, whatever the provider called it.
func (a *App) storeMediaResults(ctx context.Context, hub *runningHub, tid, id, sid string, m *mediaModel, results []rhResult) (string, error) {
	if len(results) == 0 {
		return "", &rhError{Code: "media_no_output"}
	}
	if !mediaPathPart.MatchString(tid) || !mediaPathPart.MatchString(id) {
		return "", &rhError{Code: "media_storage_failed"}
	}
	var canvasID, nodeID string
	if e := a.db.QueryRow(ctx, "SELECT canvas_id,node_id FROM node_sessions WHERE tenant_id=$1 AND id=$2", tid, sid).Scan(&canvasID, &nodeID); e != nil {
		return "", &rhError{Code: "media_storage_failed"}
	}
	dir := filepath.Join(a.cfg.MediaDir, tid, id)
	tmp := filepath.Join(a.cfg.MediaDir, ".tmp")
	if os.MkdirAll(dir, 0o750) != nil || os.MkdirAll(tmp, 0o750) != nil {
		return "", &rhError{Code: "media_storage_failed"}
	}
	items := []mediaItem{}
	for i, result := range results {
		release, ok := a.reserveMediaSpace(hub.maxFile)
		if !ok {
			return "", &rhError{Code: "media_storage_full"}
		}
		item, err := a.storeMediaResult(ctx, hub, tmp, tid, id, canvasID, nodeID, m, i+1, result)
		release()
		if err != nil {
			return "", err
		}
		items = append(items, item)
	}
	output, _ := json.Marshal(map[string]any{"type": mediaOutputType, "version": 1, "kind": m.Kind, "model": m.ID, "items": items})
	return string(output), nil
}

func (a *App) storeMediaResult(ctx context.Context, hub *runningHub, tmp, tid, id, canvasID, nodeID string, m *mediaModel, index int, result rhResult) (mediaItem, error) {
	file, err := os.CreateTemp(tmp, "download-*")
	if err != nil {
		return mediaItem{}, &rhError{Code: "media_storage_failed"}
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.Remove(file.Name())
		}
	}()
	hash := sha256.New()
	head := &headBuffer{limit: 64}
	size, err := hub.download(ctx, result.URL, io.MultiWriter(file, hash, head))
	if closeErr := file.Close(); err == nil && closeErr != nil {
		err = &rhError{Code: "media_storage_failed"}
	}
	if err != nil {
		return mediaItem{}, err
	}
	contentType, ext, kind := sniffMedia(head.Bytes())
	if kind != m.Kind || size == 0 {
		return mediaItem{}, &rhError{Code: "media_result_invalid"}
	}
	sum := hex.EncodeToString(hash.Sum(nil))
	rel := tid + "/" + id + "/" + sum + "." + ext
	final := filepath.Join(a.cfg.MediaDir, tid, id, sum+"."+ext)
	if os.MkdirAll(filepath.Dir(final), 0o750) != nil || os.Rename(file.Name(), final) != nil {
		// An old empty run directory can be swept between the two calls; recreate it once.
		if os.MkdirAll(filepath.Dir(final), 0o750) != nil || os.Rename(file.Name(), final) != nil {
			return mediaItem{}, &rhError{Code: "media_storage_failed"}
		}
	}
	keep = true
	_ = os.Chmod(final, 0o640)
	field := fmt.Sprintf("media-%d", index)
	item := mediaItem{ArtifactID: artifactID(tid, id, nodeID, field), Name: fmt.Sprintf("%s-%d.%s", m.Kind, index, ext), ContentType: contentType, Size: size}
	insert, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if _, e := a.db.Exec(insert, `INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content,storage_path,content_type)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,''::bytea,$10,$11)
		ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,size=EXCLUDED.size,sha256=EXCLUDED.sha256,content=EXCLUDED.content,storage_path=EXCLUDED.storage_path,content_type=EXCLUDED.content_type`,
		item.ArtifactID, tid, canvasID, id, nodeID, field, item.Name, size, sum, rel, contentType); e != nil {
		return mediaItem{}, &rhError{Code: "media_storage_failed"}
	}
	return item, nil
}

// headBuffer keeps the first bytes written through it, for content sniffing.
type headBuffer struct {
	limit int
	buf   bytes.Buffer
}

func (h *headBuffer) Write(p []byte) (int, error) {
	if room := h.limit - h.buf.Len(); room > 0 {
		if len(p) < room {
			room = len(p)
		}
		h.buf.Write(p[:room])
	}
	return len(p), nil
}
func (h *headBuffer) Bytes() []byte { return h.buf.Bytes() }

// sniffMedia identifies the closed set of image and video formats a media node stores.
func sniffMedia(head []byte) (contentType, ext, kind string) {
	switch {
	case bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png", "png", mediaKindImage
	case len(head) >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF:
		return "image/jpeg", "jpg", mediaKindImage
	case len(head) >= 12 && bytes.Equal(head[0:4], []byte("RIFF")) && bytes.Equal(head[8:12], []byte("WEBP")):
		return "image/webp", "webp", mediaKindImage
	case bytes.HasPrefix(head, []byte("GIF87a")) || bytes.HasPrefix(head, []byte("GIF89a")):
		return "image/gif", "gif", mediaKindImage
	case len(head) >= 12 && bytes.Equal(head[4:8], []byte("ftyp")):
		if bytes.Equal(head[8:12], []byte("qt  ")) {
			return "video/quicktime", "mov", mediaKindVideo
		}
		return "video/mp4", "mp4", mediaKindVideo
	case bytes.HasPrefix(head, []byte{0x1A, 0x45, 0xDF, 0xA3}):
		return "video/webm", "webm", mediaKindVideo
	}
	return "", "", ""
}

var inlineMediaTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true, "image/gif": true, "video/mp4": true, "video/webm": true, "video/quicktime": true}

// mediaFile resolves a stored relative path inside AWWO_MEDIA_DIR, refusing anything that is not
// exactly <tenant>/<run>/<sha256>.<ext> for this tenant.
func (a *App) mediaFile(tid, rel string) (string, bool) {
	parts := strings.Split(rel, "/")
	if a.cfg.MediaDir == "" || len(parts) != 3 || parts[0] != tid || !mediaPathPart.MatchString(parts[0]) || !mediaPathPart.MatchString(parts[1]) || !mediaFileName.MatchString(parts[2]) {
		return "", false
	}
	return filepath.Join(a.cfg.MediaDir, parts[0], parts[1], parts[2]), true
}

// mediaArtifact serves a generated image or video inline for <img> and <video>, with range
// requests for seeking. Only files the API itself sniffed and stored are served, only with their
// recorded type, and under a sandboxing CSP.
func (a *App) mediaArtifact(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	r = r.WithContext(ctx)
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	var name, rel, contentType string
	var size int64
	e := a.db.QueryRow(ctx, "SELECT name,size,storage_path,content_type FROM artifacts WHERE tenant_id=$1 AND id=$2 AND storage_path IS NOT NULL AND content_type IS NOT NULL", tid, id).Scan(&name, &size, &rel, &contentType)
	if noRows(e) {
		fail(w, 404, "not_found", "File not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	path, ok := a.mediaFile(tid, rel)
	if !ok || !inlineMediaTypes[contentType] {
		fail(w, 404, "not_found", "File not found")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		fail(w, 404, "not_found", "File not found")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != size {
		fail(w, 404, "not_found", "File not found")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", strings.Replace(contentDisposition(name), "attachment", "inline", 1))
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	http.ServeContent(w, r, "", info.ModTime(), file)
}

// downloadStoredMedia answers the regular artifact download for a file kept on disk.
func (a *App) downloadStoredMedia(w http.ResponseWriter, r *http.Request, tid, name, rel string, size int64) {
	path, ok := a.mediaFile(tid, rel)
	if !ok {
		fail(w, 404, "not_found", "File not found")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		fail(w, 404, "not_found", "File not found")
		return
	}
	defer file.Close()
	if info, err := file.Stat(); err != nil || !info.Mode().IsRegular() || info.Size() != size {
		fail(w, 404, "not_found", "File not found")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", contentDisposition(name))
	w.Header().Set("Content-Length", fmt.Sprint(size))
	w.WriteHeader(200)
	_, _ = io.Copy(w, file)
}

// sweepMedia removes stored files that no artifact references any more (their canvas or
// workspace was deleted, which cascades the rows) and abandoned downloads. Only files the API
// names itself are touched, and only after they are an hour old, so a file renamed into place
// moments before its artifact row commits is never taken.
func (a *App) sweepMedia(ctx context.Context) {
	root := a.cfg.MediaDir
	now := time.Now()
	old := func(info os.FileInfo) bool { return now.Sub(info.ModTime()) > mediaSweepMinAge }
	if entries, err := os.ReadDir(filepath.Join(root, ".tmp")); err == nil {
		for _, entry := range entries {
			if info, err := entry.Info(); err == nil && info.Mode().IsRegular() && strings.HasPrefix(entry.Name(), "download-") && now.Sub(info.ModTime()) > 6*time.Hour {
				_ = os.Remove(filepath.Join(root, ".tmp", entry.Name()))
			}
		}
	}
	tenants, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, tenant := range tenants {
		if ctx.Err() != nil {
			return
		}
		if tenant.IsDir() && mediaPathPart.MatchString(tenant.Name()) {
			a.sweepMediaTenant(ctx, root, tenant.Name(), old)
		}
	}
}

// sweepMediaTenant reads the tenant's referenced paths once, then walks its run directories.
func (a *App) sweepMediaTenant(ctx context.Context, root, tid string, old func(os.FileInfo) bool) {
	runs, err := os.ReadDir(filepath.Join(root, tid))
	if err != nil {
		return
	}
	referenced := map[string]bool{}
	rows, err := a.db.Query(ctx, "SELECT storage_path FROM artifacts WHERE tenant_id=$1 AND storage_path IS NOT NULL UNION ALL SELECT id FROM runs WHERE tenant_id=$1 AND status IN ('queued','running')", tid)
	if err != nil {
		return
	}
	for rows.Next() {
		var rel string
		if rows.Scan(&rel) == nil {
			referenced[rel] = true
		}
	}
	rows.Close()
	if rows.Err() != nil {
		return
	}
	for _, run := range runs {
		// An active run (listed by its bare id) may still be writing into its directory.
		if !run.IsDir() || !mediaPathPart.MatchString(run.Name()) || referenced[run.Name()] {
			continue
		}
		dir := filepath.Join(root, tid, run.Name())
		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, file := range files {
			info, err := file.Info()
			if err != nil || !info.Mode().IsRegular() || !mediaFileName.MatchString(file.Name()) || !old(info) {
				continue
			}
			if !referenced[tid+"/"+run.Name()+"/"+file.Name()] {
				_ = os.Remove(filepath.Join(dir, file.Name()))
			}
		}
		if left, err := os.ReadDir(dir); err == nil && len(left) == 0 {
			if info, err := os.Stat(dir); err == nil && old(info) {
				_ = os.Remove(dir)
			}
		}
	}
}

func (a *App) startMediaSweeper(ctx context.Context) {
	if !a.cfg.mediaConfigured() {
		return
	}
	a.tasks.Add(1)
	go func() {
		defer a.tasks.Done()
		timer := time.NewTimer(time.Minute)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				a.sweepMedia(ctx)
				timer.Reset(mediaSweepInterval)
			}
		}
	}()
}
