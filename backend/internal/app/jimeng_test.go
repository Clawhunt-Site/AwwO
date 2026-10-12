package app

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeJimengCLI stands in for dreamina-canvas: it records every argument vector and answers through handle.
type fakeJimengCLI struct {
	mu     sync.Mutex
	calls  [][]string
	handle func(args []string) (stdout, stderr string, exit int)
}

func (f *fakeJimengCLI) run(_ context.Context, args []string) ([]byte, []byte, int, error) {
	f.mu.Lock()
	f.calls = append(f.calls, append([]string(nil), args...))
	handle := f.handle
	f.mu.Unlock()
	stdout, stderr, exit := handle(args)
	return []byte(stdout), []byte(stderr), exit, nil
}

func (f *fakeJimengCLI) commands() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []string{}
	for _, c := range f.calls {
		// Skip the global flags: --format json --non-interactive --profile <name>.
		out = append(out, strings.Join(c[5:min(len(c), 8)], " "))
	}
	return out
}

func flagValue(args []string, flag string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag {
			return args[i+1]
		}
	}
	return ""
}

func okEnvelope(data any) string {
	raw, _ := json.Marshal(map[string]any{"schemaVersion": "1", "ok": true, "data": data})
	return string(raw)
}

func errEnvelope(code, class, action string, retryable bool) string {
	raw, _ := json.Marshal(map[string]any{"schemaVersion": "1", "ok": false,
		"error": map[string]any{"code": code, "class": class, "requiredAction": action, "retryable": retryable, "message": "secret prompt text"}})
	return string(raw)
}

func testJimengClient(t *testing.T, cli *fakeJimengCLI) *jimengClient {
	t.Helper()
	media := t.TempDir()
	c := testConfig()
	c.MediaDir, c.MediaMaxFileBytes = media, 1<<20
	c.JimengCLI, c.JimengHome, c.JimengProfile, c.JimengCreditCeiling = filepath.Join(t.TempDir(), "dreamina-canvas"), t.TempDir(), "awwo", 700
	c.JimengStateDir = filepath.Join(c.JimengHome, "state")
	j := newJimeng(c)
	j.run = cli.run
	j.now = func() time.Time { return time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC) }
	return j
}

func TestJimengModelsAreInTheCatalogAndClosed(t *testing.T) {
	kinds := map[string]int{}
	for i, want := range jimengModels() {
		m, ok := builtinMediaCatalog.model(want.ID)
		if !ok || m.Provider != mediaProviderJimeng || m.Endpoint != jimengEndpoints[m.Kind] || !jimengCanonical.MatchString(m.Version) {
			t.Fatal("jimeng model missing or wrong", want.ID, m)
		}
		if builtinMediaCatalog.List()[i].ID != want.ID {
			t.Fatal("Jimeng's models lead the catalog, in their own order", i, builtinMediaCatalog.List()[i].ID)
		}
		if _, priced := jimengCredits(m.ID, map[string]any{}); !priced {
			t.Fatal("every Jimeng model has its own price", m.ID)
		}
		if strings.Contains(strings.ToLower(m.ID), "seed") || strings.Contains(strings.ToLower(m.ID), "dreamina") {
			t.Fatal("a Jimeng model id names its model family", m.ID)
		}
		kinds[m.Kind]++
	}
	if kinds[mediaKindImage] != 2 || kinds[mediaKindVideo] != 2 {
		t.Fatal("two image and two video models", kinds)
	}
	unmapped := *jimengModels()[0]
	unmapped.Params = append(append([]mediaParam(nil), unmapped.Params...), mediaParam{Name: "seed", Type: "integer", Min: new(float64), Max: new(float64), Label: [2]string{"a", "b"}})
	if validJimengModel(&unmapped) == nil {
		t.Fatal("a parameter the CLI has no flag for must be refused")
	}
	shell := *jimengModels()[1]
	shell.Version = "seedream_4.7; rm -rf /"
	if validJimengModel(&shell) == nil {
		t.Fatal("a canonical model name must be a plain name")
	}
	videoRef := *jimengModels()[2]
	videoRef.References = 1
	if validJimengModel(&videoRef) == nil {
		t.Fatal("no Jimeng video model takes a reference yet")
	}
	cinema, _ := builtinMediaCatalog.model("jm.video-cinema")
	for _, raw := range []string{`{"duration":16}`, `{"duration":3}`, `{"resolution":"4k"}`, `{"aspectRatio":"adaptive"}`} {
		if _, err := cinema.resolveMediaParams(json.RawMessage(raw)); err == nil {
			t.Fatal("accepted", raw)
		}
	}
}

