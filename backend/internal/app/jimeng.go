package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Jimeng (即梦, the operator's member account) runs image and video nodes through its official canvas command line,
// dreamina-canvas, signed in once on this host by device authorization: the owner approves the sign-in in his own
// browser and the CLI keeps it under AWWO_JIMENG_HOME. The CLI is the provider's API here, the way JimengCli_api turns
// the older Jimeng CLI into an HTTP API, without that project's shell strings: one generation is one node on a Jimeng
// canvas (one canvas per UTC day), saved and run in one call under identities derived from the AwwO run (its node ID,
// update ID and submit ID), so a submission whose answer was lost is sent again as the same operation and never paid
// twice. It is followed with `operation status`, and its pictures and videos are fetched with `resource download`.
//
// Every call executes the binary directly with an argument vector (a prompt is an argument, never command text), with
// an environment of its own (the API's database URL and keys never reach it), a timeout, bounded output and at most
// jimengConcurrency calls at once. A generation spends at most AWWO_JIMENG_CREDIT_CEILING Jimeng credits: a quote above
// it stops before anything is generated. The CLI's message text is never stored or shown (it can echo the prompt);
// each failure is reduced to a closed media code from its structured error (code, class, requiredAction) and exit code.

const (
	mediaProviderJimeng   = "jimeng"
	runtimeJimeng         = "jimeng"
	jimengDocs            = "https://jimeng.jianying.com/canvas-cli"
	jimengOutputLimit     = 1 << 20
	jimengConcurrency     = 4
	jimengSubmitTimeout   = 3 * time.Minute
	jimengQueryTimeout    = time.Minute
	jimengUploadTimeout   = 3 * time.Minute
	jimengRefreshEvery    = time.Hour
	defaultJimengProfile  = "awwo"
	defaultJimengCeiling  = 700
	jimengCanvasNameStart = "AwwO 媒体 "
)

// jimengResendWait is how long a transient submission waits before it is sent again (a variable for tests).
var jimengResendWait = 10 * time.Second

// jimengDownloadTries is how often one result is fetched before its run fails. A download is free and names its
// resource, so a passing failure (Jimeng answered "busy" while several results of one canvas run came back at once,
// 2026-10-12) is tried again instead of losing a generation that was made and paid for. Each wait is
// jimengDownloadWait times the try (a variable for tests).
const jimengDownloadTries = 4

var jimengDownloadWait = 3 * time.Second

// jimengLogText keeps a CLI field the log may carry (an error code, class or request id) to a short closed shape.
var jimengLogText = regexp.MustCompile(`[^A-Za-z0-9._:-]`)

var (
	jimengModelID     = regexp.MustCompile(`^jm\.[a-z0-9][a-z0-9-]{0,62}$`)
	jimengCanonical   = regexp.MustCompile(`^[a-z0-9][a-z0-9._]{0,63}$`)
	jimengProfileName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,39}$`)
	jimengUUIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	jimengWorkspaceID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	jimengEndpoints   = map[string]string{mediaKindImage: "jimeng:image", mediaKindVideo: "jimeng:video"}
	jimengTextModes   = map[string]string{mediaKindImage: "t2i", mediaKindVideo: "t2v"}
	jimengFlagFor     = map[string]string{"aspectRatio": "--ratio", "resolution": "--resolution", "duration": "--duration"}
)

// jimengMalformed is an answer the CLI did not give in its own envelope: a passing failure, never a result.
func jimengMalformed() error { return &rhError{Code: "media_provider_unavailable", Transient: true} }

// Crockford's Base32 alphabet, which Jimeng node ids are written in (node_ and ten of these).
const crockfordBase32 = "0123456789abcdefghjkmnpqrstvwxyz"

// jimengModels is the curated Jimeng catalog: two image and two video models of the live `model list` read on
// 2026-10-12, each pinned to its canonical model name (Version) with the choices that model accepts. Users see generic
// names, never the service, model family or version (owner decisions 2026-10-11). Each generation makes one file: the
// CLI's own advice is one node per picture. Videos stop at 15 seconds, which keeps the dearest choice (1080p) within a
// sensible credit ceiling; the cinematic model's 30-second clips are not offered.
func jimengModels() []*mediaModel {
	n := func(v float64) *float64 { return &v }
	ratio := func(values ...string) mediaParam {
		return mediaParam{Name: "aspectRatio", Type: "enum", Values: values, Default: "16:9", Label: [2]string{"画面比例", "Aspect ratio"}}
	}
	resolution := func(def string, values ...string) mediaParam {
		return mediaParam{Name: "resolution", Type: "enum", Values: values, Default: def, Label: [2]string{"分辨率", "Resolution"}}
	}
	duration := mediaParam{Name: "duration", Type: "integer", Min: n(4), Max: n(15), Default: 5.0, Label: [2]string{"时长（秒）", "Duration (s)"}}
	pictures := []string{"16:9", "1:1", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"}
	clips := []string{"16:9", "9:16", "1:1", "4:3", "3:4", "21:9"}
	model := func(id string, label [2]string, kind, canonical string, prompt int, params ...mediaParam) *mediaModel {
		return &mediaModel{ID: id, Name: label[0], Label: label, Vendor: mediaVendorShown, Kind: kind, Mode: "text-to-" + kind,
			Endpoint: jimengEndpoints[kind], Version: canonical, Prompt: mediaPrompt{MinLength: 1, MaxLength: prompt}, Params: params,
			Docs: jimengDocs, Verified: "2026-10-12", Provider: mediaProviderJimeng, References: jimengReferenceModels[id]}
	}
	return []*mediaModel{
		model("jm.image-cinema", [2]string{"图片 · 电影质感", "Image · Cinematic"}, mediaKindImage, "seedream_5.0_pro", 2000,
			ratio(pictures...), resolution("2K", "2K", "4K", "1.5K")),
		model("jm.image-express", [2]string{"图片 · 极速", "Image · Express"}, mediaKindImage, "seedream_4.7", 2000,
			ratio(pictures...), resolution("2K", "2K", "4K", "1K")),
		model("jm.video-cinema", [2]string{"视频 · 电影级", "Video · Cinematic"}, mediaKindVideo, "seedance_2.5", 15000,
			ratio(clips...), resolution("720p", "720p", "1080p", "480p"), duration),
		model("jm.video-express", [2]string{"视频 · 极速", "Video · Express"}, mediaKindVideo, "seedance_2.0_fast_vip", 4000,
			ratio(clips...), resolution("720p", "720p"), duration),
	}
}

// jimengReferenceModels are the image models that edit one reference picture (mode i2i, the picture uploaded to the
// day's canvas with `resource upload` and named as res:<resource id>). Video stays text-to-video: no canvas port feeds
// a picture into a video node yet.
var jimengReferenceModels = map[string]int{"jm.image-cinema": 1, "jm.image-express": 1}

func validJimengModel(m *mediaModel) error {
	if m.Provider != mediaProviderJimeng || !jimengModelID.MatchString(m.ID) || !cleanCatalogText(m.Name, 80) || !validMediaLabel(m) ||
		m.Vendor != mediaVendorShown || !mediaDate.MatchString(m.Verified) || !jimengCanonical.MatchString(m.Version) {
		return errors.New("identity")
	}
	if (m.Kind != mediaKindImage && m.Kind != mediaKindVideo) || m.Mode != "text-to-"+m.Kind || m.Endpoint != jimengEndpoints[m.Kind] {
		return errors.New("kind")
	}
	if m.Prompt.MinLength < 1 || m.Prompt.MaxLength < m.Prompt.MinLength || m.Prompt.MaxLength > 15000 {
		return errors.New("prompt")
	}
	if m.Docs != jimengDocs {
		return errors.New("docs")
	}
	if m.References < 0 || m.References > 1 || (m.References > 0 && m.Kind != mediaKindImage) {
		return errors.New("references")
	}
	if len(m.Params) > maxMediaParams {
		return errors.New("too many parameters")
	}
	names := map[string]bool{}
	for i := range m.Params {
		p := &m.Params[i]
		if !mediaParamName.MatchString(p.Name) || reservedMediaParams[p.Name] || names[p.Name] || jimengFlagFor[p.Name] == "" ||
			(p.Name == "duration" && m.Kind != mediaKindVideo) || !cleanCatalogText(p.Label[0], 40) || !cleanCatalogText(p.Label[1], 40) {
			return fmt.Errorf("parameter %q", p.Name)
		}
		names[p.Name] = true
		if err := validMediaParamSpec(p); err != nil {
			return fmt.Errorf("parameter %q: %w", p.Name, err)
		}
	}
	return validMediaParamRequires(m.Params)
}

// jimengRequest is one generation as the client reads it: the canonical model, the mode, the words (with a literal
// "{{" escaped, since the CLI reads {{node:…}} and {{res:…}} as references), the resolved choices as CLI flags and the
// run it belongs to. With reference pictures (their "<canvas>/<resource>" ids) an image model edits them (mode i2i) on
// the canvas they were uploaded to.
func jimengRequest(m *mediaModel, prompt string, params map[string]any, runID string, references []string) map[string]any {
	flags := []string{}
	for _, p := range m.Params {
		value, ok := params[p.Name]
		if !ok {
			continue
		}
		if text := jimengFlagValue(value); text != "" {
			flags = append(flags, jimengFlagFor[p.Name], text)
		}
	}
	body := map[string]any{"kind": m.Kind, "model": m.Version, "mode": jimengTextModes[m.Kind], "prompt": jimengPromptText(prompt),
		"flags": flags, "run": runID, "refs": []string{}}
	if len(references) > 0 && m.References > 0 {
		refs := []string{}
		canvas := ""
		for _, id := range references[:min(len(references), m.References)] {
			project, resource, ok := strings.Cut(id, "/")
			if !ok || !jimengUUIDPattern.MatchString(project) || !jimengUUIDPattern.MatchString(resource) || (canvas != "" && project != canvas) {
				continue
			}
			canvas = project
			refs = append(refs, resource)
		}
		if len(refs) > 0 {
			body["mode"], body["refs"], body["project"] = "i2i", refs, canvas
		}
	}
	return body
}

func jimengFlagValue(value any) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case int:
		return strconv.Itoa(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
}

// jimengPromptText escapes the CLI's reference markup: a user's literal "{{" must stay text.
func jimengPromptText(prompt string) string {
	return strings.ReplaceAll(strings.TrimSpace(prompt), "{{", `\{{`)
}

// jimengUUID is a stable, RFC 4122 shaped (version 5 layout) id for a name: the same run always submits under the same
// ids, which is what makes a resend the same operation.
func jimengUUID(name string) string {
	sum := sha256.Sum256([]byte("awwo-jimeng/" + name))
	b := sum[:16]
	b[6] = b[6]&0x0f | 0x50
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// jimengNodeID is a run's stable canvas node id: node_ and ten Crockford Base32 characters.
func jimengNodeID(runID string) string {
	sum := sha256.Sum256([]byte("awwo-jimeng/node/" + runID))
	v := binary.BigEndian.Uint64(sum[:8])
	out := make([]byte, 10)
	for i := range out {
		out[i] = crockfordBase32[v&31]
		v >>= 5
	}
	return "node_" + string(out)
}

// jimengRunner executes the CLI once with args (without the binary) and returns what it printed and its exit code.
// err is set only when the process could not be run or was stopped (its context ended).
type jimengRunner func(ctx context.Context, args []string) (stdout, stderr []byte, exit int, err error)

type jimengClient struct {
	cli, home, state, profile, scratch string
	ceiling                            int
	maxFile                            int64
	run                                jimengRunner
	now                                func() time.Time
	slots                              chan struct{}
	mu                                 sync.Mutex
	canvases                           map[string]bool
	refreshed                          time.Time
	log                                *slog.Logger
}

func newJimeng(c Config) *jimengClient {
	j := &jimengClient{cli: c.JimengCLI, home: c.JimengHome, state: c.JimengStateDir, profile: c.JimengProfile, ceiling: c.JimengCreditCeiling,
		maxFile: c.MediaMaxFileBytes, scratch: filepath.Join(c.MediaDir, ".tmp"), now: time.Now, slots: make(chan struct{}, jimengConcurrency),
		canvases: map[string]bool{}, log: slog.Default()}
	j.run = j.execute
	return j
}

func (j *jimengClient) fileLimit() int64 { return j.maxFile }

// environ is all the CLI process sees: where its sign-in and records live, a search path, and a UTF-8 locale. On
// Windows (development) the variables a Windows program needs to start are passed too.
func (j *jimengClient) environ() []string {
	path := "/usr/local/bin:/usr/bin:/bin"
	if runtime.GOOS == "windows" {
		path = os.Getenv("PATH")
	}
	env := []string{"HOME=" + j.home, "DREAMINA_CANVAS_STATE_DIR=" + j.state, "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "PATH=" + path,
		"XDG_CONFIG_HOME=" + filepath.Join(j.home, ".config"), "XDG_DATA_HOME=" + filepath.Join(j.home, ".local", "share"),
		"XDG_CACHE_HOME=" + filepath.Join(j.home, ".cache")}
	for _, name := range []string{"SSL_CERT_FILE", "SSL_CERT_DIR", "TZ"} {
		if v := os.Getenv(name); v != "" {
			env = append(env, name+"="+v)
		}
	}
	if runtime.GOOS == "windows" {
		for _, name := range []string{"SystemRoot", "SYSTEMROOT", "windir", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "COMPUTERNAME", "USERNAME"} {
			if v := os.Getenv(name); v != "" {
				env = append(env, name+"="+v)
			}
		}
	}
	return env
}

// limitedBuffer keeps the first limit bytes written to it and counts the rest, so a misbehaving CLI cannot fill memory.
type limitedBuffer struct {
	limit int
	buf   bytes.Buffer
	over  bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.limit - b.buf.Len(); room > 0 {
		if len(p) > room {
			b.buf.Write(p[:room])
			b.over = true
		} else {
			b.buf.Write(p)
		}
	} else if len(p) > 0 {
		b.over = true
	}
	return len(p), nil
}

func (j *jimengClient) execute(ctx context.Context, args []string) ([]byte, []byte, int, error) {
	cmd := exec.CommandContext(ctx, j.cli, args...)
	cmd.Env = j.environ()
	cmd.Dir = j.home
	cmd.Stdin = nil
	stdout, stderr := &limitedBuffer{limit: jimengOutputLimit}, &limitedBuffer{limit: jimengOutputLimit}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	if stdout.over || stderr.over {
		return nil, nil, -1, jimengMalformed()
	}
	var exit *exec.ExitError
	switch {
	case err == nil:
		return stdout.buf.Bytes(), stderr.buf.Bytes(), 0, nil
	case ctx.Err() != nil:
		return stdout.buf.Bytes(), stderr.buf.Bytes(), -1, ctx.Err()
	case errors.As(err, &exit):
		return stdout.buf.Bytes(), stderr.buf.Bytes(), exit.ExitCode(), nil
	}
	return nil, nil, -1, &rhError{Code: "media_provider_unavailable", Transient: true}
}

// jimengEnvelope is the CLI's JSON answer, printed on stdout on success and on stderr on failure.
type jimengEnvelope struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error *jimengFault    `json:"error"`
	Meta  struct {
		RequestID string `json:"requestId"`
	} `json:"meta"`
}

type jimengFault struct {
	Code           string `json:"code"`
	Class          string `json:"class"`
	Retryable      bool   `json:"retryable"`
	RequiredAction string `json:"requiredAction"`
	Validation     *struct {
		ReasonCode string `json:"reasonCode"`
	} `json:"validation"`
}

// call runs one CLI command under the shared slots and returns its data. A sign-in that lapsed is refreshed once and
// the command sent again, which is safe for every command here: each one either reads or names its operation by id.
func (j *jimengClient) call(ctx context.Context, timeout time.Duration, args ...string) (json.RawMessage, error) {
	data, err := j.callOnce(ctx, timeout, args)
	if e, ok := asRHError(err); ok && e.Code == "media_provider_unauthorized" && j.refresh(ctx, true) {
		data, err = j.callOnce(ctx, timeout, args)
	}
	return data, err
}

func (j *jimengClient) callOnce(ctx context.Context, timeout time.Duration, args []string) (json.RawMessage, error) {
	select {
	case j.slots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-j.slots }()
	run, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	full := append([]string{"--format", "json", "--non-interactive", "--profile", j.profile}, args...)
	stdout, stderr, exit, err := j.run(run, full)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			return nil, &rhError{Code: "media_provider_unavailable", Transient: true}
		}
		return nil, err
	}
	env, ok := parseJimengEnvelope(stdout)
	if !ok {
		env, ok = parseJimengEnvelope(stderr)
	}
	if !ok {
		if exit == 0 {
			err = jimengMalformed()
		} else {
			err = jimengFailure(exit, nil)
		}
		j.logFailure(args, exit, nil, "", err)
		return nil, err
	}
	if exit == 0 && env.OK && env.Error == nil {
		return env.Data, nil
	}
	err = jimengFailure(exit, env.Error)
	j.logFailure(args, exit, env.Error, env.Meta.RequestID, err)
	return nil, err
}

// logFailure records a failed CLI call by its structured fields alone: the command, the exit code, the CLI's error
// code, class, required action and request id, and the closed code AwwO made of it, so a failure on the host can be
// told apart afterwards. Never the CLI's message (it can echo a prompt) and never an argument (a prompt is one).
// A passing failure, which is sent again, is information; any other is a warning.
func (j *jimengClient) logFailure(args []string, exit int, fault *jimengFault, requestID string, err error) {
	if j.log == nil {
		return
	}
	clean := func(s string) string { return jimengLogText.ReplaceAllString(s[:min(len(s), 64)], "") }
	command := ""
	for i := 0; i < min(len(args), 2) && !strings.HasPrefix(args[i], "-"); i++ {
		command = strings.TrimSpace(command + " " + clean(args[i]))
	}
	attrs := []any{"event", "jimeng_cli_failed", "command", command, "exit", exit, "code", mediaFailureCode(err)}
	if fault != nil {
		attrs = append(attrs, "cli_code", clean(fault.Code), "cli_class", clean(fault.Class), "retryable", fault.Retryable,
			"required_action", clean(fault.RequiredAction))
	}
	if requestID != "" {
		attrs = append(attrs, "request_id", clean(requestID))
	}
	if e, ok := asRHError(err); ok && e.Transient {
		j.log.Info("Jimeng CLI call failed", attrs...)
		return
	}
	j.log.Warn("Jimeng CLI call failed", attrs...)
}

func parseJimengEnvelope(raw []byte) (jimengEnvelope, bool) {
	var env jimengEnvelope
	start := bytes.IndexByte(raw, '{')
	if start < 0 || json.Unmarshal(bytes.TrimSpace(raw[start:]), &env) != nil {
		return env, false
	}
	return env, env.OK || env.Error != nil
}

// jimengFailure reduces a CLI failure to a closed media code: its exit code first (the schema's declared classes),
// then its error class, code and required action. The message is never read.
func jimengFailure(exit int, fault *jimengFault) error {
	var code, class, action, reason string
	retryable := false
	if fault != nil {
		code, class, action = strings.ToLower(fault.Code), strings.ToLower(fault.Class), strings.ToLower(fault.RequiredAction)
		retryable = fault.Retryable
		if fault.Validation != nil {
			reason = strings.ToUpper(fault.Validation.ReasonCode)
		}
	}
	has := func(text string, words ...string) bool {
		for _, w := range words {
			if strings.Contains(text, w) {
				return true
			}
		}
		return false
	}
	switch {
	case has(code+" "+class+" "+reason, "content", "safety", "sensitive", "moderation", "risk", "audit", "policy_violation", "illegal"):
		return &rhError{Code: "media_content_rejected"}
	case has(code+" "+class, "insufficient", "balance", "credit_exhaust", "credits_exhaust", "quota_exceeded"):
		return &rhError{Code: "media_provider_balance"}
	case exit == 10 || has(class, "confirmation") || action == "confirm":
		// The quote is above the approved ceiling: the node is saved, nothing is generated or charged.
		return &rhError{Code: "media_credit_ceiling"}
	case exit == 11 || class == "auth_required" || action == "login":
		return &rhError{Code: "media_provider_unauthorized"}
	case exit == 12 || exit == 13 || has(class, "permission", "entitlement", "forbidden", "membership"):
		return &rhError{Code: "media_provider_unauthorized"}
	case has(code, "submission_absent", "not_found", "notfound"):
		return &rhError{Code: "media_task_missing", Transient: true}
	case exit == 20 || class == "operation_incomplete" || action == "resume" || action == "wait":
		return &rhError{Code: "media_pending"}
	case exit == 2 || class == "invalid_input" || class == "validation":
		return &rhError{Code: "media_params_invalid"}
	case retryable || exit == 21 || has(class, "retryable", "transient", "unavailable", "timeout", "rate_limit", "busy"):
		return &rhError{Code: "media_provider_busy", Transient: true}
	}
	return &rhError{Code: "media_failed"}
}

// refresh renews the CLI's sign-in at most once an hour (force: now, after a call found it lapsed). It reports whether
// a refresh succeeded.
func (j *jimengClient) refresh(ctx context.Context, force bool) bool {
	j.mu.Lock()
	due := force || j.now().Sub(j.refreshed) > jimengRefreshEvery
	if due {
		j.refreshed = j.now()
	}
	j.mu.Unlock()
	if !due {
		return false
	}
	_, err := j.callOnce(ctx, jimengQueryTimeout, []string{"auth", "refresh"})
	return err == nil
}

// canvasFor is the day's Jimeng canvas, made once per day and process: its id is derived from the profile and the UTC
// date, and the CLI makes a canvas under a client-chosen id idempotently, so a second process or a restart lands on the
// same canvas.
func (j *jimengClient) canvasFor(ctx context.Context) (string, error) {
	day := j.now().UTC().Format("2006-01-02")
	id := jimengUUID("canvas/" + j.profile + "/" + day)
	j.mu.Lock()
	made := j.canvases[id]
	j.mu.Unlock()
	if made {
		return id, nil
	}
	if _, err := j.call(ctx, jimengQueryTimeout, "canvas", "create", jimengCanvasNameStart+day, "--project-id", id); err != nil {
		// A canvas that already exists may answer as a conflict; the node saved on it next is what proves it.
		if e, ok := asRHError(err); !ok || e.Code != "media_params_invalid" && e.Code != "media_failed" {
			return "", err
		}
	}
	j.mu.Lock()
	j.canvases[id] = true
	j.mu.Unlock()
	return id, nil
}

// submit saves and runs the generation's node in one call. The node, its save and its run are named after the AwwO
// run, so sending it again (an answer lost in transit, a busy answer, a restart) repeats the same operation: Jimeng
// answers it without a second generation or charge, which is why every transient failure here is safe to resend.
// The caller's short HTTP send timeout does not fit the CLI's save, quote, approve and run, so the call has its own.
func (j *jimengClient) submit(ctx context.Context, endpoint string, body map[string]any) (rhTask, error) {
	kind, _ := body["kind"].(string)
	model, _ := body["model"].(string)
	mode, _ := body["mode"].(string)
	prompt, _ := body["prompt"].(string)
	runID, _ := body["run"].(string)
	flags, _ := body["flags"].([]string)
	refs, _ := body["refs"].([]string)
	if jimengEndpoints[kind] != endpoint || !jimengCanonical.MatchString(model) || runID == "" || !mediaPathPart.MatchString(runID) ||
		strings.TrimSpace(prompt) == "" || strings.ContainsRune(prompt, 0) || !jimengAllowedMode(kind, mode, len(refs)) {
		return rhTask{}, &rhError{Code: "media_request_invalid"}
	}
	for i := 0; i < len(flags); i += 2 {
		if i+1 >= len(flags) || !jimengKnownFlag(flags[i]) || !cleanCatalogText(flags[i+1], 40) || strings.HasPrefix(flags[i+1], "-") {
			return rhTask{}, &rhError{Code: "media_request_invalid"}
		}
	}
	work, cancel := context.WithTimeout(context.WithoutCancel(ctx), jimengSubmitTimeout)
	defer cancel()
	j.refresh(work, false)
	canvas, _ := body["project"].(string)
	if canvas == "" {
		var err error
		if canvas, err = j.canvasFor(work); err != nil {
			return rhTask{}, jimengResendable(err)
		}
	}
	if !jimengUUIDPattern.MatchString(canvas) {
		return rhTask{}, &rhError{Code: "media_request_invalid"}
	}
	submitID := jimengUUID("submit/" + runID)
	args := []string{"node", "create", kind, "--project-id", canvas, "--node-id", jimengNodeID(runID), "--update-id", jimengUUID("update/" + runID),
		"--submit-id", submitID, "--title", "AwwO " + runID[:min(len(runID), 12)], "--mode", mode, "--model", model, "--prompt", prompt,
		"--count", "1", "--run", "--credit-ceiling", strconv.Itoa(j.ceiling)}
	args = append(args, flags...)
	for _, ref := range refs {
		args = append(args, "--ref", "res:"+ref)
	}
	if _, err := j.call(work, jimengSubmitTimeout, args...); err != nil {
		return rhTask{}, jimengResendable(err)
	}
	return rhTask{TaskID: canvas + ":" + submitID, Status: "QUEUED"}, nil
}

func jimengAllowedMode(kind, mode string, refs int) bool {
	if refs > 0 {
		return kind == mediaKindImage && mode == "i2i"
	}
	return mode == jimengTextModes[kind]
}

func jimengKnownFlag(flag string) bool {
	for _, known := range jimengFlagFor {
		if flag == known {
			return true
		}
	}
	return false
}

// jimengResendable marks a transient submission failure as safe to send again after a wait: the run's ids make a
// repeat the same operation. Every other error is returned unchanged.
func jimengResendable(err error) error {
	if e, ok := asRHError(err); ok && e.Transient {
		e.RetryAfter = jimengResendWait
	}
	return err
}

// query reads the operation once: queued and running keep the caller polling, a success lists its finished resources
// as downloads, and every other state is a closed failure code.
func (j *jimengClient) query(ctx context.Context, taskID string) (rhTask, error) {
	canvas, submitID, ok := strings.Cut(taskID, ":")
	if !ok || !jimengUUIDPattern.MatchString(canvas) || !jimengUUIDPattern.MatchString(submitID) {
		return rhTask{}, &rhError{Code: "media_task_missing"}
	}
	data, err := j.call(ctx, jimengQueryTimeout, "operation", "status", submitID, "--project-id", canvas)
	if err != nil {
		return rhTask{}, err
	}
	return parseJimengStatus(data, taskID, canvas)
}

func parseJimengStatus(data json.RawMessage, taskID, canvas string) (rhTask, error) {
	var v struct {
		State     string `json:"state"`
		Resources []struct {
			ResourceID string `json:"resourceId"`
			State      string `json:"state"`
		} `json:"resources"`
		SubmissionError *struct {
			Reason string `json:"reason"`
		} `json:"submissionError"`
		AwaitingConfirmation json.RawMessage `json:"awaitingConfirmation"`
	}
	if json.Unmarshal(data, &v) != nil {
		return rhTask{}, jimengMalformed()
	}
	task := rhTask{TaskID: taskID}
	state := strings.ToLower(strings.TrimSpace(v.State))
	switch state {
	case "queued", "pending", "submitted", "accepted", "waiting", "created", "dispatched":
		task.Status = "QUEUED"
	case "running", "processing", "generating", "in_progress", "started":
		task.Status = "RUNNING"
	case "succeeded", "success", "completed", "partial_success", "partially_succeeded":
		task.Status = "SUCCESS"
		for _, r := range v.Resources {
			rs := strings.ToLower(strings.TrimSpace(r.State))
			if rs != "" && rs != "succeeded" && rs != "success" {
				continue
			}
			if !jimengUUIDPattern.MatchString(r.ResourceID) {
				return task, &rhError{Code: "media_result_refused"}
			}
			task.Results = append(task.Results, rhResult{URL: "jimeng:" + canvas + "/" + r.ResourceID, OutputType: "file"})
			if len(task.Results) == rhMaxResults {
				break
			}
		}
		if len(task.Results) == 0 {
			return task, &rhError{Code: "media_no_output"}
		}
	case "awaiting_confirmation", "confirmation_required":
		return task, &rhError{Code: "media_credit_ceiling", Unbilled: true}
	case "failed", "error", "canceled", "cancelled", "rejected", "expired", "blocked":
		failure := &rhError{Code: "media_failed", Unbilled: true}
		reason := ""
		if v.SubmissionError != nil {
			reason = strings.ToLower(v.SubmissionError.Reason)
		}
		switch {
		case state == "expired":
			failure.Code = "media_result_unavailable"
		case state == "rejected" || state == "blocked" || strings.Contains(reason, "content") || strings.Contains(reason, "risk") ||
			strings.Contains(reason, "sensitive") || strings.Contains(reason, "audit") || strings.Contains(reason, "safety"):
			failure.Code = "media_content_rejected"
		case strings.Contains(reason, "credit") || strings.Contains(reason, "balance") || strings.Contains(reason, "insufficient"):
			failure.Code = "media_provider_balance"
		}
		return task, failure
	default:
		if len(bytes.TrimSpace(v.AwaitingConfirmation)) > 0 && string(bytes.TrimSpace(v.AwaitingConfirmation)) != "null" {
			return task, &rhError{Code: "media_credit_ceiling", Unbilled: true}
		}
		return task, jimengMalformed()
	}
	return task, nil
}

// download fetches one finished resource into a private scratch file with `resource download` and streams it to w.
// Only the exact jimeng:<canvas>/<resource> addresses parseJimengStatus builds are accepted.
func (j *jimengClient) download(ctx context.Context, raw string, w io.Writer) (int64, error) {
	rest, ok := strings.CutPrefix(raw, "jimeng:")
	canvas, resource, cut := strings.Cut(rest, "/")
	if !ok || !cut || !jimengUUIDPattern.MatchString(canvas) || !jimengUUIDPattern.MatchString(resource) {
		return 0, &rhError{Code: "media_result_refused"}
	}
	if os.MkdirAll(j.scratch, 0o750) != nil {
		return 0, &rhError{Code: "media_storage_failed"}
	}
	dir, err := os.MkdirTemp(j.scratch, "jimeng-*")
	if err != nil {
		return 0, &rhError{Code: "media_storage_failed"}
	}
	defer os.RemoveAll(dir)
	target := filepath.Join(dir, "result")
	var data json.RawMessage
	for try := 1; ; try++ {
		_ = os.Remove(target)
		data, err = j.call(ctx, 15*time.Minute, "resource", "download", resource, "--project-id", canvas, "--output", target)
		e, known := asRHError(err)
		if err == nil || !known || e.Code == "media_provider_unauthorized" || try >= jimengDownloadTries || ctx.Err() != nil {
			break
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(time.Duration(try) * jimengDownloadWait):
		}
	}
	if err != nil {
		if e, ok := asRHError(err); ok && (e.Code == "media_params_invalid" || e.Code == "media_failed") {
			return 0, &rhError{Code: "media_result_unavailable", Transient: true}
		}
		return 0, err
	}
	var saved struct {
		Path string `json:"path"`
		Size int64  `json:"size"`
	}
	_ = json.Unmarshal(data, &saved)
	path := target
	if saved.Path != "" && filepath.Clean(saved.Path) != target {
		// The CLI names the file itself only when given a directory; anything outside this scratch directory is refused.
		if clean := filepath.Clean(saved.Path); filepath.Dir(clean) == dir {
			path = clean
		} else {
			return 0, &rhError{Code: "media_result_refused"}
		}
	}
	file, err := os.Open(path)
	if err != nil {
		return 0, &rhError{Code: "media_result_unavailable", Transient: true}
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return 0, &rhError{Code: "media_result_unavailable", Transient: true}
	}
	if info.Size() > j.maxFile {
		return 0, &rhError{Code: "media_result_too_large"}
	}
	n, err := io.Copy(w, io.LimitReader(file, j.maxFile+1))
	if err != nil {
		return n, &rhError{Code: "media_storage_failed"}
	}
	if n > j.maxFile {
		return n, &rhError{Code: "media_result_too_large"}
	}
	return n, nil
}

// existingReference names a picture this account's own earlier generation made by its resource on Jimeng's canvas,
// so an image-to-image run takes it as res:<id> there without uploading it again: taskID is that run's
// "<canvas>:<submit id>" and index the result's place (its artifact's media-N). Read only, free; any doubt (the
// task no longer reports success, no such result) returns false and the picture is uploaded as before.
func (j *jimengClient) existingReference(ctx context.Context, taskID string, index int) (string, bool) {
	task, err := j.query(ctx, taskID)
	if err != nil || task.Status != "SUCCESS" || index < 1 || index > len(task.Results) {
		return "", false
	}
	rest, ok := strings.CutPrefix(task.Results[index-1].URL, "jimeng:")
	canvas, resource, cut := strings.Cut(rest, "/")
	if !ok || !cut || !jimengUUIDPattern.MatchString(canvas) || !jimengUUIDPattern.MatchString(resource) {
		return "", false
	}
	return canvas + "/" + resource, true
}

// uploadReference puts one reference picture on the day's canvas with `resource upload`, under a resource id derived
// from the run and the picture, so a repeated upload of the same run is the same resource. It returns
// "<canvas>/<resource>", which jimengRequest turns into the node's res: reference on that canvas.
func (j *jimengClient) uploadReference(ctx context.Context, ref mediaReference, data []byte, runID string) (string, error) {
	if !mediaReferenceTypes[mediaProviderJimeng][ref.ContentType] || len(data) == 0 || len(data) > maxMediaReferenceBytes || len(ref.SHA256) < 16 {
		return "", &rhError{Code: "media_reference_unavailable"}
	}
	work, cancel := context.WithTimeout(ctx, jimengUploadTimeout)
	defer cancel()
	j.refresh(work, false)
	canvas, err := j.canvasFor(work)
	if err != nil {
		return "", err
	}
	if os.MkdirAll(j.scratch, 0o750) != nil {
		return "", &rhError{Code: "media_reference_unavailable"}
	}
	dir, err := os.MkdirTemp(j.scratch, "jimeng-ref-*")
	if err != nil {
		return "", &rhError{Code: "media_reference_unavailable"}
	}
	defer os.RemoveAll(dir)
	name := referenceFileName(ref.ContentType)
	path := filepath.Join(dir, name)
	if os.WriteFile(path, data, 0o600) != nil {
		return "", &rhError{Code: "media_reference_unavailable"}
	}
	resource := jimengUUID("reference/" + runID + "/" + ref.SHA256[:16])
	answer, err := j.call(work, jimengUploadTimeout, "resource", "upload", "--file", path, "--type", "image", "--project-id", canvas,
		"--resource-id", resource, "--name", name, "--import-kind", "local_upload")
	if err != nil {
		if e, ok := asRHError(err); ok && !e.Transient && e.Code != "media_provider_unauthorized" {
			return "", &rhError{Code: "media_reference_unavailable"}
		}
		return "", err
	}
	var uploaded struct {
		ResourceID string `json:"resourceId"`
	}
	if json.Unmarshal(answer, &uploaded) != nil || uploaded.ResourceID != resource {
		return "", &rhError{Code: "media_reference_unavailable"}
	}
	return canvas + "/" + resource, nil
}

// jimengCredits prices a Jimeng generation for a paid plan from what Jimeng itself quoted on 2026-10-12, at three AwwO
// credits per Jimeng credit (the markup X-tasy's models carry), never below the 30 every image costs elsewhere.
// Quoted: the express picture 1 credit at 2K, the cinematic picture 8; 4K is priced at twice 2K. Video per second:
// cinematic 20 at 720p and 64 at 1080p (480p as half of 720p), express 6 at 720p.
func jimengCredits(model string, params map[string]any) (int, bool) {
	const perJimengCredit = 3
	text := func(name string) string { return strings.ToLower(jimengFlagValue(params[name])) }
	seconds := 5.0
	if d, err := strconv.ParseFloat(text("duration"), 64); err == nil && d > 0 {
		seconds = d
	}
	var jimeng float64
	switch model {
	case "jm.image-express", "jm.image-cinema":
		jimeng = map[string]float64{"jm.image-express": 1, "jm.image-cinema": 8}[model]
		if text("resolution") == "4k" {
			jimeng *= 2
		}
		return max(30, int(jimeng*perJimengCredit+0.999)), true
	case "jm.video-cinema":
		perSecond := map[string]float64{"480p": 10, "720p": 20, "1080p": 64}[text("resolution")]
		if perSecond == 0 {
			perSecond = 64
		}
		jimeng = perSecond * seconds
	case "jm.video-express":
		jimeng = 6 * seconds
	default:
		return 0, false
	}
	return max(30, int(jimeng*perJimengCredit+0.999)), true
}
