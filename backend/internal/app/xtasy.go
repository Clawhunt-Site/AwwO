package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// X-tasy (service.xtasyart.com, the operator's own media platform) runs the image and video nodes once its key is
// configured. A node's prompt is submitted as one generation task under an Idempotency-Key made from the run, so a
// send whose answer was lost is sent again and X-tasy answers with the task the first send made: never a second
// task or charge. The task is followed until it completes or fails, and its outputs are downloaded at once from the
// API origin itself, with the key, since X-tasy serves them only to the account that made them. The key goes
// nowhere else. Provider messages are never stored or shown (they can echo the prompt), so every failure is one of
// the closed media codes.

const (
	runtimeXtasy       = "xtasy"
	xtasyResponseLimit = 1 << 20
	// xtasyIdempotencyField carries the run's Idempotency-Key from xtasyRequest to the client inside the request map.
	// It cannot be a field X-tasy accepts (it holds a NUL byte), and the client removes it before sending.
	xtasyIdempotencyField = "\x00idempotency"
	xtasyUserAgent        = "AwwO-media/1.0"
	xtasyResendWait       = 5 * time.Second
	xtasyDocs             = "https://service.xtasyart.com/openapi/v1/models"
)

// xtasyWireParams maps catalog parameter names (letters and digits, like every media parameter) onto X-tasy's
// parameter names. A catalog parameter without an entry here is refused at startup, so none is ever dropped.
var xtasyWireParams = map[string]string{
	"aspectRatio": "aspect_ratio", "imageNum": "count", "resolution": "resolution", "negativePrompt": "negative_prompt",
	"duration": "duration", "generateAudio": "generate_audio",
}