func TestJimengRequestFlagsEscapesAndReferences(t *testing.T) {
	video, _ := builtinMediaCatalog.model("jm.video-cinema")
	params, err := video.resolveMediaParams(json.RawMessage(`{"duration":8,"resolution":"1080p"}`))
	if err != nil {
		t.Fatal(err)
	}
	body := jimengRequest(video, "  a {{node:node_x}} lake  ", params, "run1", nil)
	if body["kind"] != mediaKindVideo || body["model"] != "seedance_2.5" || body["mode"] != "t2v" || body["run"] != "run1" ||
		body["prompt"] != `a \{{node:node_x}} lake` || body["project"] != nil {
		t.Fatal("body", body)
	}
	if got := strings.Join(body["flags"].([]string), " "); got != "--ratio 16:9 --resolution 1080p --duration 8" {
		t.Fatal("flags", got)
	}
	image, _ := builtinMediaCatalog.model("jm.image-express")
	imageParams, _ := image.resolveMediaParams(nil)
	canvas, res := jimengUUID("canvas/x"), jimengUUID("res/y")
	edit := jimengRequest(image, "make it blue", imageParams, "run2", []string{canvas + "/" + res, canvas + "/" + jimengUUID("res/z")})
	if edit["mode"] != "i2i" || edit["project"] != canvas || len(edit["refs"].([]string)) != 1 || edit["refs"].([]string)[0] != res {
		t.Fatal("an image model edits its one reference on its canvas", edit)
	}
	if bad := jimengRequest(image, "a cat", imageParams, "run3", []string{"../etc/passwd"}); bad["mode"] != "t2i" || len(bad["refs"].([]string)) != 0 {
		t.Fatal("a reference that is not canvas/resource is never sent", bad)
	}
	if words := jimengRequest(video, "a cat", params, "run4", []string{canvas + "/" + res}); words["mode"] != "t2v" || len(words["refs"].([]string)) != 0 {
		t.Fatal("a model that takes no reference never sends one", words)
	}
}

func TestJimengIDsAreStableAndOfTheCLIsShape(t *testing.T) {
	uuid := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	if a, b := jimengUUID("submit/r1"), jimengUUID("submit/r1"); a != b || !uuid.MatchString(a) || a == jimengUUID("submit/r2") {
		t.Fatal("uuid", a, b)
	}
	node := regexp.MustCompile(`^node_[0-9abcdefghjkmnpqrstvwxyz]{10}$`)
	if n := jimengNodeID("r1"); !node.MatchString(n) || n != jimengNodeID("r1") || n == jimengNodeID("r2") {
		t.Fatal("node id", n)
	}
}

