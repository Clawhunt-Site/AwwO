package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

// RunningHub's Standard Model API is task based: submit a request, receive a task id, query it
// until it succeeds or fails, then fetch the result files. The key is sent only to the configured
// API origin; result files come from RunningHub's storage and are fetched through a client that
// refuses anything but public addresses on the allowed hosts.

const (
	rhResponseLimit = 1 << 20
	rhMaxResults    = 8
	rhSubmitTimeout = 30 * time.Second
)

type rhResult struct {
	URL        string `json:"url"`
	OutputType string `json:"outputType"`
}

type rhTask struct {
	TaskID  string
	Status  string
	Code    string
	Results []rhResult
}

// runningHubLabels are the names users see for RunningHub's models, [Chinese, English]: what each is good for, by its
// settings in media_models.json (sizes, batches, style controls, sound, length), never its maker, family or version
// (owner decisions 2026-10-11, 「模型名也全部改成通用名」), and none the other providers' models already use.
// withProviderModels refuses to start on a RunningHub model without one.
var runningHubLabels = map[string][2]string{
	"rh.seedream-v5-pro":    {"图片 · 高清无损", "Image · Lossless HD"},
	"rh.nano-banana-pro":    {"图片 · 超清精品", "Image · Ultra HD Premium"},
	"rh.nano-banana-2":      {"图片 · 超清快速", "Image · Ultra HD Fast"},
	"rh.gpt-image-2":        {"图片 · 精细可调", "Image · Adjustable detail"},
	"rh.qwen-image-3-pro":   {"图片 · 中英文字", "Image · Text in pictures"},
	"rh.midjourney-v7":      {"图片 · 艺术风格", "Image · Artistic style"},
	"rh.grok-imagine":       {"图片 · 宽幅", "Image · Wide format"},
	"rh.wan-2-7-pro":        {"图片 · 自定尺寸", "Image · Custom size"},
	"rh.jimeng-4-6":         {"图片 · 海报设计", "Image · Poster design"},
	"rh.kling-v3-pro":       {"视频 · 动作流畅", "Video · Smooth motion"},
	"rh.seedance-2":         {"视频 · 全高清带声", "Video · Full HD with sound"},
	"rh.veo-3-1-fast":       {"视频 · 超清带声", "Video · Ultra HD with sound"},
	"rh.sora-2":             {"视频 · 写实", "Video · Realistic"},
	"rh.hailuo-2-3-pro":     {"视频 · 动感", "Video · Dynamic"},
	"rh.vidu-q3-pro":        {"视频 · 动漫风格", "Video · Anime style"},
	"rh.wan-2-7":            {"视频 · 全高清标准", "Video · Full HD Standard"},
	"rh.grok-imagine-video": {"视频 · 快速出片", "Video · Quick clip"},
	"rh.pixverse-v6":        {"视频 · 灵活时长", "Video · Flexible length"},

	// A video made from reference pictures: the characters, things and places in them stay the same from shot to shot.
	"rh.seedance-2-multimodal": {"视频 · 多图参考", "Video · From references"},

	// Sound, by what it is for in a film: a character's or a narrator's voice, and the score under it.
	"rh.minimax-speech-2-8-hd":          {"配音 · 旁白", "Voice-over"},
	"rh.minimax-music-2-6-instrumental": {"配乐 · 纯音乐", "Score · Instrumental"},
}

// runningHubWireParams maps a RunningHub model's catalog parameter names (letters and digits, like every media
// parameter) onto its request fields where the two differ; every other parameter is sent under its own name. The
// catalog check refuses a parameter whose field is the prompt's, a fixed one or another parameter's, and an entry for
// a parameter the model does not have.
var runningHubWireParams = map[string]map[string]string{
	"rh.minimax-speech-2-8-hd": {"voice": "voice_id", "englishNormalization": "english_normalization"},
}

// runningHubPromptField names the field a model reads its words from where it is not "prompt": the speech model
// reads aloud its text.
var runningHubPromptField = map[string]string{"rh.minimax-speech-2-8-hd": "text"}

