package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"mime/multipart"
	"net/textproto"
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
// nothing is fetched from anywhere else, and the bytes go to no one but that provider. An upload creates no charge,
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
}

// referenceUploader is a provider that takes reference pictures: it returns the id its generation request names.
type referenceUploader interface {
	uploadReference(ctx context.Context, ref mediaReference, data []byte, runID string) (string, error)
}

// freezeMediaReferences picks the pictures a generation of model m starts from: the first ones the text names, up
// to the model's limit, that are this canvas's uploads or generated media of a type the provider takes. Anything
// else the text names (another canvas's file, a document, a deleted upload, a picture too large) is left out.
func (a *App) freezeMediaReferences(ctx context.Context, q querier, tid, canvasID, text string, m *mediaModel) ([]mediaReference, error) {
	if m == nil || m.References <= 0 || canvasID == "" {
		return nil, nil
	}
	types := mediaReferenceTypes[m.Provider]
	refs := []mediaReference{}
	for _, id := range uploadReferences(text) {
		if len(refs) >= m.References {
			break
		}
		ref := mediaReference{ArtifactID: id}
		var rel, contentType *string
		e := q.QueryRow(ctx, "SELECT name,size,sha256,storage_path,content_type FROM artifacts WHERE tenant_id=$1 AND canvas_id=$2 AND id=$3 AND (field_id=$4 OR field_id LIKE 'media-%')",
			tid, canvasID, id, uploadField).Scan(&ref.Name, &ref.Size, &ref.SHA256, &rel, &contentType)
		if noRows(e) {
			continue
		}
		if e != nil {
			return nil, e
		}
		if rel == nil || contentType == nil || !types[*contentType] || ref.Size <= 0 || ref.Size > maxMediaReferenceBytes || len(ref.SHA256) != 64 {
			continue
		}
		if _, ok := a.mediaFile(tid, *rel); !ok {
			continue
		}
		ref.ContentType, ref.Path = *contentType, *rel
		refs = append(refs, ref)
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
	ids := make([]string, 0, len(refs))
	for _, ref := range refs {
		data, err := a.readMediaReference(tid, ref)
		if err != nil {
			return nil, err
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
				return nil, ctx.Err()
			case <-time.After(time.Duration(try) * 2 * time.Second):
			}
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// referenceFileName is the neutral name a reference goes to a provider under: never the user's own file name.
func referenceFileName(contentType string) string {
	switch contentType {
	case "image/jpeg":
		return "reference.jpg"
	case "image/webp":
		return "reference.webp"
	}
	return "reference.png"
}

// multipartFile is a multipart/form-data body holding one file under field, and its Content-Type header value.
func multipartFile(field, fileName, contentType string, data []byte) ([]byte, string, error) {
	var buf bytes.Buffer
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