// One generation is one call: the node is saved and run on the day's canvas under ids derived from the run, with the
// credit ceiling, every value its own argument; sending it again repeats exactly the same call.
func TestJimengSubmitRunsTheCLIWithStableIdsAndTheCeiling(t *testing.T) {
	cli := &fakeJimengCLI{handle: func(args []string) (string, string, int) {
		if args[5] == "auth" {
			return okEnvelope(map[string]any{"loggedIn": true}), "", 0
		}
		if args[5] == "canvas" {
			return okEnvelope(map[string]any{"project": map[string]any{"projectId": flagValue(args, "--project-id")}}), "", 0
		}
		return okEnvelope(map[string]any{"node": map[string]any{"nodeId": flagValue(args, "--node-id")}}), "", 0
	}}
	j := testJimengClient(t, cli)
	image, _ := builtinMediaCatalog.model("jm.image-cinema")
	params, _ := image.resolveMediaParams(json.RawMessage(`{"resolution":"4K","aspectRatio":"21:9"}`))
	prompt := `a "quoted"; $(rm -rf /) prompt`
	body := jimengRequest(image, prompt, params, "runA", nil)
	first, err := j.submit(context.Background(), jimengEndpoints[mediaKindImage], body)
	if err != nil {
		t.Fatal(err)
	}
	second, err := j.submit(context.Background(), jimengEndpoints[mediaKindImage], body)
	if err != nil || first.TaskID != second.TaskID {
		t.Fatal("a resend names the same operation", first, second, err)
	}
	canvas := jimengUUID("canvas/awwo/2026-10-12")
	if first.TaskID != canvas+":"+jimengUUID("submit/runA") {
		t.Fatal("task id is <canvas>:<submit id>", first.TaskID)
	}
	if got := strings.Join(cli.commands(), " | "); got != "auth refresh | canvas create AwwO 媒体 2026-10-12 | node create image | node create image" {
		t.Fatal("calls", got)
	}
	var creates [][]string
	for _, c := range cli.calls {
		if c[0] != "--format" || c[1] != "json" || c[2] != "--non-interactive" || c[3] != "--profile" || c[4] != "awwo" {
			t.Fatal("global flags", c)
		}
		if c[5] == "node" {
			creates = append(creates, c)
		}
	}
	if strings.Join(creates[0], "\x00") != strings.Join(creates[1], "\x00") {
		t.Fatal("the resend is the same call", creates)
	}
	args := creates[0]
	for flag, want := range map[string]string{"--project-id": canvas, "--node-id": jimengNodeID("runA"), "--update-id": jimengUUID("update/runA"),
		"--submit-id": jimengUUID("submit/runA"), "--mode": "t2i", "--model": "seedream_5.0_pro", "--prompt": prompt, "--count": "1",
		"--credit-ceiling": "700", "--ratio": "21:9", "--resolution": "4K"} {
		if got := flagValue(args, flag); got != want {
			t.Fatalf("%s = %q, want %q (%v)", flag, got, want, args)
		}
	}
	if !strings.Contains(strings.Join(args, " "), " --run ") || strings.Contains(strings.Join(args, " "), "--wait") {
		t.Fatal("the node runs without waiting", args)
	}
	// A request the provider did not build is refused before the CLI is touched.
	calls := len(cli.calls)
	for _, bad := range []map[string]any{
		{"kind": "image", "model": "seedream_5.0_pro", "mode": "t2i", "prompt": "x", "run": "../r", "flags": []string{}},
		{"kind": "image", "model": "seedream_5.0_pro", "mode": "t2i", "prompt": "x", "run": "r", "flags": []string{"--output", "/etc/passwd"}},
		{"kind": "image", "model": "seedream_5.0_pro", "mode": "t2i", "prompt": "x", "run": "r", "flags": []string{"--ratio", "--yes"}},
		{"kind": "video", "model": "seedance_2.5", "mode": "i2i", "prompt": "x", "run": "r", "flags": []string{}, "refs": []string{jimengUUID("r")}},
	} {
		if _, err := j.submit(context.Background(), jimengEndpoints[mediaKindImage], bad); mediaFailureCode(err) != "media_request_invalid" {
			t.Fatal("accepted", bad, err)
		}
	}
	if len(cli.calls) != calls {
		t.Fatal("a refused request reached the CLI")
	}
}

