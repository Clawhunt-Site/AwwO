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
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Tripo 3D (https://developers.tripo3d.ai) runs the 3D model nodes: a node's prompt is submitted once as one
// text-to-model task, the task is followed until it succeeds or fails, and its model (GLB) and rendered preview
// are downloaded at once (Tripo's links expire after five minutes) and stored like every generated media file.
// The key is sent only to Tripo's API origin; files are fetched from Tripo's storage hosts through the same
// public-address-only client RunningHub results use. Provider messages are never stored or shown: they can echo
// the prompt or account details, so failures are reduced to the same closed codes as RunningHub's.

const (
	runtimeTripo       = "tripo"
	tripoResponseLimit = 1 << 20
)

// tripoWireParams maps catalog parameter names (letters and digits, like every media parameter) onto Tripo's
// request fields. A parameter without an entry here is refused by the catalog check unless it is one of the rig and
// animation chain's own settings (tripoChainParam), which no model request carries; so none is ever dropped.
var tripoWireParams = map[string]string{
	"texture": "texture", "pbr": "pbr", "textureQuality": "texture_quality", "geometryQuality": "geometry_quality",
	"faceLimit": "face_limit", "negativePrompt": "negative_prompt", "autoSize": "auto_size",
}

var (
	tripoModelID   = regexp.MustCompile(`^tripo\.[a-z0-9][a-z0-9-]{0,62}$`)
	tripoVersionID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$`)
	tripoTaskID    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
)

// tripoModels is the curated 3D catalog: Tripo's high-precision H series for detailed assets and its P series
// for clean low-poly game assets, each pinned to one version so a run never changes model under the operator.
// Parameters are the documented, closed choices of POST /v3/generation/text-to-model.
func tripoModels() []*mediaModel {
	number := func(v float64) *float64 { return &v }
	texture := mediaParam{Name: "texture", Type: "boolean", Default: true, Label: [2]string{"生成贴图", "Texture"}}
	pbr := mediaParam{Name: "pbr", Type: "boolean", Default: true, Label: [2]string{"PBR 材质", "PBR materials"}}
	textureQuality := mediaParam{Name: "textureQuality", Type: "enum", Values: []string{"standard", "detailed"}, Default: "standard",
		Label: [2]string{"贴图质量", "Texture quality"}}
	negative := mediaParam{Name: "negativePrompt", Type: "text", MaxLength: 255, Label: [2]string{"不要出现的内容", "Negative prompt"}}
	autoSize := mediaParam{Name: "autoSize", Type: "boolean", Default: false, Label: [2]string{"按真实尺寸（米）", "Real-world size (m)"}}
	// Users see a generic name in their language, never the provider's (owner decisions 2026-10-11). Both series end
	// with the skeleton and animations a game character needs (tripoMotionParams).
	return []*mediaModel{
		{ID: "tripo.v3-1", Name: "3D · 高精度", Label: [2]string{"3D · 高精度", "3D · High detail"}, Vendor: mediaVendorShown,
			Kind: mediaKindModel3D, Mode: "text-to-model3d", References: 1,
			Endpoint: "/generation/text-to-model", Version: "v3.1-20260211", Prompt: mediaPrompt{MinLength: 1, MaxLength: 1024},
			Params: append([]mediaParam{texture, pbr, textureQuality,
				{Name: "geometryQuality", Type: "enum", Values: []string{"standard", "detailed"}, Default: "standard", Label: [2]string{"几何精度", "Geometry detail"}},
				{Name: "faceLimit", Type: "integer", Min: number(1000), Max: number(500000), Label: [2]string{"面数上限", "Face limit"}},
				negative, autoSize}, tripoMotionParams()...),
			Docs: "https://developers.tripo3d.ai/en/docs/generation-text-to-model/standard", Provider: mediaProviderTripo},
		{ID: "tripo.p1", Name: "3D · 游戏低多边形", Label: [2]string{"3D · 游戏低多边形", "3D · Low-poly game asset"}, Vendor: mediaVendorShown,
			Kind: mediaKindModel3D, Mode: "text-to-model3d", References: 1,
			Endpoint: "/generation/text-to-model", Version: "P1-20260311", Prompt: mediaPrompt{MinLength: 1, MaxLength: 1024},
			Params: append([]mediaParam{texture, pbr, textureQuality,
				{Name: "faceLimit", Type: "integer", Min: number(500), Max: number(20000), Default: 5000.0, Label: [2]string{"面数上限", "Face limit"}},
				negative, autoSize}, tripoMotionParams()...),
			Docs: "https://developers.tripo3d.ai/en/docs/generation-text-to-model/p", Provider: mediaProviderTripo},
	}
}

// tripoChainParam is a parameter that drives the rig and animation chain (tripo_motion.go) instead of the model request,
// accepted only exactly as that chain defines it.
func tripoChainParam(p *mediaParam) (known, exact bool) {
	for _, want := range tripoMotionParams() {
		if want.Name == p.Name {
			return true, reflect.DeepEqual(*p, want)
		}
	}
	return false, false
}

func validTripoModel(m *mediaModel) error {
	if m.Provider != mediaProviderTripo || !tripoModelID.MatchString(m.ID) || !cleanCatalogText(m.Name, 80) || !validMediaLabel(m) ||
		m.Vendor != mediaVendorShown || !mediaDate.MatchString(m.Verified) || !tripoVersionID.MatchString(m.Version) {
		return errors.New("identity")
	}
	if m.Kind != mediaKindModel3D || m.Mode != "text-to-model3d" || m.Endpoint != "/generation/text-to-model" {
		return errors.New("kind")
	}
	// image-to-model takes exactly one picture.
	if m.References < 0 || m.References > 1 {
		return errors.New("references")
	}
	if m.Prompt.MinLength < 1 || m.Prompt.MaxLength < m.Prompt.MinLength || m.Prompt.MaxLength > 1024 {
		return errors.New("prompt")
	}
	if !strings.HasPrefix(m.Docs, "https://developers.tripo3d.ai/en/docs/") || len(m.Docs) > 200 {
		return errors.New("docs")
	}
	if len(m.Params) > maxMediaParams {
		return errors.New("too many parameters")
	}
	names := map[string]bool{}
	for i := range m.Params {
		p := &m.Params[i]
		// Each parameter is a field of the model request or a setting of the chain, never neither and never both.
		chain, exact := tripoChainParam(p)
		if !mediaParamName.MatchString(p.Name) || reservedMediaParams[p.Name] || names[p.Name] || (tripoWireParams[p.Name] == "") == !chain ||
			(chain && !exact) || !cleanCatalogText(p.Label[0], 40) || !cleanCatalogText(p.Label[1], 40) {
			return fmt.Errorf("parameter %q", p.Name)
		}
		names[p.Name] = true
		if err := validMediaParamSpec(p); err != nil {
			return fmt.Errorf("parameter %q: %w", p.Name, err)
		}
	}
	return validMediaParamRequires(m.Params)
}

// tripoRequest is the body of one text-to-model task: the prompt, the pinned version and the resolved
// parameters under Tripo's own names.
func tripoRequest(m *mediaModel, prompt string, params map[string]any) map[string]any {
	body := map[string]any{"prompt": strings.TrimSpace(prompt), "model": m.Version}
	for name, value := range params {
		if wire := tripoWireParams[name]; wire != "" {
			body[wire] = value
		}
	}
	return body
}

// tripoImageEndpoint builds a model from one picture (POST /v3/generation/image-to-model, the same H and P series
// versions as text-to-model).
const tripoImageEndpoint = "/generation/image-to-model"

// tripoImageRequest is the body of one image-to-model task: the uploaded picture's file token as its input, the
// pinned version and the resolved choices. The endpoint reads no words, so neither the prompt nor the negative
// prompt is sent.
func tripoImageRequest(m *mediaModel, fileToken string, params map[string]any) map[string]any {
	body := map[string]any{"input": fileToken, "model": m.Version}
	for name, value := range params {
		if wire := tripoWireParams[name]; wire != "" && wire != "negative_prompt" {
			body[wire] = value
		}
	}
	return body
}

var tripoFileToken = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// uploadReference stores one reference picture in Tripo's file store (POST /v3/files, JPEG or PNG up to 20 MB) and
// returns its file_token for image-to-model. The picture goes under a neutral name.
func (t *tripoClient) uploadReference(ctx context.Context, ref mediaReference, data []byte, _ string) (string, error) {
	if !mediaReferenceTypes[mediaProviderTripo][ref.ContentType] || len(data) == 0 || len(data) > maxMediaReferenceBytes {
		return "", &rhError{Code: "media_reference_unavailable"}
	}
	body, contentType, err := multipartFile("file", referenceFileName(ref.ContentType), ref.ContentType, data)
	if err != nil {
		return "", &rhError{Code: "media_request_invalid"}
	}
	answer, status, _, err := t.request(ctx, http.MethodPost, "/files", body, contentType)
	if err != nil {
		return "", err
	}
	if status != 200 {
		return "", tripoHTTPError(status, answer)
	}
	var v struct {
		Code json.RawMessage `json:"code"`
		Data struct {
			FileToken string `json:"file_token"`
		} `json:"data"`
	}
	if json.Unmarshal(answer, &v) != nil {
		return "", &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	if code := numericCode(v.Code); code != "" && code != "0" {
		return "", tripoCodeError(code)
	}
	token := strings.TrimSpace(v.Data.FileToken)
	if !tripoFileToken.MatchString(token) {
		return "", &rhError{Code: "media_provider_unavailable"}
	}
	return token, nil
}

type tripoClient struct {
	base    string
	key     string
	api     *http.Client
	files   *http.Client
	hosts   []string
	maxFile int64
}

func newTripo(c Config) *tripoClient {
	t := &tripoClient{base: c.TripoBaseURL, key: c.TripoAPIKey, hosts: c.TripoResultHosts, maxFile: c.MediaMaxFileBytes}
	t.api = &http.Client{Timeout: 30 * time.Second, Transport: apiTransport(c), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	t.files = &http.Client{Timeout: 0, Transport: publicOnlyTransport(c), CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || !resultURLAllowed(t.hosts, req.URL) {
			return errors.New("result redirect refused")
		}
		return nil
	}}
	return t
}

func (t *tripoClient) fileLimit() int64 { return t.maxFile }

func (t *tripoClient) download(ctx context.Context, raw string, w io.Writer) (int64, error) {
	return downloadResult(ctx, t.files, t.hosts, t.maxFile, raw, w)
}

// submit creates the task. Tripo freezes the task's credits at creation and charges them only on success. Its busy
// answers (a full concurrency pool for the model's series, or its rate limit) create no task, so they carry the
// wait Tripo asked for and the caller may send the same body again (submitMedia).
func (t *tripoClient) submit(ctx context.Context, endpoint string, body map[string]any) (rhTask, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return rhTask{}, &rhError{Code: "media_request_invalid"}
	}
	data, status, wait, err := t.do(ctx, http.MethodPost, endpoint, raw)
	if err != nil {
		return rhTask{}, err
	}
	if status != 200 {
		return rhTask{}, tripoRefusal(refusedAnswer(tripoHTTPError(status, data)), wait)
	}
	var v struct {
		Code json.RawMessage `json:"code"`
		Data struct {
			TaskID string `json:"task_id"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &v) != nil {
		return rhTask{}, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	if code := numericCode(v.Code); code != "" && code != "0" {
		return rhTask{}, tripoRefusal(refusedAnswer(tripoCodeError(code)), wait)
	}
	id := strings.TrimSpace(v.Data.TaskID)
	if !tripoTaskID.MatchString(id) {
		return rhTask{}, &rhError{Code: "media_provider_unavailable"}
	}
	return rhTask{TaskID: id, Status: "QUEUED"}, nil
}

// query reads one task: queued and running keep the caller polling, success carries the model and its preview,
// and every other state is a closed failure code.
func (t *tripoClient) query(ctx context.Context, taskID string) (rhTask, error) {
	if !tripoTaskID.MatchString(taskID) {
		return rhTask{}, &rhError{Code: "media_task_missing"}
	}
	data, status, _, err := t.do(ctx, http.MethodGet, "/tasks/"+url.PathEscape(taskID), nil)
	if err != nil {
		return rhTask{}, err
	}
	if status != 200 {
		return rhTask{}, tripoHTTPError(status, data)
	}
	return parseTripoTask(data, taskID)
}

func parseTripoTask(data []byte, taskID string) (rhTask, error) {
	var v struct {
		Code json.RawMessage `json:"code"`
		Data struct {
			TaskID    string          `json:"task_id"`
			Status    string          `json:"status"`
			ErrorCode json.RawMessage `json:"error_code"`
			Output    struct {
				ModelURL         string `json:"model_url"`
				PBRModelURL      string `json:"pbr_model_url"`
				BaseModelURL     string `json:"base_model_url"`
				RenderedImageURL string `json:"rendered_image_url"`
			} `json:"output"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &v) != nil {
		return rhTask{}, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	if code := numericCode(v.Code); code != "" && code != "0" {
		return rhTask{}, tripoCodeError(code)
	}
	task := rhTask{TaskID: strings.TrimSpace(v.Data.TaskID)}
	if task.TaskID == "" {
		task.TaskID = taskID
	}
	switch strings.ToLower(strings.TrimSpace(v.Data.Status)) {
	case "queued", "":
		task.Status = "QUEUED"
	case "running":
		task.Status = "RUNNING"
	case "success":
		task.Status = "SUCCESS"
		model := strings.TrimSpace(v.Data.Output.ModelURL)
		for _, alternative := range []string{v.Data.Output.PBRModelURL, v.Data.Output.BaseModelURL} {
			if model == "" {
				model = strings.TrimSpace(alternative)
			}
		}
		if model == "" {
			return task, &rhError{Code: "media_no_output"}
		}
		task.Results = []rhResult{{URL: model, OutputType: "model"}}
		if preview := strings.TrimSpace(v.Data.Output.RenderedImageURL); preview != "" {
			task.Results = append(task.Results, rhResult{URL: preview, OutputType: "image"})
		}
	case "banned":
		return task, &rhError{Code: "media_content_rejected"}
	case "expired":
		return task, &rhError{Code: "media_result_unavailable"}
	case "failed", "cancelled":
		// Tripo returns a failed or cancelled task's frozen credits, so the run costs its plan nothing
		// (followMedia). A documented failure reason, such as a content refusal, is kept; a busy code
		// is not a reason here, since the task already ended.
		failure := &rhError{Code: "media_failed", Unbilled: true}
		if code := numericCode(v.Data.ErrorCode); code != "" {
			if known, ok := tripoCodes[code]; ok && !known.Transient {
				failure.Code = known.Code
			}
		}
		return task, failure
	default:
		return task, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	return task, nil
}

// do sends one API request. wait is how long a refused (429) request was asked to wait, and 0 otherwise.
func (t *tripoClient) do(ctx context.Context, method, path string, body []byte) (data []byte, status int, wait time.Duration, err error) {
	return t.request(ctx, method, path, body, "application/json")
}

// request is do with the body's own content type (a multipart upload's).
func (t *tripoClient) request(ctx context.Context, method, path string, body []byte, contentType string) (data []byte, status int, wait time.Duration, err error) {
	if ctx.Err() != nil {
		return nil, 0, 0, ctx.Err()
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, t.base+path, reader)
	if err != nil {
		return nil, 0, 0, &rhError{Code: "media_request_invalid"}
	}
	req.Header.Set("Authorization", "Bearer "+t.key)
	if body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := t.api.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, 0, 0, ctx.Err()
		}
		return nil, 0, 0, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	defer resp.Body.Close()
	data, err = io.ReadAll(io.LimitReader(resp.Body, tripoResponseLimit+1))
	if err != nil || len(data) > tripoResponseLimit {
		return nil, 0, 0, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		wait = tripoRetryAfter(resp.Header, time.Now())
	}
	return data, resp.StatusCode, wait, nil
}

// Tripo's busy answers are waited out for at least a second and at most half a minute at a time; the run's own
// deadline bounds the whole wait.
const (
	tripoBusyWait    = 5 * time.Second
	tripoBusyWaitMin = time.Second
	tripoBusyWaitMax = 30 * time.Second
)

// tripoRetryAfter reads how long Tripo asked a refused request to wait: Retry-After in seconds (its concurrency
// answer) or X-RateLimit-Reset as a Unix time (its rate limit), bounded to 1-30 s, and 5 s when neither is given.
func tripoRetryAfter(h http.Header, now time.Time) time.Duration {
	wait := tripoBusyWait
	if n, err := strconv.Atoi(strings.TrimSpace(h.Get("Retry-After"))); err == nil {
		wait = time.Duration(n) * time.Second
	} else if n, err := strconv.ParseInt(strings.TrimSpace(h.Get("X-RateLimit-Reset")), 10, 64); err == nil {
		wait = time.Unix(n, 0).Sub(now)
	}
	return min(max(wait, tripoBusyWaitMin), tripoBusyWaitMax)
}

// tripoRefusal marks Tripo's busy answer to a submission -- the model series' concurrency pool is full (2000) or
// the key's rate limit is reached (1007, or a bare 429) -- as safe to send again: Tripo created no task, so nothing
// was frozen or billed. Every other error is returned unchanged and is never resent.
func tripoRefusal(err error, wait time.Duration) error {
	if e, ok := asRHError(err); ok && e.Code == "media_provider_busy" {
		if wait <= 0 {
			wait = tripoBusyWait
		}
		e.RetryAfter = wait
	}
	return err
}

// tripoHTTPError reduces an error answer to a closed code, reading Tripo's documented error code first.
func tripoHTTPError(status int, data []byte) error {
	var v struct {
		Code json.RawMessage `json:"code"`
	}
	_ = json.Unmarshal(data, &v)
	if code := numericCode(v.Code); code != "" && code != "0" {
		if _, known := tripoCodes[code]; known {
			return tripoCodeError(code)
		}
	}
	switch {
	case status == 401 || status == 403:
		return &rhError{Code: "media_provider_unauthorized"}
	case status == 404:
		return &rhError{Code: "media_task_missing"}
	case status == 429:
		return &rhError{Code: "media_provider_busy", Transient: true}
	case status >= 500:
		return &rhError{Code: "media_provider_unavailable", Transient: true}
	case status == 400:
		return &rhError{Code: "media_params_invalid"}
	}
	return &rhError{Code: "media_failed"}
}

// tripoCodes maps Tripo's documented error codes onto closed AwwO codes. 2010 is the operator's balance: the
// account needs topping up, which the failure says without naming the account.
var tripoCodes = map[string]rhError{
	"1000": {Code: "media_provider_unauthorized"}, "1001": {Code: "media_provider_unauthorized"},
	"2010": {Code: "media_provider_balance"},
	"2008": {Code: "media_content_rejected"},
	"1007": {Code: "media_provider_busy", Transient: true}, "2000": {Code: "media_provider_busy", Transient: true},
	"2002": {Code: "media_params_invalid"}, "2003": {Code: "media_params_invalid"}, "2004": {Code: "media_params_invalid"},
	"1004": {Code: "media_params_invalid"},
	"2015": {Code: "media_failed"}, "2018": {Code: "media_failed"},
}

// tripoCodeError returns a fresh error for a Tripo code; an undocumented code is a plain failure.
func tripoCodeError(code string) error {
	if e, ok := tripoCodes[code]; ok {
		return &e
	}
	return &rhError{Code: "media_failed"}
}
