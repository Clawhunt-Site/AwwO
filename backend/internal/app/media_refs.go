package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"mime/multipart"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

// Reference pictures for media generations (owner request 2026-10-12: 做媒体组件的参考图生成). A model whose catalog
// entry takes references (mediaModel.References) generates from the first picture the message names: one the user
// attached in the composer, or, in a canvas run, the picture an upstream image node delivered into the node's
// reference input. Image nodes edit it (X-tasy img2img), 3D nodes build a model from it (Tripo image-to-model).
//
// The picture is chosen when the run is admitted and frozen with it (its stored path, size and SHA-256); when the
// generation starts, it is read back, checked against that digest and uploaded to the provider that runs the node's
// model, for that one task. Only this canvas's uploads and this canvas's generated pictures can be references:
// nothing is fetched from anywhere else, and the bytes go to no one but that provider, or the backup's provider when
// the generation moves to its backup (media_fallback.go). An upload creates no charge,
// so one that fails for a passing reason is tried again, and a run that fails before its task exists is not billed.

const (
	// Tripo and X-tasy both take reference pictures of up to 20 MB.
	maxMediaReferenceBytes = 20 << 20
	referenceUploadTries   = 3
	// One upload, including X-tasy's preparation of the file, is bounded by this; the run's deadline bounds them all.
	referenceUploadTimeout = 3 * time.Minute
)