func TestJimengFailuresAreClosedCodes(t *testing.T) {
	for _, tc := range []struct {
		stdout, stderr string
		exit           int
		code           string
		transient      bool
	}{
		{"", errEnvelope("cli.credit_confirmation_required", "confirmation_required", "confirm", false), 10, "media_credit_ceiling", false},
		{"", errEnvelope("service.3", "auth_required", "login", false), 11, "media_provider_unauthorized", false},
		{"", errEnvelope("service.1201", "content_rejected", "none", false), 22, "media_content_rejected", false},
		{"", errEnvelope("service.4000", "insufficient_credits", "none", false), 22, "media_provider_balance", false},
		{"", errEnvelope("cli.invalid_command", "invalid_input", "none", false), 2, "media_params_invalid", false},
		{"", errEnvelope("service.503", "retryable_failure", "retry", true), 21, "media_provider_busy", true},
		{"", errEnvelope("cli.operation_submission_absent", "operation_incomplete", "resume", true), 20, "media_task_missing", true},
		{"", errEnvelope("cli.something", "human_required", "contact_support", false), 22, "media_failed", false},
		{"not json at all", "", 1, "media_failed", false},
		{"not json at all", "", 0, "media_provider_unavailable", true},
	} {
		cli := &fakeJimengCLI{handle: func([]string) (string, string, int) { return tc.stdout, tc.stderr, tc.exit }}
		j := testJimengClient(t, cli)
		j.refreshed = j.now()
		_, err := j.callOnce(context.Background(), time.Minute, []string{"operation", "status", jimengUUID("x")})
		e, ok := asRHError(err)
		if !ok || e.Code != tc.code || e.Transient != tc.transient {
			t.Errorf("%d %q: got %v (transient %v), want %s", tc.exit, tc.stderr, err, ok && e.Transient, tc.code)
		}
		if ok && strings.Contains(e.Error(), "secret") {
			t.Error("the CLI's message reached the error")
		}
	}
}

func TestJimengLapsedSignInIsRefreshedOnceAndTheCallRepeated(t *testing.T) {
	statusCalls := 0
	cli := &fakeJimengCLI{}
	cli.handle = func(args []string) (string, string, int) {
		switch args[5] {
		case "auth":
			return okEnvelope(map[string]any{"loggedIn": true}), "", 0
		case "operation":
			statusCalls++
			if statusCalls == 1 {
				return "", errEnvelope("service.3", "auth_required", "login", false), 11
			}
			return okEnvelope(map[string]any{"state": "running"}), "", 0
		}
		return "", "", 1
	}
	j := testJimengClient(t, cli)
	j.refreshed = j.now()
	task, err := j.query(context.Background(), jimengUUID("canvas/c")+":"+jimengUUID("submit/s"))
	if err != nil || task.Status != "RUNNING" || statusCalls != 2 {
		t.Fatal("refresh then repeat", task, err, statusCalls)
	}
	if got := strings.Join(cli.commands(), " | "); got != "operation status "+jimengUUID("submit/s")+" | auth refresh | operation status "+jimengUUID("submit/s") {
		t.Fatal("calls", got)
	}
}

func TestParseJimengStatus(t *testing.T) {
	canvas := jimengUUID("canvas/c")
	id := canvas + ":" + jimengUUID("submit/s")
	for state, want := range map[string]string{"queued": "QUEUED", "submitted": "QUEUED", "running": "RUNNING", "generating": "RUNNING"} {
		raw, _ := json.Marshal(map[string]any{"state": state})
		if task, err := parseJimengStatus(raw, id, canvas); err != nil || task.Status != want {
			t.Fatal(state, task, err)
		}
	}
	res1, res2 := jimengUUID("r1"), jimengUUID("r2")
	raw, _ := json.Marshal(map[string]any{"state": "succeeded", "resources": []any{
		map[string]any{"resourceId": res1, "state": "succeeded"}, map[string]any{"resourceId": res2, "state": "failed"}}})
	task, err := parseJimengStatus(raw, id, canvas)
	if err != nil || task.Status != "SUCCESS" || len(task.Results) != 1 || task.Results[0].URL != "jimeng:"+canvas+"/"+res1 {
		t.Fatal("success keeps the finished resources", task, err)
	}
	evil, _ := json.Marshal(map[string]any{"state": "succeeded", "resources": []any{map[string]any{"resourceId": "../../etc", "state": "succeeded"}}})
	if _, err := parseJimengStatus(evil, id, canvas); mediaFailureCode(err) != "media_result_refused" {
		t.Fatal("a resource id that is not a UUID is refused", err)
	}
	empty, _ := json.Marshal(map[string]any{"state": "succeeded"})
	if _, err := parseJimengStatus(empty, id, canvas); mediaFailureCode(err) != "media_no_output" {
		t.Fatal(err)
	}
	for state, want := range map[string]string{"failed": "media_failed", "canceled": "media_failed", "expired": "media_result_unavailable", "rejected": "media_content_rejected"} {
		raw, _ := json.Marshal(map[string]any{"state": state})
		_, err := parseJimengStatus(raw, id, canvas)
		if e, ok := asRHError(err); !ok || e.Code != want || !e.Unbilled {
			t.Fatal(state, err)
		}
	}
	risky, _ := json.Marshal(map[string]any{"state": "failed", "submissionError": map[string]any{"reason": "content_risk"}})
	if _, err := parseJimengStatus(risky, id, canvas); mediaFailureCode(err) != "media_content_rejected" {
		t.Fatal(err)
	}
	if _, err := parseJimengStatus([]byte(`{"state":"warp"}`), id, canvas); mediaFailureCode(err) != "media_provider_unavailable" {
		t.Fatal("an unknown state is a passing failure", err)
	}
}