var (
	xtasyModelID     = regexp.MustCompile(`^xt\.[a-z0-9][a-z0-9-]{0,62}$`)
	xtasyRemoteModel = regexp.MustCompile(`^model_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	xtasyTaskID      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	xtasyOutputID    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	xtasyIdemKey     = regexp.MustCompile(`^[!-~]{1,200}$`)
	xtasyEndpoints   = map[string]string{mediaKindImage: "/openapi/v1/images/generations", mediaKindVideo: "/openapi/v1/videos/generations"}
)

// xtasyFixed are the parameters each model always sends with one value: text-only generation (a reference picture
// changes the mode, xtasyRequest), and for the omni video models no watermark and no extra last-frame picture beside
// the video.
var xtasyFixed = map[string]map[string]any{
	"xt.seedream-5-pro": {"mode": "txt2img"}, "xt.gemini-3-1-flash-image": {"mode": "txt2img"},
	"xt.gpt-image-2-5": {"mode": "txt2img"},
	"xt.xtasy-3":       {"mode": "txt2img"}, "xt.xtasy-3-pro": {"mode": "txt2img"}, "xt.omni-image-5-pro": {"mode": "txt2img"},
	"xt.omni-video":     {"mode": "multimodal", "watermark": false, "return_last_frame": false},
	"xt.omni-video-2-5": {"mode": "text2video", "watermark": false, "return_last_frame": false, "output_format": "mp4"},
}

// xtasyReferenceModels are the models that generate from reference pictures uploaded to POST /openapi/v1/files, and
// how many each takes. The image models edit one (mode img2img, named {"role":"reference_image","file_id"}): the
// models the operator's own scripts have generated that way with this API. The video models (owner requests
// 2026-10-12: 视频节点也加参考图, 视频也支持按多张图做主体参考) start from one picture as their first frame (mode
// interpolation, {"role":"first_frame"}), and with two or more take them all as subject references (mode multimodal,
// each {"role":"reference_image"}), as GET /openapi/v1/models lists those roles and modes for every one of them (read
// 2026-10-12 12:01Z): at most 9 reference images for the omni model and 30 for 2.5, here capped at the 10 files a
// message carries. The 2.5 model also allows only an adaptive ratio with a frame and takes
// omni_reference_task_type with references. Every other model stays text-only until it is verified the same way.
var xtasyReferenceModels = map[string]int{"xt.xtasy-3": 1, "xt.xtasy-3-pro": 1, "xt.seedream-5-pro": 1,
	"xt.omni-video": 9, "xt.omni-video-2-5": 10}

// maxXtasyVideoReferences bounds a video model's reference count: the files one message carries.
const maxXtasyVideoReferences = 10

// xtasyModels is the curated X-tasy catalog: the text-to-image and text-to-video models GET /openapi/v1/models
// published on 2026-10-10, each pinned to its stable model id, with that model's closed choices. A choice whose
// cost the model decides itself (an automatic duration) is left out, so a generation's price is known when it is
// admitted.
func xtasyModels() []*mediaModel {
	n := func(v float64) *float64 { return &v }
	ratio := func(def string, values ...string) mediaParam {
		return mediaParam{Name: "aspectRatio", Type: "enum", Values: values, Default: def, Label: [2]string{"画面比例", "Aspect ratio"}}
	}
	resolution := func(def string, values ...string) mediaParam {
		return mediaParam{Name: "resolution", Type: "enum", Values: values, Default: def, Label: [2]string{"分辨率", "Resolution"}}
	}
	images := func(most float64) mediaParam {
		return mediaParam{Name: "imageNum", Type: "integer", Min: n(1), Max: n(most), Default: 1.0, Label: [2]string{"生成张数", "Images"}}
	}
	duration := func(least, most float64) mediaParam {
		return mediaParam{Name: "duration", Type: "integer", Min: n(least), Max: n(most), Default: 5.0, Label: [2]string{"时长（秒）", "Duration (s)"}}
	}
	audio := mediaParam{Name: "generateAudio", Type: "boolean", Default: true, Label: [2]string{"生成音频", "Generate audio"}}
	negative := mediaParam{Name: "negativePrompt", Type: "text", MaxLength: 2000, Label: [2]string{"反向提示词", "Negative prompt"}}
	ratios := []string{"1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"}
	videoRatios := []string{"16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"}
	prompt := mediaPrompt{MinLength: 1, MaxLength: 32000}
	// Verified: every model generated once at these defaults with the operator's key on 2026-10-10 (TestXtasyLiveEveryModel).
	// Users see a generic name in their language, never the provider's or the model family's (owner decisions
	// 2026-10-11): what a model is good for, by the facts below (2K by default, up to 4K, several pictures a run).
	model := func(id string, label [2]string, kind, remote string, params ...mediaParam) *mediaModel {
		return &mediaModel{ID: id, Name: label[0], Label: label, Vendor: mediaVendorShown, Kind: kind, Mode: "text-to-" + kind,
			Endpoint: xtasyEndpoints[kind], Version: remote, Prompt: prompt, Params: params, Docs: xtasyDocs, Verified: "2026-10-10",
			Provider: mediaProviderXtasy, References: xtasyReferenceModels[id]}
	}
	return []*mediaModel{
		model("xt.seedream-5-pro", [2]string{"图片 · 高清", "Image · HD"}, mediaKindImage, "model_db5a9f8c-6421-5dd4-8ede-8e1e9b545110",
			ratio("1:1", ratios...), resolution("2K", "2K", "1K")),
		model("xt.gemini-3-1-flash-image", [2]string{"图片 · 超清", "Image · Ultra HD"}, mediaKindImage, "model_740b5a45-d90d-531f-9dba-f51dd4e71254",
			ratio("1:1", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "1:8", "4:1", "8:1"),
			resolution("1K", "512px", "1K", "2K", "4K")),
		model("xt.gpt-image-2-5", [2]string{"图片 · 超清多张 Pro", "Image · Ultra HD batch Pro"}, mediaKindImage, "model_6fe4cc38-b598-5a88-ad7e-b4cefa0a9e51",
			ratio("auto", "auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"), images(4), resolution("1K", "1K", "2K", "4K")),
		model("xt.xtasy-3", [2]string{"图片 · 标准多张", "Image · Standard batch"}, mediaKindImage, "model_0641b8b9-f39e-5bd5-bccb-104b84988282",
			ratio("1:1", ratios...), images(6), resolution("1K", "1K", "2K"), negative),
		model("xt.xtasy-3-pro", [2]string{"图片 · 标准多张 Pro", "Image · Standard batch Pro"}, mediaKindImage, "model_52c32c2d-aecc-564d-84d6-c5549ff349c9",
			ratio("1:1", ratios...), images(6), resolution("1K", "1K", "2K"), negative),
		model("xt.omni-image-5-pro", [2]string{"图片 · 全能", "Image · All-round"}, mediaKindImage, "model_5cb47bcb-5ce8-57d2-804c-8f382dedc9fe",
			ratio("1:1", ratios...), resolution("2K", "2K", "1K")),
		// A new video node starts on the first video model (withProviderModels): All-round, the cheaper of the two.
		model("xt.omni-video", [2]string{"视频 · 全能", "Video · All-round"}, mediaKindVideo, "model_c0b9927f-48b0-539e-8f79-087e226e4e81",
			ratio("16:9", videoRatios...), duration(4, 15), resolution("720p", "480p", "720p"), audio),
		model("xt.omni-video-2-5", [2]string{"视频 · 全能 Pro", "Video · All-round Pro"}, mediaKindVideo, "model_c69e040f-0150-5092-a9bc-2a4c03aaaf49",
			ratio("16:9", videoRatios...), duration(4, 30), resolution("720p", "480p", "720p"), audio),
	}
}

func validXtasyModel(m *mediaModel) error {
	if m.Provider != mediaProviderXtasy || !xtasyModelID.MatchString(m.ID) || !cleanCatalogText(m.Name, 80) || !validMediaLabel(m) ||
		m.Vendor != mediaVendorShown || !mediaDate.MatchString(m.Verified) || !xtasyRemoteModel.MatchString(m.Version) {
		return errors.New("identity")
	}
	if (m.Kind != mediaKindImage && m.Kind != mediaKindVideo) || m.Mode != "text-to-"+m.Kind || m.Endpoint != xtasyEndpoints[m.Kind] {
		return errors.New("kind")
	}
	if m.Prompt.MinLength < 1 || m.Prompt.MaxLength < m.Prompt.MinLength || m.Prompt.MaxLength > 32000 {
		return errors.New("prompt")
	}
	if m.Docs != xtasyDocs {
		return errors.New("docs")
	}
	fixed, ok := xtasyFixed[m.ID]
	if !ok {
		return errors.New("fixed parameters")
	}
	if m.References < 0 || m.References > maxXtasyVideoReferences || (m.References > 0 && !(m.Kind == mediaKindVideo ||
		(m.Kind == mediaKindImage && fixed["mode"] == "txt2img" && m.References == 1))) {
		return errors.New("references")
	}
	if len(m.Params) > maxMediaParams {
		return errors.New("too many parameters")
	}
	names := map[string]bool{}
	for i := range m.Params {
		p := &m.Params[i]
		wire := xtasyWireParams[p.Name]
		if !mediaParamName.MatchString(p.Name) || reservedMediaParams[p.Name] || names[p.Name] || wire == "" || fixed[wire] != nil ||
			!cleanCatalogText(p.Label[0], 40) || !cleanCatalogText(p.Label[1], 40) {
			return fmt.Errorf("parameter %q", p.Name)
		}
		names[p.Name] = true
		if err := validMediaParamSpec(p); err != nil {
			return fmt.Errorf("parameter %q: %w", p.Name, err)
		}
	}
	return nil
}

// xtasyRequest is the body of one generation task: the pinned model, the prompt, the model's fixed parameters and
// the resolved choices under X-tasy's own names, and the run's Idempotency-Key for the client. With reference
// pictures (their uploaded file ids) an image model edits them: mode img2img, each named as a reference_image. A
// video model starts from a single picture as its first_frame (mode interpolation, at the adaptive ratio, so the video
// keeps the picture's shape; the only ratio the 2.5 model allows with a frame), and takes two or more as subject
// references: mode multimodal, each a reference_image, the node's own ratio kept (2.5: task type reference).
func xtasyRequest(m *mediaModel, prompt string, params map[string]any, runID string, references []string) map[string]any {
	parameters := map[string]any{}
	for name, value := range xtasyFixed[m.ID] {
		parameters[name] = value
	}
	for name, value := range params {
		if wire := xtasyWireParams[name]; wire != "" {
			parameters[wire] = value
		}
	}
	refs := []any{}
	if len(references) > 0 && m.References > 0 {
		references = references[:min(len(references), m.References)]
		role := "reference_image"
		switch {
		case m.Kind != mediaKindVideo:
			parameters["mode"] = "img2img"
		case len(references) == 1:
			role = "first_frame"
			parameters["mode"], parameters["aspect_ratio"] = "interpolation", "adaptive"
		default:
			parameters["mode"] = "multimodal"
			if m.ID == "xt.omni-video-2-5" {
				parameters["omni_reference_task_type"] = "reference"
			}
		}
		for _, id := range references {
			refs = append(refs, map[string]any{"role": role, "file_id": id})
		}
	}
	return map[string]any{"model_id": m.Version, "prompt": strings.TrimSpace(prompt), "parameters": parameters, "references": refs,
		xtasyIdempotencyField: "awwo-run-" + runID}
}

var xtasyFileID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)

// xtasyFileWait is how often a reference upload's preparation is read again; xtasyFileReads bounds how many times.
const (
	xtasyFileWait  = 2 * time.Second
	xtasyFileReads = 60
)

// uploadReference stores one reference picture with X-tasy (POST /openapi/v1/files, multipart) under an
// Idempotency-Key made from the run and the picture, so a repeated upload of the same run reuses the first one,
// then waits until X-tasy has prepared it (GET /openapi/v1/files/<id>: status ready). It returns the file id.
func (x *xtasyClient) uploadReference(ctx context.Context, ref mediaReference, data []byte, runID string) (string, error) {
	if !mediaReferenceTypes[mediaProviderXtasy][ref.ContentType] || len(data) == 0 || len(data) > maxMediaReferenceBytes || len(ref.SHA256) < 16 {
		return "", &rhError{Code: "media_reference_unavailable"}
	}
	key := "awwo-ref-" + runID + "-" + ref.SHA256[:16]
	if !xtasyIdemKey.MatchString(key) {
		return "", &rhError{Code: "media_request_invalid"}
	}
	body, contentType, err := multipartFile("file", referenceFileName(ref.ContentType), ref.ContentType, data)
	if err != nil {
		return "", &rhError{Code: "media_request_invalid"}
	}
	answer, status, _, err := x.request(ctx, http.MethodPost, "/openapi/v1/files", body, contentType, key)
	if err != nil {
		return "", err
	}
	if status < 200 || status > 299 {
		return "", xtasyHTTPError(status, answer)
	}
	var created struct {
		FileID string `json:"file_id"`
	}
	if json.Unmarshal(answer, &created) != nil || !xtasyFileID.MatchString(strings.TrimSpace(created.FileID)) {
		return "", &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	id := strings.TrimSpace(created.FileID)
	for range xtasyFileReads {
		answer, status, _, err = x.do(ctx, http.MethodGet, "/openapi/v1/files/"+url.PathEscape(id), nil, "")
		if err != nil {
			return "", err
		}
		if status != 200 {
			return "", xtasyHTTPError(status, answer)
		}
		var file struct {
			Status      string `json:"status"`
			Preparation *struct {
				Status string `json:"status"`
			} `json:"preparation"`
		}
		if json.Unmarshal(answer, &file) != nil {
			return "", &rhError{Code: "media_provider_unavailable", Transient: true}
		}
		state := strings.ToLower(strings.TrimSpace(file.Status))
		prepared := ""
		if file.Preparation != nil {
			prepared = strings.ToLower(strings.TrimSpace(file.Preparation.Status))
		}
		switch {
		case state == "ready" && (prepared == "" || prepared == "ready"):
			return id, nil
		case state == "failed" || state == "rejected" || prepared == "failed" || prepared == "rejected":
			return "", &rhError{Code: "media_reference_unavailable"}
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(xtasyFileWait):
		}
	}
	return "", &rhError{Code: "media_reference_unavailable"}
}

type xtasyClient struct {
	base    string
	key     string
	api     *http.Client
	files   *http.Client
	maxFile int64
}

func newXtasy(c Config) *xtasyClient {
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &xtasyClient{base: c.XtasyBaseURL, key: c.XtasyAPIKey, maxFile: c.MediaMaxFileBytes,
		api: &http.Client{Timeout: 30 * time.Second, Transport: apiTransport(c), CheckRedirect: noRedirect},
		// Outputs come from the API origin itself and can be long videos: no overall timeout (the run's deadline
		// bounds the download) and no redirect is followed, so the key is never sent anywhere else.
		files: &http.Client{Timeout: 0, Transport: apiTransport(c), CheckRedirect: noRedirect}}
}

func (x *xtasyClient) fileLimit() int64 { return x.maxFile }

// submit creates the task. The Idempotency-Key makes every send of one run the same request, so an answer that
// never arrived, a busy answer and a server error are all sent again after a wait (submitMedia): X-tasy answers a
// repeated key with the task the first send created. A refusal is final.
func (x *xtasyClient) submit(ctx context.Context, endpoint string, body map[string]any) (rhTask, error) {
	key, _ := body[xtasyIdempotencyField].(string)
	if !xtasyIdemKey.MatchString(key) || (endpoint != xtasyEndpoints[mediaKindImage] && endpoint != xtasyEndpoints[mediaKindVideo]) {
		return rhTask{}, &rhError{Code: "media_request_invalid"}
	}
	send := make(map[string]any, len(body))
	for name, value := range body {
		if name != xtasyIdempotencyField {
			send[name] = value
		}
	}
	raw, err := json.Marshal(send)
	if err != nil {
		return rhTask{}, &rhError{Code: "media_request_invalid"}
	}
	data, status, wait, err := x.do(ctx, http.MethodPost, endpoint, raw, key)
	if err != nil {
		return rhTask{}, xtasyResendable(err, 0)
	}
	if status < 200 || status > 299 {
		return rhTask{}, xtasyResendable(refusedAnswer(xtasyHTTPError(status, data)), wait)
	}
	task, err := parseXtasyTask(data, "", x.base)
	if err != nil {
		return task, xtasyResendable(err, 0)
	}
	return task, nil
}

// query reads one task: queued and running keep the caller polling, completed carries the outputs, and every
// other state is a closed failure code.
func (x *xtasyClient) query(ctx context.Context, taskID string) (rhTask, error) {
	if !xtasyTaskID.MatchString(taskID) {
		return rhTask{}, &rhError{Code: "media_task_missing"}
	}
	data, status, _, err := x.do(ctx, http.MethodGet, "/openapi/v1/tasks/"+url.PathEscape(taskID), nil, "")
	if err != nil {
		return rhTask{}, err
	}
	if status != 200 {
		return rhTask{}, xtasyHTTPError(status, data)
	}
	return parseXtasyTask(data, taskID, x.base)
}

// download fetches one output from the API origin, with the key. Only the exact output address parseXtasyTask
// builds is accepted.
func (x *xtasyClient) download(ctx context.Context, raw string, w io.Writer) (int64, error) {
	if !x.outputURL(raw) {
		return 0, &rhError{Code: "media_result_refused"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return 0, &rhError{Code: "media_result_refused"}
	}
	req.Header.Set("Authorization", "Bearer "+x.key)
	req.Header.Set("User-Agent", xtasyUserAgent)
	resp, err := x.files.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		return 0, &rhError{Code: "media_result_unavailable", Transient: true}
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return 0, &rhError{Code: "media_provider_unauthorized"}
	case resp.StatusCode != 200:
		return 0, &rhError{Code: "media_result_unavailable", Transient: resp.StatusCode >= 500}
	case resp.ContentLength > x.maxFile:
		return 0, &rhError{Code: "media_result_too_large"}
	}
	n, err := io.Copy(w, io.LimitReader(resp.Body, x.maxFile+1))
	if err != nil {
		return n, &rhError{Code: "media_result_unavailable", Transient: true}
	}
	if n > x.maxFile {
		return n, &rhError{Code: "media_result_too_large"}
	}
	return n, nil
}

// outputURL accepts exactly <base>/openapi/v1/tasks/<task>/outputs/<output>/content.
func (x *xtasyClient) outputURL(raw string) bool {
	rest, ok := strings.CutPrefix(raw, x.base+"/openapi/v1/tasks/")
	if !ok {
		return false
	}
	parts := strings.Split(rest, "/")
	return len(parts) == 4 && xtasyTaskID.MatchString(parts[0]) && parts[1] == "outputs" && xtasyOutputID.MatchString(parts[2]) && parts[3] == "content"
}

// do sends one API request. wait is how long a busy (429 or 503) answer asked to wait, and 0 otherwise.
func (x *xtasyClient) do(ctx context.Context, method, path string, body []byte, idempotency string) (data []byte, status int, wait time.Duration, err error) {
	return x.request(ctx, method, path, body, "application/json", idempotency)
}

// request is do with the body's own content type (a multipart upload's).
func (x *xtasyClient) request(ctx context.Context, method, path string, body []byte, contentType, idempotency string) (data []byte, status int, wait time.Duration, err error) {
	if ctx.Err() != nil {
		return nil, 0, 0, ctx.Err()
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, x.base+path, reader)
	if err != nil {
		return nil, 0, 0, &rhError{Code: "media_request_invalid"}
	}
	// net/http sends a request that carries an Idempotency-Key and can rewind its body again by itself when a reused
	// connection drops before the answer. Every resend of a generation must be submitMedia's own, which counts it (a
	// refusal that answers a resend keeps the generation counted), so a submission gives the transport no way to
	// rewind its body. A reference upload, which no allowance counts, keeps the transport's resend.
	if path == xtasyEndpoints[mediaKindImage] || path == xtasyEndpoints[mediaKindVideo] {
		req.GetBody = nil
	}
	req.Header.Set("Authorization", "Bearer "+x.key)
	req.Header.Set("Accept", "application/json")
	// X-tasy's edge refuses some library user agents (Cloudflare 1010), so the client names itself.
	req.Header.Set("User-Agent", xtasyUserAgent)
	if body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	if idempotency != "" {
		req.Header.Set("Idempotency-Key", idempotency)
	}
	resp, err := x.api.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, 0, 0, ctx.Err()
		}
		return nil, 0, 0, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	defer resp.Body.Close()
	data, err = io.ReadAll(io.LimitReader(resp.Body, xtasyResponseLimit+1))
	if err != nil || len(data) > xtasyResponseLimit {
		return nil, 0, 0, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
		wait = tripoRetryAfter(resp.Header, time.Now())
	}
	return data, resp.StatusCode, wait, nil
}

// xtasyResendable marks a transient submission failure as safe to send again after wait (5 s when none was given):
// the Idempotency-Key guarantees a repeat creates no second task. Every other error is returned unchanged.
func xtasyResendable(err error, wait time.Duration) error {
	if e, ok := asRHError(err); ok && e.Transient {
		if wait <= 0 {
			wait = xtasyResendWait
		}
		e.RetryAfter = wait
	}
	return err
}

func parseXtasyTask(data []byte, want, base string) (rhTask, error) {
	var v struct {
		TaskID  string          `json:"task_id"`
		Status  string          `json:"status"`
		Error   json.RawMessage `json:"error"`
		Outputs []struct {
			OutputID string `json:"output_id"`
			Role     string `json:"role"`
			URL      string `json:"url"`
		} `json:"outputs"`
		Billing struct {
			Status  string `json:"status"`
			Charged string `json:"charged"`
		} `json:"billing"`
	}
	if json.Unmarshal(data, &v) != nil {
		return rhTask{}, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	task := rhTask{TaskID: strings.TrimSpace(v.TaskID)}
	if task.TaskID == "" {
		task.TaskID = want
	}
	if !xtasyTaskID.MatchString(task.TaskID) {
		return rhTask{}, &rhError{Code: "media_provider_unavailable"}
	}
	switch state := strings.ToLower(strings.TrimSpace(v.Status)); state {
	case "queued", "pending", "submitted", "created", "waiting", "accepted":
		task.Status = "QUEUED"
	case "running", "processing", "in_progress", "started", "generating":
		task.Status = "RUNNING"
	case "completed", "succeeded", "success", "done":
		task.Status = "SUCCESS"
		for _, out := range v.Outputs {
			// The result itself; an extra beside it (a video's last frame, say) is not what the node generates.
			if role := strings.ToLower(strings.TrimSpace(out.Role)); role != "" && role != "output" {
				continue
			}
			if !xtasyOutputID.MatchString(out.OutputID) || out.URL != "/openapi/v1/tasks/"+task.TaskID+"/outputs/"+out.OutputID+"/content" {
				return task, &rhError{Code: "media_result_refused"}
			}
			task.Results = append(task.Results, rhResult{URL: base + out.URL, OutputType: "file"})
			if len(task.Results) == rhMaxResults {
				break
			}
		}
		if len(task.Results) == 0 {
			return task, &rhError{Code: "media_no_output"}
		}
	case "failed", "error", "cancelled", "canceled", "rejected", "blocked", "moderated", "expired":
		return task, xtasyTaskFailure(state, v.Error, v.Billing.Status, v.Billing.Charged)
	default:
		return task, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	return task, nil
}

// xtasyTaskFailure reduces a task that ended without a result to a closed code. X-tasy settles a charge only for a
// task that delivered and releases the reservation otherwise, so anything short of a settled, non-zero charge
// leaves the run unbilled for its plan.
func xtasyTaskFailure(state string, raw json.RawMessage, billing, charged string) error {
	code := xtasyErrorCode(raw)
	failure := &rhError{Code: "media_failed"}
	switch {
	case state == "expired":
		failure.Code = "media_result_unavailable"
	case state == "rejected" || state == "blocked" || state == "moderated" || xtasyContentCode(code):
		failure.Code = "media_content_rejected"
	case strings.Contains(code, "INSUFFICIENT"):
		failure.Code = "media_provider_balance"
	}
	amount, err := strconv.ParseFloat(strings.TrimSpace(charged), 64)
	if !strings.EqualFold(strings.TrimSpace(billing), "settled") || err != nil || amount <= 0 {
		failure.Unbilled = true
	}
	return failure
}

// xtasyErrorCode reads a task's failure code, given as {"code": ...} or as a bare string.
func xtasyErrorCode(raw json.RawMessage) string {
	var object struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(raw, &object) == nil && object.Code != "" {
		return strings.ToUpper(strings.TrimSpace(object.Code))
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return strings.ToUpper(strings.TrimSpace(text))
	}
	return ""
}

func xtasyContentCode(code string) bool {
	for _, word := range []string{"MODERATION", "CONTENT", "SAFETY", "POLICY", "SENSITIVE", "NSFW"} {
		if strings.Contains(code, word) {
			return true
		}
	}
	return false
}

// xtasyHTTPError reduces an error answer ({"error": {"code", "message", "retryable"}}) to a closed code; the
// message is never read.
func xtasyHTTPError(status int, data []byte) error {
	var v struct {
		Error struct {
			Code      string `json:"code"`
			Retryable bool   `json:"retryable"`
		} `json:"error"`
	}
	_ = json.Unmarshal(data, &v)
	code := strings.ToUpper(strings.TrimSpace(v.Error.Code))
	switch {
	case status == 401 || status == 403 || strings.Contains(code, "API_KEY") || code == "UNAUTHORIZED" || code == "FORBIDDEN":
		return &rhError{Code: "media_provider_unauthorized"}
	case status == 402 || strings.Contains(code, "INSUFFICIENT"):
		return &rhError{Code: "media_provider_balance"}
	case xtasyContentCode(code):
		return &rhError{Code: "media_content_rejected"}
	case code == "TASK_NOT_FOUND" || status == 404 && code == "":
		return &rhError{Code: "media_task_missing"}
	case code == "MODEL_NOT_FOUND" || status == 404:
		return &rhError{Code: "media_provider_unavailable"}
	case status == 429 || strings.Contains(code, "RATE_LIMIT") || strings.Contains(code, "CONCURRENCY") || strings.Contains(code, "BUSY") ||
		status == 409 && strings.Contains(code, "IDEMPOTENCY"):
		return &rhError{Code: "media_provider_busy", Transient: true}
	case status >= 500 || v.Error.Retryable:
		return &rhError{Code: "media_provider_unavailable", Transient: true}
	case status == 400 || status == 422:
		return &rhError{Code: "media_params_invalid"}
	}
	return &rhError{Code: "media_failed"}
}