// mediaReference is one picture a generation starts from, frozen at admission.
type mediaReference struct {
	ArtifactID  string `json:"artifactId"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	Path        string `json:"path"`
}

// mediaReferenceTypes are the picture types each provider takes as a reference.
var mediaReferenceTypes = map[string]map[string]bool{
	mediaProviderTripo: {"image/png": true, "image/jpeg": true},
	mediaProviderXtasy: {"image/png": true, "image/jpeg": true, "image/webp": true},
	// Jimeng's canvas registers an uploaded picture by its extension; these are the picture types it reads.
	mediaProviderJimeng: {"image/png": true, "image/jpeg": true, "image/webp": true},
	// RunningHub's multimodal video reads JPEG, PNG and WebP pictures (runningHubReferenceField).
	mediaProviderRunningHub: {"image/png": true, "image/jpeg": true, "image/webp": true},
}

// mediaAudioReferenceTypes are the voice types each provider takes (M-1c): RunningHub's multimodal video reads MP3 and
// WAV (runningHubAudioField).
var mediaAudioReferenceTypes = map[string]map[string]bool{
	mediaProviderRunningHub: {"audio/mpeg": true, "audio/wav": true, "audio/x-wav": true},
}

// errVoiceReferenceUnusable refuses a generation whose voice cannot be used: wired into a video whose model takes none
// (wiredVoicesUsable), one more than the model takes, of a type, size or length it does not read (media_voice_length.go),
// without its stored file, or without any picture beside it (RunningHub reads a voice only beside a picture). Leaving
// the voice out would make a speaking shot without its line. Its own code, so the reader is not told a picture failed
// (media_reference_unavailable).
var errVoiceReferenceUnusable = setupError{"media_voice_unavailable",
	"A voice for this video can be used only by Video · From references: up to 3 MP3 or WAV files of this canvas, each 2 to 15 seconds (15 seconds in all) and up to 10 MB, beside at least one picture"}

// mediaReferenceLimits are the providers whose uploads take less than maxMediaReferenceBytes: a larger picture is left
// out when the run is admitted, as one of another type is, instead of failing the run at its upload.
var mediaReferenceLimits = map[string]int64{mediaProviderRunningHub: rhMaxReferenceBytes}

// mediaReferenceLimit is the largest picture provider takes as a reference.
func mediaReferenceLimit(provider string) int64 {
	if limit := mediaReferenceLimits[provider]; limit > 0 {
		return limit
	}
	return maxMediaReferenceBytes
}

// referenceUploader is a provider that takes reference pictures: it returns the id its generation request names.
type referenceUploader interface {
	uploadReference(ctx context.Context, ref mediaReference, data []byte, runID string) (string, error)
}

// subjectReferenceModel reports a model whose every picture is a subject reference its words call by number (@Image 1,
// @Image 2): RunningHub's models that name a field for their pictures (runningHubReferenceField).
func subjectReferenceModel(m *mediaModel) bool {
	return m != nil && m.Provider == mediaProviderRunningHub && runningHubReferenceField[m.ID] != ""
}

// errSubjectReferenceUnusable refuses a subject-reference generation one of whose pictures cannot be used: leaving it
// out would give every later picture another number, and the words would name the wrong subjects.
var errSubjectReferenceUnusable = setupError{"media_reference_unavailable",
	"Every picture this video is made from must be a PNG, JPEG or WebP of this canvas, up to 10 MB: one is not, and leaving it out would renumber the rest"}

// freezeMediaReferences picks the pictures a generation of model m starts from: the first ones the text names, up
// to the model's limit, that are this canvas's uploads or generated media of a type the provider takes. Anything
// else the text names (another canvas's file, a document, a deleted upload, a picture too large) is left out, except
// for a subject-reference model, which refuses the generation instead (errSubjectReferenceUnusable). Voices the text
// names to a model that takes them (M-1c) are counted apart, up to its own count of them; one it cannot use, or any
// when no picture is frozen beside them, refuses the generation (errVoiceReferenceUnusable). The pictures and voices
// keep the text's order, each kind numbered on its own. To any other model an audio file is not a picture, and is left
// out as before (a voice WIRED into a video whose model takes none is refused by the canvas run: wiredVoicesUsable).
func (a *App) freezeMediaReferences(ctx context.Context, q querier, tid, canvasID, text string, m *mediaModel) ([]mediaReference, error) {
	if m == nil || m.References <= 0 || canvasID == "" {
		return nil, nil
	}
	numbered := subjectReferenceModel(m)
	types, voiceTypes := mediaReferenceTypes[m.Provider], mediaAudioReferenceTypes[m.Provider]
	limit := mediaReferenceLimit(m.Provider)
	refs := []mediaReference{}
	pictures, voices := 0, 0
	var spoken float64
	for _, id := range uploadReferences(text) {
		ref := mediaReference{ArtifactID: id}
		var rel, contentType *string
		e := q.QueryRow(ctx, "SELECT name,size,sha256,storage_path,content_type FROM artifacts WHERE tenant_id=$1 AND canvas_id=$2 AND id=$3 AND (field_id=$4 OR field_id LIKE 'media-%')",
			tid, canvasID, id, uploadField).Scan(&ref.Name, &ref.Size, &ref.SHA256, &rel, &contentType)
		if noRows(e) {
			// Past the model's pictures a missing file renumbers none of them, and is left out as before.
			if numbered && pictures < m.References {
				return nil, errSubjectReferenceUnusable
			}
			continue
		}
		if e != nil {
			return nil, e
		}
		if contentType != nil && strings.HasPrefix(*contentType, "audio/") && m.AudioReferences > 0 {
			// One voice more than the model takes, one of a type, size or length it does not read, or one without its
			// stored file is refused, never left out: the shot would be made without that line.
			if voices >= m.AudioReferences || rel == nil || !voiceTypes[*contentType] || ref.Size <= 0 || ref.Size > limit || len(ref.SHA256) != 64 {
				return nil, errVoiceReferenceUnusable
			}
			path, ok := a.mediaFile(tid, *rel)
			if !ok {
				return nil, errVoiceReferenceUnusable
			}
			seconds, ok := voiceSeconds(path, *contentType)
			if spoken += seconds; !ok || seconds < minVoiceSeconds+voiceLengthMargin || seconds > maxVoiceSeconds || spoken > maxVoicesSeconds {
				return nil, errVoiceReferenceUnusable
			}
			ref.ContentType, ref.Path = *contentType, *rel
			refs = append(refs, ref)
			voices++
			continue
		}
		if pictures >= m.References {
			continue
		}
		if rel == nil || contentType == nil || !types[*contentType] || ref.Size <= 0 || ref.Size > limit || len(ref.SHA256) != 64 {
			if numbered {
				return nil, errSubjectReferenceUnusable
			}
			continue
		}
		if _, ok := a.mediaFile(tid, *rel); !ok {
			if numbered {
				return nil, errSubjectReferenceUnusable
			}
			continue
		}
		ref.ContentType, ref.Path = *contentType, *rel
		refs = append(refs, ref)
		pictures++
	}
	if voices > 0 && pictures == 0 {
		return nil, errVoiceReferenceUnusable
	}
	if len(refs) == 0 {
		return nil, nil
	}
	return refs, nil
}

// mediaReferenceLines are the composer lines naming refs, so a stored prompt shows which pictures a generation
// started from (the transcript renders them as file chips) and an admission can resolve them again.
func mediaReferenceLines(refs []mediaReference) string {
	lines := make([]string, 0, len(refs))
	for _, ref := range refs {
		name := strings.Join(strings.Fields(ref.Name), " ")
		if name == "" {
			name = "reference"
		}
		lines = append(lines, "[附件] "+name+" · "+artifactRefPrefix+ref.ArtifactID)
	}
	return strings.Join(lines, "\n")
}

// withReferenceLines is a stored media prompt: the words, then the lines of the pictures it starts from.
func withReferenceLines(text string, refs []mediaReference) string {
	if len(refs) == 0 {
		return text
	}
	if text == "" {
		return mediaReferenceLines(refs)
	}
	return text + "\n\n" + mediaReferenceLines(refs)
}

// readMediaReference reads a frozen reference back, refusing one whose stored bytes are gone or changed.
func (a *App) readMediaReference(tid string, ref mediaReference) ([]byte, error) {
	path, ok := a.mediaFile(tid, ref.Path)
	if !ok {
		return nil, &rhError{Code: "media_reference_unavailable"}
	}
	data, err := readStoredFile(path, ref.Size)
	if err != nil {
		return nil, &rhError{Code: "media_reference_unavailable"}
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != ref.SHA256 {
		return nil, &rhError{Code: "media_reference_unavailable"}
	}
	return data, nil
}

// uploadMediaReferences sends a run's frozen references to the provider and returns the provider's ids, in order.
func (a *App) uploadMediaReferences(ctx context.Context, hub mediaProvider, tid, runID string, refs []mediaReference) ([]string, error) {
	uploader, ok := hub.(referenceUploader)
	if !ok {
		return nil, &rhError{Code: "media_reference_unavailable"}
	}
	// One slot for all of the run's uploads, which go one file at a time (referenceUploadSlots), taken at its first file
	// to send: a run whose references are all reused needs none.
	holding := false
	defer func() {
		if holding {
			<-referenceUploadSlots
		}
	}()
	ids := make([]string, 0, len(refs))
	for _, ref := range refs {
		if id, ok := a.reusedJimengReference(ctx, hub, tid, ref); ok {
			ids = append(ids, id)
			continue
		}
		if !holding {
			select {
			case referenceUploadSlots <- struct{}{}:
				holding = true
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		id, err := a.sendMediaReference(ctx, uploader, tid, runID, ref)
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// maxReferenceUploadsInFlight bounds the runs uploading references at once across this API (2026-10-20): an upload holds
// its file and the upload's body in memory (RunningHub's up to 10 MB, the others' up to 20 MB, each twice), and a canvas
// run that started 37 videos from references at once took the API past its 512 MiB memory cap (killed by the kernel and
// restarted at 03:14:18Z).
const maxReferenceUploadsInFlight = 4

// referenceUploadSlots are those runs' slots: a run waits for one as long as its context lets it, holds it while its
// references are read and sent one at a time (and while X-tasy prepares one, or Jimeng waits for its own command slots),
// and frees it when its uploads end. Runs take slots in turn, so the first to come is the first sent.
var referenceUploadSlots = make(chan struct{}, maxReferenceUploadsInFlight)

// mediaSendTooLate reports a run that should not send its task in the time it has left: one that waited for its uploads
// until less than half of the media timeout remains, so that a task sent now could outlast the run, be charged and still
// fail. Such a run ends unsent instead, and so uncharged, as busy (media_provider_busy, which a canvas run tries again).
func mediaSendTooLate(ctx context.Context, timeout time.Duration) bool {
	deadline, ok := ctx.Deadline()
	return ok && time.Until(deadline) < timeout/2
}

// sendMediaReference reads one frozen reference and sends it, trying a transient failure again (referenceUploadTries)
// while the run's context lasts. Its run holds a slot of referenceUploadSlots meanwhile (uploadMediaReferences).
func (a *App) sendMediaReference(ctx context.Context, uploader referenceUploader, tid, runID string, ref mediaReference) (string, error) {
	data, err := a.readMediaReference(tid, ref)
	if err != nil {
		return "", err
	}
	var id string
	for try := 1; ; try++ {
		upload, cancel := context.WithTimeout(ctx, referenceUploadTimeout)
		id, err = uploader.uploadReference(upload, ref, data, runID)
		cancel()
		e, known := asRHError(err)
		if err == nil || !known || !e.Transient || try >= referenceUploadTries || ctx.Err() != nil {
			break
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(time.Duration(try) * 2 * time.Second):
		}
	}
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", err
	}
	return id, nil
}

// reusedJimengReference: a picture Jimeng itself generated for this workspace (the media-N file of a jm.* run) is
// named by its own resource on Jimeng's canvas instead of being uploaded again (owner request 2026-10-12: the red and
// blue cars of 极光 GT, made from the white one, failed on the upload). It is the same bytes Jimeng made, checked by
// the artifact's SHA-256; any doubt (another provider, no task recorded, a result Jimeng no longer reports) uploads the
// picture as before.
func (a *App) reusedJimengReference(ctx context.Context, hub mediaProvider, tid string, ref mediaReference) (string, bool) {
	j, ok := hub.(*jimengClient)
	if !ok || j == nil {
		return "", false
	}
	var taskID, model, field string
	e := a.db.QueryRow(ctx, `SELECT COALESCE(r.media_task->>'taskId',''), g.model, a.field_id FROM artifacts a
		JOIN runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
		JOIN media_generations g ON g.tenant_id=a.tenant_id AND g.run_id=a.run_id
		WHERE a.tenant_id=$1 AND a.id=$2 AND a.sha256=$3`, tid, ref.ArtifactID, ref.SHA256).Scan(&taskID, &model, &field)
	if e != nil || !jimengModelID.MatchString(model) || taskID == "" || !strings.HasPrefix(field, "media-") {
		return "", false
	}
	index, err := strconv.Atoi(strings.TrimPrefix(field, "media-"))
	if err != nil {
		return "", false
	}
	lookup, cancel := context.WithTimeout(ctx, jimengQueryTimeout)
	defer cancel()
	return j.existingReference(lookup, taskID, index)
}

// referenceFileName is the neutral name a reference goes to a provider under: never the user's own file name.
func referenceFileName(contentType string) string {
	switch contentType {
	case "image/jpeg":
		return "reference.jpg"
	case "image/webp":
		return "reference.webp"
	case "audio/mpeg":
		return "reference.mp3"
	case "audio/wav", "audio/x-wav":
		return "reference.wav"
	}
	return "reference.png"
}

// multipartFile is a multipart/form-data body holding one file under field, and its Content-Type header value.
func multipartFile(field, fileName, contentType string, data []byte) ([]byte, string, error) {
	var buf bytes.Buffer
	// Sized once, so a large file is not copied again and again as the body grows.
	buf.Grow(len(data) + 1024)
	w := multipart.NewWriter(&buf)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, field, fileName))
	header.Set("Content-Type", contentType)
	part, err := w.CreatePart(header)
	if err != nil {
		return nil, "", err
	}
	if _, err = part.Write(data); err != nil {
		return nil, "", err
	}
	if err = w.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), w.FormDataContentType(), nil
}