// A result is fetched only from an address the provider built, into a private scratch file the CLI writes, and
// streamed out under the file limit; nothing of it is left behind.
func TestJimengDownloadStreamsOnlyTheCLIsOwnFile(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, 256)...)
	var written string
	cli := &fakeJimengCLI{}
	cli.handle = func(args []string) (string, string, int) {
		out := flagValue(args, "--output")
		written = out
		if err := os.WriteFile(out, png, 0o600); err != nil {
			return "", "", 1
		}
		return okEnvelope(map[string]any{"resourceId": args[7], "path": out, "size": len(png)}), "", 0
	}
	j := testJimengClient(t, cli)
	canvas, res := jimengUUID("canvas/c"), jimengUUID("r1")
	var buf bytes.Buffer
	n, err := j.download(context.Background(), "jimeng:"+canvas+"/"+res, &buf)
	if err != nil || n != int64(len(png)) || !bytes.Equal(buf.Bytes(), png) {
		t.Fatal("download", n, err)
	}
	if !strings.HasPrefix(written, j.scratch) {
		t.Fatal("the CLI wrote outside the scratch directory", written)
	}
	if _, err := os.Stat(filepath.Dir(written)); !os.IsNotExist(err) {
		t.Fatal("the scratch directory is removed after the download")
	}
	for _, bad := range []string{"https://evil.test/x", "jimeng:" + canvas + "/../../x", "jimeng:not-a-uuid/" + res, "jimeng:" + canvas} {
		if _, err := j.download(context.Background(), bad, &buf); mediaFailureCode(err) != "media_result_refused" {
			t.Fatal("accepted", bad, err)
		}
	}
	cli.handle = func(args []string) (string, string, int) {
		return okEnvelope(map[string]any{"resourceId": args[7], "path": "/etc/passwd", "size": 10}), "", 0
	}
	if _, err := j.download(context.Background(), "jimeng:"+canvas+"/"+res, &buf); mediaFailureCode(err) != "media_result_refused" {
		t.Fatal("a file the CLI reports outside the scratch directory is never read", err)
	}
	big := bytes.Repeat([]byte{1}, int(j.maxFile)+10)
	cli.handle = func(args []string) (string, string, int) {
		out := flagValue(args, "--output")
		_ = os.WriteFile(out, big, 0o600)
		return okEnvelope(map[string]any{"resourceId": args[7], "path": out}), "", 0
	}
	if _, err := j.download(context.Background(), "jimeng:"+canvas+"/"+res, &bytes.Buffer{}); mediaFailureCode(err) != "media_result_too_large" {
		t.Fatal("a file past the limit is refused", err)
	}
}

func TestJimengUploadReference(t *testing.T) {
	cli := &fakeJimengCLI{}
	var uploaded []byte
	cli.handle = func(args []string) (string, string, int) {
		switch args[5] {
		case "auth", "canvas":
			return okEnvelope(map[string]any{}), "", 0
		}
		uploaded, _ = os.ReadFile(flagValue(args, "--file"))
		return okEnvelope(map[string]any{"resourceId": flagValue(args, "--resource-id"), "mediaType": "image"}), "", 0
	}
	j := testJimengClient(t, cli)
	data := append([]byte("\x89PNG\r\n\x1a\n"), 1, 2, 3)
	ref := testReference(data, "image/png")
	id, err := j.uploadReference(context.Background(), ref, data, "runR")
	canvas := jimengUUID("canvas/awwo/2026-10-12")
	if err != nil || id != canvas+"/"+jimengUUID("reference/runR/"+ref.SHA256[:16]) || !bytes.Equal(uploaded, data) {
		t.Fatal("upload", id, err)
	}
	last := cli.calls[len(cli.calls)-1]
	if flagValue(last, "--name") != "reference.png" || flagValue(last, "--type") != "image" || flagValue(last, "--project-id") != canvas {
		t.Fatal("the picture goes under a neutral name to the day's canvas", last)
	}
	if _, err := j.uploadReference(context.Background(), testReference([]byte("GIF89a"), "image/gif"), []byte("GIF89a"), "runR"); mediaFailureCode(err) != "media_reference_unavailable" {
		t.Fatal("a type Jimeng does not take is refused", err)
	}
}