// runningHubFixed are the fields a model always sends with one value: the speech model returns a file to download,
// never the audio inline as base64; the music model makes MP3, the one format a node keeps, and music without a voice
// (isInstrumental: the same route makes songs from lyrics otherwise). The instrumental route the docs also list,
// .../music-2.6/text-to-instrumental, answered 1001 "Invalid URL" to the operator's key on 2026-10-17.
var runningHubFixed = map[string]map[string]any{
	"rh.minimax-speech-2-8-hd":          {"enable_base64_output": false},
	"rh.minimax-music-2-6-instrumental": {"format": "mp3", "isInstrumental": true},
}

// runningHubPromptFieldOf is the field model id reads its words from.
func runningHubPromptFieldOf(id string) string {
	if field := runningHubPromptField[id]; field != "" {
		return field
	}
	return "prompt"
}

// runningHubWireName is the request field of a model's parameter.
func runningHubWireName(id, name string) string {
	if wire := runningHubWireParams[id][name]; wire != "" {
		return wire
	}
	return name
}

// runningHubReferenceField names the request field a RunningHub model's reference pictures go in: the URLs its upload
// answered (uploadReference), in the order the run froze them. A model without an entry takes no pictures; the catalog
// check refuses references on it, and refuses a parameter or a fixed field on this one.
var runningHubReferenceField = map[string]string{"rh.seedance-2-multimodal": "imageUrls"}

// runningHubAudioField names the request field a RunningHub model's voices go in (M-1c), the same way: the URLs their
// uploads answered, in the order the run froze them. Only a model that takes pictures takes voices (RunningHub reads a
// voice only beside a picture or a video).
var runningHubAudioField = map[string]string{"rh.seedance-2-multimodal": "audioUrls"}

// runningHubRequest is the body of one RunningHub task: the resolved values of the model's own parameters under their
// request names, then its fixed fields, its reference pictures' and voices' URLs (each kind in order, up to the model's
// count of it, only for a model that names a field for it; refs says which URL is which, a URL without one is a
// picture) and the words under its prompt field, which nothing frozen can replace (a snapshot from another catalog
// version included).
func runningHubRequest(m *mediaModel, prompt string, params map[string]any, refs []mediaReference, references []string) map[string]any {
	body := map[string]any{}
	for i := range m.Params {
		if value, ok := params[m.Params[i].Name]; ok {
			body[runningHubWireName(m.ID, m.Params[i].Name)] = value
		}
	}
	for field, value := range runningHubFixed[m.ID] {
		body[field] = value
	}
	pictures, voices := []string{}, []string{}
	for i, url := range references {
		if i < len(refs) && strings.HasPrefix(refs[i].ContentType, "audio/") {
			voices = append(voices, url)
		} else {
			pictures = append(pictures, url)
		}
	}
	if field := runningHubReferenceField[m.ID]; field != "" && len(pictures) > 0 && m.References > 0 {
		body[field] = slices.Clone(pictures[:min(len(pictures), m.References)])
	}
	if field := runningHubAudioField[m.ID]; field != "" && len(voices) > 0 && m.AudioReferences > 0 {
		body[field] = slices.Clone(voices[:min(len(voices), m.AudioReferences)])
	}
	body[runningHubPromptFieldOf(m.ID)] = prompt
	return body
}

const (
	// rhUploadPath takes one file (multipart, field "file") and answers the URL a model's request names it by. An upload
	// creates no task and costs nothing; RunningHub fetches the file from that URL itself, so AwwO never reads it.
	rhUploadPath = "/openapi/v2/media/upload/binary"
	// rhMaxReferenceBytes is the largest file the upload takes (809 APIKEY_FILE_SIZE_EXCEEDED past it).
	rhMaxReferenceBytes = 10 << 20
	// rhMaxReferenceURL bounds the URL an upload answers, which every request of the run then carries.
	rhMaxReferenceURL = 2048
	// maxRunningHubReferences is the most pictures a RunningHub model takes (the multimodal video's imageUrls: 9).
	maxRunningHubReferences = 9
	// maxRunningHubAudioReferences is the most voices one takes (the multimodal video's audioUrls: 3, each 2–15 s and
	// together at most 15 s, which admission checks before RunningHub does: media_voice_length.go).
	maxRunningHubAudioReferences = 3
)