func TestJimengEnvironmentCarriesNoSecrets(t *testing.T) {
	t.Setenv("AWWO_DATABASE_URL", "postgres://user:secret@db/awwo")
	t.Setenv("AWWO_XTASY_API_KEY", "xtk_secret")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "aws-secret")
	j := testJimengClient(t, &fakeJimengCLI{})
	env := strings.Join(j.environ(), "\n")
	if strings.Contains(env, "secret") || strings.Contains(env, "AWWO_") || strings.Contains(env, "AWS_") {
		t.Fatal("the CLI's environment carries the API's secrets", env)
	}
	if !strings.Contains(env, "HOME="+j.home) || !strings.Contains(env, "DREAMINA_CANVAS_STATE_DIR="+j.state) {
		t.Fatal("the CLI's own home and records", env)
	}
}

func TestJimengConfigAndExposure(t *testing.T) {
	media := filepath.Join(t.TempDir(), "media")
	valid := testConfig()
	valid.MediaDir, valid.MediaTimeout, valid.MediaPollInterval, valid.MediaMaxFileBytes = media, 20*time.Minute, 5*time.Second, 300<<20
	valid.MediaResultHosts = []string{".runninghub.ai"}
	home := filepath.Join(filepath.Dir(media), "jimeng")
	valid.JimengCLI, valid.JimengHome, valid.JimengStateDir = filepath.Join(filepath.Dir(media), "bin", "dreamina-canvas"), home, filepath.Join(home, "state")
	valid.JimengProfile, valid.JimengCreditCeiling = "awwo", 700
	if err := validateMediaConfig(valid); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*Config){
		"relative cli":   func(c *Config) { c.JimengCLI = "dreamina-canvas" },
		"no home":        func(c *Config) { c.JimengHome = "" },
		"home in media":  func(c *Config) { c.JimengHome = filepath.Join(media, "jimeng") },
		"state in media": func(c *Config) { c.JimengStateDir = filepath.Join(media, "x") },
		"profile":        func(c *Config) { c.JimengProfile = "../x" },
		"ceiling":        func(c *Config) { c.JimengCreditCeiling = 0 },
		"workspace":      func(c *Config) { c.JimengWorkspaces = []string{"a b"} },
		"media dir":      func(c *Config) { c.MediaDir = "" },
		"unclean cli": func(c *Config) {
			c.JimengCLI = filepath.Dir(media) + string(filepath.Separator) + "bin" + string(filepath.Separator) + ".." + string(filepath.Separator) + "dreamina-canvas"
		},
		"ceiling far too big": func(c *Config) { c.JimengCreditCeiling = 20001 },
	} {
		c := valid
		mutate(&c)
		if validateMediaConfig(c) == nil {
			t.Error("accepted", name)
		}
	}
	every := valid
	every.JimengAllWorkspaces = true
	if validateMediaExposure(every) == nil {
		t.Fatal("Jimeng for every workspace without AWWO_MAX_OWNED_WORKSPACES")
	}
	every.MaxOwnedWorkspaces = 1
	if err := validateMediaExposure(every); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWWO_JIMENG_CLI", valid.JimengCLI)
	t.Setenv("AWWO_JIMENG_HOME", home)
	t.Setenv("AWWO_JIMENG_WORKSPACES", " t1 , t2,,")
	t.Setenv("AWWO_JIMENG_CREDIT_CEILING", "450")
	c := testConfig()
	if err := c.jimengFromEnv(); err != nil || c.JimengStateDir != filepath.Join(home, "state") || c.JimengProfile != "awwo" ||
		c.JimengCreditCeiling != 450 || strings.Join(c.JimengWorkspaces, ",") != "t1,t2" || !c.jimengWorkspace("t2") || c.jimengWorkspace("") {
		t.Fatal("env", c.JimengStateDir, c.JimengProfile, c.JimengCreditCeiling, c.JimengWorkspaces, err)
	}
	t.Setenv("AWWO_JIMENG_ALL_WORKSPACES", "maybe")
	if c.jimengFromEnv() == nil {
		t.Fatal("AWWO_JIMENG_ALL_WORKSPACES must be true or false")
	}
}

// Jimeng spends a personal member account: an unrestricted workspace, or the media switches for the other providers,
// never offer it; the operator's workspace list, its own switch or an allowlist naming the model do.
func TestJimengEntitlementIsExplicit(t *testing.T) {
	c := testConfig()
	c.MediaUnrestrictedWorkspaces, c.XtasyAllWorkspaces, c.TripoAllWorkspaces = true, true, true
	a := &App{cfg: c}
	open := modelEntitlement{tenant: "t1"}
	if a.mediaEntitled(open, "jm.image-cinema") || !a.mediaEntitled(open, "xt.seedream-5-pro") {
		t.Fatal("an unrestricted workspace is not offered Jimeng")
	}
	a.cfg.JimengWorkspaces = []string{"t1"}
	if !a.mediaEntitled(open, "jm.image-cinema") || a.mediaEntitled(modelEntitlement{tenant: "t2"}, "jm.video-cinema") || a.mediaEntitled(modelEntitlement{}, "jm.video-cinema") {
		t.Fatal("the named workspace only")
	}
	listed := modelEntitlement{allowed: &[]string{"jm.video-express"}, tenant: "t3"}
	if !a.mediaEntitled(listed, "jm.video-express") || a.mediaEntitled(listed, "jm.video-cinema") {
		t.Fatal("an allowlist naming the model")
	}
	a.cfg.JimengAllWorkspaces = true
	if !a.mediaEntitled(modelEntitlement{tenant: "t9"}, "jm.video-cinema") {
		t.Fatal("the all-workspaces switch")
	}
}

func TestJimengCredits(t *testing.T) {
	cinema, _ := builtinMediaCatalog.model("jm.video-cinema")
	for raw, want := range map[string]int{`{}`: 300, `{"duration":10}`: 600, `{"resolution":"1080p","duration":10}`: 1920, `{"resolution":"480p"}`: 150} {
		p, _ := cinema.resolveMediaParams(json.RawMessage(raw))
		if got := mediaCreditsFor(cinema.ID, cinema.Kind, p); got != want {
			t.Error("cinema", raw, got, want)
		}
	}
	express, _ := builtinMediaCatalog.model("jm.video-express")
	if p, _ := express.resolveMediaParams(json.RawMessage(`{"duration":10}`)); mediaCreditsFor(express.ID, express.Kind, p) != 180 {
		t.Error("express video", mediaCreditsFor(express.ID, express.Kind, p))
	}
	image, _ := builtinMediaCatalog.model("jm.image-cinema")
	for raw, want := range map[string]int{`{}`: 30, `{"resolution":"4K"}`: 48} {
		p, _ := image.resolveMediaParams(json.RawMessage(raw))
		if got := mediaCreditsFor(image.ID, image.Kind, p); got != want {
			t.Error("image", raw, got, want)
		}
	}
}