// uploadReference stores one reference picture with RunningHub (JPEG, PNG or WebP, up to 10 MB) under a neutral name
// and returns the https URL its answer names. The answer is read strictly: code 0 and a URL without credentials,
// anything else a closed code (never RunningHub's message). A request that never got an answer, a busy answer and a
// server error are transient, so the caller tries again (nothing was created); every other refusal is final.
func (h *runningHub) uploadReference(ctx context.Context, ref mediaReference, data []byte, _ string) (string, error) {
	if !(mediaReferenceTypes[mediaProviderRunningHub][ref.ContentType] || mediaAudioReferenceTypes[mediaProviderRunningHub][ref.ContentType]) ||
		len(data) == 0 || len(data) > rhMaxReferenceBytes {
		return "", &rhError{Code: "media_reference_unavailable"}
	}
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	body, contentType, err := multipartFile("file", referenceFileName(ref.ContentType), ref.ContentType, data)
	if err != nil {
		return "", &rhError{Code: "media_request_invalid"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.base+rhUploadPath, bytes.NewReader(body))
	if err != nil {
		return "", &rhError{Code: "media_request_invalid"}
	}
	req.Header.Set("Authorization", "Bearer "+h.key)
	req.Header.Set("Content-Type", contentType)
	resp, err := h.api.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	defer resp.Body.Close()
	answer, err := io.ReadAll(io.LimitReader(resp.Body, rhResponseLimit+1))
	if err != nil || len(answer) > rhResponseLimit {
		return "", &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	switch {
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return "", &rhError{Code: "media_provider_unauthorized"}
	case resp.StatusCode == 429:
		return "", &rhError{Code: "media_provider_busy", Transient: true}
	case resp.StatusCode >= 500:
		return "", &rhError{Code: "media_provider_unavailable", Transient: true}
	case resp.StatusCode != 200:
		return "", &rhError{Code: "media_reference_unavailable"}
	}
	var v struct {
		Code json.RawMessage `json:"code"`
		Data *struct {
			DownloadURL string `json:"download_url"`
		} `json:"data"`
	}
	if json.Unmarshal(answer, &v) != nil {
		return "", &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	switch code := numericCode(v.Code); code {
	case "0":
	case "":
		return "", &rhError{Code: "media_provider_unavailable"}
	case "809":
		return "", &rhError{Code: "media_reference_unavailable"}
	default:
		// A task code ("running", "queued") means nothing for an upload: it is not taken.
		if e, _ := asRHError(rhCodeError(code)); !e.is("media_pending") {
			return "", e
		}
		return "", &rhError{Code: "media_provider_unavailable"}
	}
	if v.Data == nil || !rhReferenceURL(v.Data.DownloadURL) {
		return "", &rhError{Code: "media_provider_unavailable"}
	}
	return v.Data.DownloadURL, nil
}

// rhReferenceURL accepts the URL an upload answered: https with a host, without credentials, spaces or a backslash,
// at most rhMaxReferenceURL bytes.
func rhReferenceURL(raw string) bool {
	if raw == "" || len(raw) > rhMaxReferenceURL || strings.ContainsAny(raw, " \t\r\n\\") {
		return false
	}
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.User == nil && u.Opaque == "" && u.Hostname() != ""
}

// rhError is a provider failure reduced to a closed code; RunningHub's message text is never
// stored or shown because it can echo prompt content or account details.
type rhError struct {
	Code      string
	Transient bool
	// RetryAfter is set only on a submission the provider refused before creating any task (Tripo's full
	// concurrency pool or rate limit), which is therefore safe to send again after this wait.
	RetryAfter time.Duration
	// Unbilled marks a task the provider ended on its side without charging for it (Tripo: failed, cancelled).
	Unbilled bool
	// Refused marks a submission the provider refused for a reason on the operator's side, creating no task and so
	// costing nothing (refusedAnswer): a free generation refused this way gives its attempt back (generationCounts).
	Refused bool
	// NoTask marks a submission whose answer says the provider created no task, for whatever reason (refusedAnswer):
	// nothing of it can be charged, so a backup may make the generation instead (media_fallback.go).
	NoTask bool
	// Ended marks an answer in which the task's own state says it ended without a result: failed, expired, refused.
	// A backup may then make the generation (media_fallback.go), unlike after an answer that only failed to say how the
	// task is doing (a refused key, an error status, a "no such task" that a key of another account or a passing fault
	// would give for a task still being made).
	Ended bool
}

// operatorRefusals are the refusals of a submission that are the operator's, not the request's: the key, the balance,
// a model the provider no longer has, a request the service itself built wrong, the account's credit ceiling. A
// refusal of the request's own content or settings keeps counting, so a refused prompt cannot be sent again and again
// at the operator's key for free.
var operatorRefusals = map[string]bool{"media_provider_unauthorized": true, "media_provider_balance": true,
	"media_provider_unavailable": true, "media_request_invalid": true, "media_credit_ceiling": true}

// refusedAnswer marks a provider's own definite (non-transient) refusal of a submission (an HTTP error status, or an
// error code in an answer that carries no task) as NoTask, and as Refused too when it is on the operator's side. A
// transient one may be sent again, and a failure to read a successful answer may hide a task, so callers apply it only
// where the answer itself says no task was created.
func refusedAnswer(err error) error {
	if e, ok := asRHError(err); ok && !e.Transient {
		e.NoTask = true
		if operatorRefusals[e.Code] {
			e.Refused = true
		}
	}
	return err
}

func (e *rhError) Error() string { return e.Code }

type runningHub struct {
	base    string
	key     string
	api     *http.Client
	files   *http.Client
	hosts   []string
	maxFile int64
}

func newRunningHub(c Config) *runningHub {
	h := &runningHub{base: c.RunningHubBaseURL, key: c.RunningHubAPIKey, hosts: c.MediaResultHosts, maxFile: c.MediaMaxFileBytes}
	h.api = &http.Client{Timeout: 30 * time.Second, Transport: apiTransport(c), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	h.files = &http.Client{Timeout: 0, Transport: publicOnlyTransport(c), CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || !h.allowedResultURL(req.URL) {
			return errors.New("result redirect refused")
		}
		return nil
	}}
	return h
}

// publicOnlyTransport dials only public unicast addresses. The check runs on the address being
// connected, after name resolution, so a host that resolves to a private address (or is
// re-bound to one) is refused. Proxy variables are never consulted; a development deployment
// behind a local proxy names it explicitly (AWWO_MEDIA_DEV_PROXY), and only that one loopback
// address is dialed besides public ones.
func publicOnlyTransport(c Config) *http.Transport {
	var proxy *url.URL
	if c.Env == "development" && c.MediaDevProxy != "" {
		proxy, _ = url.Parse(c.MediaDevProxy)
	}
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second, Control: func(network, address string, _ syscall.RawConn) error {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		if proxy != nil && host == proxy.Hostname() && port == proxy.Port() {
			return nil
		}
		addr, err := netip.ParseAddr(host)
		if err != nil || !publicAddress(addr) {
			return errors.New("refusing to connect to a non-public address")
		}
		return nil
	}}
	transport := &http.Transport{DialContext: dialer.DialContext, TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 60 * time.Second,
		MaxIdleConns: 8, IdleConnTimeout: 60 * time.Second, ForceAttemptHTTP2: true}
	if proxy != nil {
		transport.Proxy = http.ProxyURL(proxy)
	}
	return transport
}

// apiTransport carries the key: no proxy variables are consulted, and only an explicit development
// proxy is used, never for a local fake API.
func apiTransport(c Config) *http.Transport {
	transport := &http.Transport{DialContext: (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout: 15 * time.Second, MaxIdleConns: 8, IdleConnTimeout: 60 * time.Second, ForceAttemptHTTP2: true}
	if c.Env == "development" && c.MediaDevProxy != "" {
		if proxy, err := url.Parse(c.MediaDevProxy); err == nil {
			transport.Proxy = func(req *http.Request) (*url.URL, error) {
				if req.URL.Hostname() == "127.0.0.1" {
					return nil, nil
				}
				return proxy, nil
			}
		}
	}
	return transport
}

var nonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("2001:db8::/32"),
}

func publicAddress(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() ||
		addr.IsInterfaceLocalMulticast() || addr.IsMulticast() || addr.IsUnspecified() {
		return false
	}
	for _, prefix := range nonPublicPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

// allowedResultURL accepts https on the default port, without credentials, on an allowed host:
// an entry starting with a dot allows that domain's subdomains, any other entry exactly one host.
func (h *runningHub) allowedResultURL(u *url.URL) bool { return resultURLAllowed(h.hosts, u) }

func resultURLAllowed(hosts []string, u *url.URL) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || u.Port() != "" && u.Port() != "443" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, entry := range hosts {
		if strings.HasPrefix(entry, ".") && strings.HasSuffix(host, entry) && len(host) > len(entry) || host == entry {
			return true
		}
	}
	return false
}

// submit starts a task. A request the provider never received fails as transient; anything it
// answered is reduced to its task or a closed error code.
func (h *runningHub) submit(ctx context.Context, endpoint string, body map[string]any) (rhTask, error) {
	return h.call(ctx, endpoint, body, true)
}

func (h *runningHub) query(ctx context.Context, taskID string) (rhTask, error) {
	return h.call(ctx, "/openapi/v2/query", map[string]any{"taskId": taskID}, false)
}

// call posts to RunningHub. A submission's HTTP error status says no task was created, so for a submission a definite
// refusal on the operator's side is marked (refusedAnswer); an answer that parses, even a failed one, may carry a task.
func (h *runningHub) call(ctx context.Context, path string, body map[string]any, submission bool) (rhTask, error) {
	if ctx.Err() != nil {
		return rhTask{}, ctx.Err()
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return rhTask{}, &rhError{Code: "media_request_invalid"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.base+path, bytes.NewReader(raw))
	if err != nil {
		return rhTask{}, &rhError{Code: "media_request_invalid"}
	}
	req.Header.Set("Authorization", "Bearer "+h.key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.api.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return rhTask{}, ctx.Err()
		}
		return rhTask{}, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, rhResponseLimit+1))
	if err != nil || len(data) > rhResponseLimit {
		return rhTask{}, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	refused := func(err error) error {
		if submission {
			return refusedAnswer(err)
		}
		return err
	}
	switch {
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return rhTask{}, refused(&rhError{Code: "media_provider_unauthorized"})
	case resp.StatusCode == 429:
		// A rate limit turns a submission away before it is read: it made no task.
		return rhTask{}, &rhError{Code: "media_provider_busy", Transient: true, NoTask: submission}
	case resp.StatusCode >= 500:
		return rhTask{}, &rhError{Code: "media_provider_unavailable", Transient: true}
	case resp.StatusCode >= 400:
		// A client error turns the submission away: it made no task.
		return rhTask{}, refused(&rhError{Code: "media_failed"})
	case resp.StatusCode != 200:
		return rhTask{}, &rhError{Code: "media_failed"}
	}
	task, err := parseRHTask(data)
	// RunningHub answers a refused submission with 200 and an error code. One that names no task (an explicit empty
	// taskId and status, nothing wrapped, no results), read so by parseRHTask too, created none, so an operator-side
	// code there is a refusal like a 401's, and even a busy one made no task.
	if err != nil && submission && task.TaskID == "" && task.Status == "" && rhAnswerNamesNoTask(data) {
		err = refusedAnswer(err)
		// It says so only with a code that says why (an unreadable code says nothing, nor do the success codes 0 and
		// 200 however they are spelled), even when the code is a busy one.
		if e, ok := asRHError(err); ok {
			n, bad := strconv.Atoi(task.Code)
			e.NoTask = bad == nil && n != 0 && n != 200
		}
	}
	// A "no such task" code is not taken for the task's end: RunningHub has answered it beside a task it still runs.
	return task, err
}

// rhAnswerNamesNoTask reports whether an answer is RunningHub's flat refusal of a submission, as it answered a bad key
// (806) and a missing prompt (1007) on 2026-10-15: one JSON object whose taskId and status are present and the empty
// string, with an error code, that wraps no data and carries no results. encoding/json matches keys without regard to
// case and lets a repeated key win, so an answer with a repeated key, two keys that differ only in case or a key that
// is not ASCII is not this shape: what parseRHTask read from it could differ from what is read here. Any other shape
// may hold a task, and keeps the generation counted.
func rhAnswerNamesNoTask(data []byte) bool {
	dec := json.NewDecoder(bytes.NewReader(data))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return false
	}
	fields := map[string]string{}
	for dec.More() {
		t, err := dec.Token()
		name, ok := t.(string)
		if err != nil || !ok {
			return false
		}
		for i := 0; i < len(name); i++ {
			if name[i] >= utf8.RuneSelf {
				return false
			}
		}
		name = strings.ToLower(name)
		var raw json.RawMessage
		if _, repeated := fields[name]; repeated || dec.Decode(&raw) != nil {
			return false
		}
		fields[name] = string(bytes.TrimSpace(raw))
	}
	if t, err := dec.Token(); err != nil || t != json.Delim('}') {
		return false
	}
	if _, err := dec.Token(); err != io.EOF {
		return false
	}
	absentOr := func(name string, allowed ...string) bool {
		raw, present := fields[name]
		if !present {
			return true
		}
		for _, ok := range allowed {
			if raw == ok {
				return true
			}
		}
		return false
	}
	code, coded := fields["errorcode"]
	return fields["taskid"] == `""` && fields["status"] == `""` && coded && code != `""` && code != "null" &&
		absentOr("data", "null") && absentOr("results", "null", "[]")
}

// parseRHTask reads a task answer, either bare or wrapped once in {code, msg, data}.
func parseRHTask(data []byte) (rhTask, error) {
	return parseRHTaskLevel(data, true)
}

func parseRHTaskLevel(data []byte, unwrap bool) (rhTask, error) {
	var v struct {
		TaskID       json.RawMessage `json:"taskId"`
		Status       string          `json:"status"`
		ErrorCode    json.RawMessage `json:"errorCode"`
		Code         json.RawMessage `json:"code"`
		Results      []rhResult      `json:"results"`
		Data         json.RawMessage `json:"data"`
		ErrorMessage string          `json:"errorMessage"`
	}
	if json.Unmarshal(data, &v) != nil {
		return rhTask{}, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	// The wrapped shape ({code, msg, data}) carries the task in data, one level deep only.
	if len(v.Data) > 0 && string(v.Data) != "null" && len(v.TaskID) == 0 {
		if code := numericCode(v.Code); code != "" && code != "0" && code != "200" {
			return rhTask{}, rhCodeError(code)
		}
		if !unwrap {
			return rhTask{}, &rhError{Code: "media_provider_unavailable"}
		}
		return parseRHTaskLevel(v.Data, false)
	}
	task := rhTask{TaskID: stringOrNumber(v.TaskID), Status: strings.ToUpper(strings.TrimSpace(v.Status)), Code: numericCode(v.ErrorCode)}
	if task.Code == "" {
		if code := numericCode(v.Code); code != "0" && code != "200" {
			task.Code = code
		}
	}
	if task.Code != "" && task.Status != "SUCCESS" {
		err := rhCodeError(task.Code)
		// A task that says it failed has ended, whatever its code calls the cause: not one to poll again.
		if e, ok := asRHError(err); ok && task.Status == "FAILED" {
			if e.is("media_pending") {
				e.Code = "media_failed"
			}
			e.Ended, e.Transient, e.RetryAfter = true, false, 0
		}
		return task, err
	}
	if len(v.Results) > rhMaxResults {
		v.Results = v.Results[:rhMaxResults]
	}
	task.Results = v.Results
	if len(task.TaskID) > 64 || strings.ContainsAny(task.TaskID, "/?#\\ \t\r\n") {
		return rhTask{}, &rhError{Code: "media_provider_unavailable"}
	}
	switch task.Status {
	case "QUEUED", "RUNNING", "SUCCESS":
	case "FAILED":
		return task, &rhError{Code: "media_failed", Ended: true}
	case "":
		if task.TaskID == "" {
			return rhTask{}, &rhError{Code: "media_provider_unavailable", Transient: true}
		}
		task.Status = "QUEUED"
	default:
		return task, &rhError{Code: "media_provider_unavailable", Transient: true}
	}
	return task, nil
}

func stringOrNumber(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return strings.TrimSpace(s)
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	return ""
}

func numericCode(raw json.RawMessage) string {
	code := stringOrNumber(raw)
	if _, err := strconv.Atoi(code); err != nil {
		return ""
	}
	return code
}

// rhCodeError maps RunningHub's documented error codes onto closed AwwO codes.
func rhCodeError(code string) error {
	switch code {
	case "412", "801", "802", "806", "811", "1002", "1014":
		return &rhError{Code: "media_provider_unauthorized"}
	case "416", "812":
		return &rhError{Code: "media_provider_balance"}
	case "415", "421", "1003", "1010", "1011":
		return &rhError{Code: "media_provider_busy", Transient: true}
	case "433", "1501":
		return &rhError{Code: "media_content_rejected"}
	case "1505":
		// A photorealistic person, which Video · From references takes with its real-person switch on (M-1c): its own
		// code, so the reader is told so.
		return &rhError{Code: "media_real_person_rejected"}
	case "301", "1001", "1007", "1008", "1013":
		return &rhError{Code: "media_params_invalid"}
	case "1006", "1504":
		return &rhError{Code: "media_timeout"}
	case "423", "807", "1004":
		return &rhError{Code: "media_task_missing"}
	case "804", "813":
		// "Task running / queued": not a failure, the caller keeps polling.
		return &rhError{Code: "media_pending", Transient: true}
	}
	return &rhError{Code: "media_failed"}
}

// download streams one result file into w, refusing a host outside the allowlist, a non-public
// address, or a body larger than the configured limit.
func (h *runningHub) download(ctx context.Context, raw string, w io.Writer) (int64, error) {
	return downloadResult(ctx, h.files, h.hosts, h.maxFile, raw, w)
}

func (h *runningHub) fileLimit() int64 { return h.maxFile }

func downloadResult(ctx context.Context, client *http.Client, hosts []string, maxFile int64, raw string, w io.Writer) (int64, error) {
	u, err := url.Parse(raw)
	if err != nil || !resultURLAllowed(hosts, u) {
		return 0, &rhError{Code: "media_result_refused"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return 0, &rhError{Code: "media_result_refused"}
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		return 0, &rhError{Code: "media_result_unavailable", Transient: true}
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, &rhError{Code: "media_result_unavailable", Transient: resp.StatusCode >= 500}
	}
	if resp.ContentLength > maxFile {
		return 0, &rhError{Code: "media_result_too_large"}
	}
	n, err := io.Copy(w, io.LimitReader(resp.Body, maxFile+1))
	if err != nil {
		return n, &rhError{Code: "media_result_unavailable", Transient: true}
	}
	if n > maxFile {
		return n, &rhError{Code: "media_result_too_large"}
	}
	return n, nil
}

func (e *rhError) is(code string) bool { return e != nil && e.Code == code }

func asRHError(err error) (*rhError, bool) {
	var target *rhError
	ok := errors.As(err, &target)
	return target, ok
}

func (t rhTask) String() string { return fmt.Sprintf("task %s %s", t.TaskID, t.Status) }