// An image run end to end against a stand-in for the CLI: the generation is saved and run once under the run's ids
// (a busy answer is sent again as the same call), followed to its end, and its file stored by its own bytes.
func TestPostgresJimengImageRunEndToEnd(t *testing.T) {
	h, _ := newMediaHarness(t)
	wait := jimengResendWait
	jimengResendWait = 50 * time.Millisecond
	t.Cleanup(func() { jimengResendWait = wait })
	jpeg := append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, bytes.Repeat([]byte{0x22}, 512)...)
	var mu sync.Mutex
	busy, polls := 1, 0
	creates := []string{}
	cli := &fakeJimengCLI{}
	cli.handle = func(args []string) (string, string, int) {
		mu.Lock()
		defer mu.Unlock()
		switch strings.Join(args[5:7], " ") {
		case "auth refresh", "canvas create":
			return okEnvelope(map[string]any{}), "", 0
		case "node create":
			creates = append(creates, strings.Join(args, "\x00"))
			if busy > 0 {
				busy--
				return "", errEnvelope("service.503", "retryable_failure", "retry", true), 21
			}
			return okEnvelope(map[string]any{"node": map[string]any{"nodeId": flagValue(args, "--node-id")}}), "", 0
		case "operation status":
			if polls++; polls < 2 {
				return okEnvelope(map[string]any{"state": "running"}), "", 0
			}
			return okEnvelope(map[string]any{"state": "succeeded", "resources": []any{map[string]any{"resourceId": jimengUUID("result/1"), "state": "succeeded"}}}), "", 0
		case "resource download":
			out := flagValue(args, "--output")
			_ = os.WriteFile(out, jpeg, 0o600)
			return okEnvelope(map[string]any{"resourceId": args[7], "path": out, "size": len(jpeg)}), "", 0
		}
		return "", "", 2
	}
	h.a.cfg.JimengCLI, h.a.cfg.JimengHome, h.a.cfg.JimengProfile, h.a.cfg.JimengCreditCeiling = filepath.Join(t.TempDir(), "dreamina-canvas"), t.TempDir(), "awwo", 700
	h.a.cfg.JimengStateDir = filepath.Join(h.a.cfg.JimengHome, "state")
	h.a.cfg.MediaPollInterval = 50 * time.Millisecond
	c, tid, _ := h.register(t, "jimeng-runs@example.test")
	h.a.cfg.JimengWorkspaces = []string{tid}
	h.a.jimeng = newJimeng(h.a.cfg)
	h.a.jimeng.run = cli.run
	catalogue := h.request(t, c, "GET", "/tenants/"+tid+"/media", nil, 200)
	first := catalogue["models"].([]any)[0].(map[string]any)
	if first["id"] != "jm.image-cinema" || first["vendor"] != mediaVendorShown {
		t.Fatal("the granted workspace starts on Jimeng's models", first)
	}
	if raw, _ := json.Marshal(first); bytes.Contains(bytes.ToLower(raw), []byte("seedream")) || bytes.Contains(bytes.ToLower(raw), []byte("jimeng")) {
		t.Fatal("the catalogue names the model family or the service", string(raw))
	}
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("pic", mediaKindImage, "jm.image-cinema", nil))
	sid := setupNodeAt(canvas, 0)["issueId"].(string)
	run := h.mediaRun(t, c, tid, sid, "a quiet mountain lake at dawn", 202)
	done := h.awaitRun(t, c, tid, run["id"].(string), "completed")
	var out mediaOutput
	if e := json.Unmarshal([]byte(done["output"].(string)), &out); e != nil || out.Model != "jm.image-cinema" || len(out.Items) != 1 || out.Items[0].ContentType != "image/jpeg" {
		t.Fatal("output", done["output"], e)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(creates) != 2 || creates[0] != creates[1] || !strings.Contains(creates[0], jimengUUID("submit/"+run["id"].(string))) {
		t.Fatal("one call, sent again unchanged after the busy answer", len(creates))
	}
	var accepted *bool
	if e := h.db.QueryRow(t.Context(), "SELECT provider_accepted FROM media_generations WHERE tenant_id=$1 AND run_id=$2", tid, run["id"]).Scan(&accepted); e != nil || accepted == nil || !*accepted {
		t.Fatal("an accepted generation is recorded as such", accepted, e)
	}
	other, otherTid, _ := h.register(t, "not-granted@example.test")
	for _, raw := range h.request(t, other, "GET", "/tenants/"+otherTid+"/media", nil, 200)["models"].([]any) {
		if id := raw.(map[string]any)["id"].(string); strings.HasPrefix(id, "jm.") {
			t.Fatal("a workspace the operator did not name is offered", id)
		}
	}
}
