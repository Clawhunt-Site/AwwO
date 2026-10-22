package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Every backup is the other provider's model of the same kind, and each first backup is backed up in turn: the two
// providers back each other up.
func TestMediaBackupModelsAreTheOtherProvidersModelsOfTheSameKind(t *testing.T) {
	for from, backups := range mediaBackupModels {
		m, ok := builtinMediaCatalog.model(from)
		if !ok || (m.Provider != mediaProviderXtasy && m.Provider != mediaProviderRunningHub) || len(backups) == 0 {
			t.Fatal("backed-up model", from)
		}
		for _, id := range backups {
			b, ok := builtinMediaCatalog.model(id)
			if !ok || b.Kind != m.Kind || b.Provider == m.Provider || (b.Provider != mediaProviderXtasy && b.Provider != mediaProviderRunningHub) {
				t.Fatal("backup", from, id)
			}
		}
		if _, ok := mediaBackupModels[backups[0]]; !ok {
			t.Fatal("no way back from", backups[0], "to", from)
		}
	}
}

// A backup takes the run's shape, sharpness, number of pictures, length and sound under its own names and spellings,
// keeps its own defaults for settings the run left at theirs, and is refused where it cannot make one the run asked
// for, a setting the run chose that no backup is known to make included.
func TestMediaBackupParamsCarryTheRunsSettingsOrRefuse(t *testing.T) {
	for _, c := range []struct {
		from  string
		given map[string]any
		to    string
		want  string // the backup's parameters as JSON; "" when it is refused
	}{
		{"xt.seedream-5-pro", nil, "rh.seedream-v5-pro", `{"outputFormat":"jpeg","resolution":"2k"}`},
		{"xt.seedream-5-pro", map[string]any{"aspectRatio": "16:9"}, "rh.seedream-v5-pro", ""},
		{"xt.seedream-5-pro", map[string]any{"aspectRatio": "16:9", "resolution": "1K"}, "rh.nano-banana-2", `{"aspectRatio":"16:9","resolution":"1k"}`},
		{"xt.gemini-3-1-flash-image", map[string]any{"aspectRatio": "21:9", "resolution": "4K"}, "rh.nano-banana-2", `{"aspectRatio":"21:9","resolution":"4k"}`},
		{"xt.gemini-3-1-flash-image", map[string]any{"resolution": "512px"}, "rh.nano-banana-2", ""},
		{"xt.gemini-3-1-flash-image", map[string]any{"aspectRatio": "1:4"}, "rh.nano-banana-2", ""},
		// An automatic shape is the backup's default one; a second picture is one the backup cannot make.
		{"xt.gpt-image-2-5", nil, "rh.gpt-image-2", `{"aspectRatio":"1:1","quality":"medium","resolution":"1k"}`},
		{"xt.gpt-image-2-5", map[string]any{"imageNum": 2}, "rh.gpt-image-2", ""},
		{"xt.xtasy-3", map[string]any{"imageNum": 3}, "rh.nano-banana-2", ""},
		{"xt.xtasy-3-pro", map[string]any{"aspectRatio": "3:2"}, "rh.nano-banana-2", `{"aspectRatio":"3:2","resolution":"1k"}`},
		// The user's own negative prompt is a choice Nano Banana 2 cannot make.
		{"xt.xtasy-3-pro", map[string]any{"aspectRatio": "3:2", "negativePrompt": "blur"}, "rh.nano-banana-2", ""},
		{"xt.omni-video", map[string]any{"aspectRatio": "9:16", "duration": 8, "resolution": "480p", "generateAudio": false}, "rh.seedance-2",
			`{"duration":"8","generateAudio":false,"ratio":"9:16","resolution":"480p"}`},
		{"xt.omni-video", nil, "rh.seedance-2-multimodal",
			`{"duration":"5","generateAudio":true,"ratio":"16:9","realPersonMode":false,"resolution":"720p","seed":-1}`},
		{"xt.omni-video-2-5", map[string]any{"duration": 20}, "rh.seedance-2", ""},
		{"rh.seedance-2", map[string]any{"resolution": "1080p"}, "xt.omni-video", ""},
		{"rh.seedance-2-multimodal", map[string]any{"ratio": "adaptive", "duration": "12"}, "xt.omni-video",
			`{"aspectRatio":"adaptive","duration":12,"generateAudio":true,"resolution":"720p"}`},
		{"rh.seedance-2-multimodal", map[string]any{"realPersonMode": true}, "xt.omni-video", ""},
		{"rh.seedance-2-multimodal", map[string]any{"seed": 42}, "xt.omni-video", ""},
		// RunningHub's Seedream makes square pictures, which X-tasy's makes when asked; a lossless PNG it cannot.
		{"rh.seedream-v5-pro", map[string]any{"resolution": "1k"}, "xt.seedream-5-pro", `{"aspectRatio":"1:1","resolution":"1K"}`},
		{"rh.seedream-v5-pro", map[string]any{"resolution": "1k", "outputFormat": "png"}, "xt.seedream-5-pro", ""},
		{"rh.gpt-image-2", map[string]any{"aspectRatio": "4:5"}, "xt.gpt-image-2-5", ""},
		{"rh.gpt-image-2", map[string]any{"aspectRatio": "16:9"}, "xt.gpt-image-2-5", `{"aspectRatio":"16:9","imageNum":1,"resolution":"1K"}`},
		// A high quality, which also doubles the price, is one X-tasy's GPT Image 2.5 is not known to make.
		{"rh.gpt-image-2", map[string]any{"aspectRatio": "16:9", "quality": "high"}, "xt.gpt-image-2-5", ""},
		{"rh.nano-banana-pro", map[string]any{"aspectRatio": "5:4", "resolution": "2k"}, "xt.gemini-3-1-flash-image", `{"aspectRatio":"5:4","resolution":"2K"}`},
	} {
		from, ok := builtinMediaCatalog.model(c.from)
		to, found := builtinMediaCatalog.model(c.to)
		raw, _ := json.Marshal(c.given)
		params, err := from.resolveMediaParams(raw)
		if !ok || !found || err != nil {
			t.Fatal("case", c.from, c.given, err)
		}
		got, ok := mediaBackupParams(from, to, params)
		if c.want == "" {
			if ok {
				t.Fatalf("%s %v went to %s as %v", c.from, c.given, c.to, got)
			}
			continue
		}
		text, _ := json.Marshal(got)
		if !ok || string(text) != c.want {
			t.Fatalf("%s %v to %s: %s (%v), want %s", c.from, c.given, c.to, text, ok, c.want)
		}
	}
}

// fallbackPlan is a plan of model with references, and its backups as admission would freeze them.
func fallbackPlan(t *testing.T, model string, refs ...mediaReference) *mediaPlan {
	t.Helper()
	m, _ := builtinMediaCatalog.model(model)
	params, err := m.resolveMediaParams(nil)
	if err != nil {
		t.Fatal(err)
	}
	plan := &mediaPlan{Version: 1, Provider: m.Provider, Model: m.ID, Kind: m.Kind, Params: params, References: refs}
	for _, id := range mediaBackupModels[model] {
		b, _ := builtinMediaCatalog.model(id)
		if p, ok := mediaBackupParams(m, b, params); ok {
			plan.Backups = append(plan.Backups, mediaBackup{Provider: b.Provider, Model: b.ID, Params: p})
		}
	}
	return plan
}

// The backup used is the first that takes the run's words and every one of its pictures and voices, read as the run's
// own model reads them.
func TestMediaBackupForTakesTheRunsWordsAndReferences(t *testing.T) {
	pick := func(plan *mediaPlan, text string) string {
		t.Helper()
		m, route, ok := mediaBackupFor(plan, text)
		if !ok {
			return ""
		}
		if route.Model != m.ID || route.Provider != m.Provider || route.Backups != nil || route.Kind != plan.Kind || len(route.References) != len(plan.References) {
			t.Fatal("route", route)
		}
		return m.ID
	}
	picture := mediaReference{ContentType: "image/png", Size: 1 << 20, SHA256: strings.Repeat("a", 64)}
	another := mediaReference{ContentType: "image/jpeg", Size: 1 << 20, SHA256: strings.Repeat("c", 64)}
	voice := mediaReference{ContentType: "audio/mpeg", Size: 1 << 20, SHA256: strings.Repeat("b", 64)}
	for _, c := range []struct {
		plan       *mediaPlan
		text, want string
	}{
		{fallbackPlan(t, "xt.omni-video"), "a calm sea", "rh.seedance-2"},
		// Two pictures are subjects to keep for both providers' videos; a single one is X-tasy's first frame and
		// RunningHub's subject, so it goes to neither the other way.
		{fallbackPlan(t, "xt.omni-video", picture, another), "a calm sea", "rh.seedance-2-multimodal"},
		{fallbackPlan(t, "xt.omni-video", picture), "a calm sea", ""},
		{fallbackPlan(t, "rh.seedance-2-multimodal", picture, another), "a calm sea", "xt.omni-video"},
		{fallbackPlan(t, "rh.seedance-2-multimodal", picture), "a calm sea", ""},
		// RunningHub's image models take no pictures.
		{fallbackPlan(t, "xt.seedream-5-pro", picture), "a calm sea", ""},
		// Words past RunningHub's Seedream's 5,000 characters, or short of its 5, go to Nano Banana 2.
		{fallbackPlan(t, "xt.seedream-5-pro"), strings.Repeat("长", 6000), "rh.nano-banana-2"},
		{fallbackPlan(t, "xt.seedream-5-pro"), "lake", "rh.nano-banana-2"},
		// X-tasy's videos take no voices.
		{fallbackPlan(t, "rh.seedance-2-multimodal", picture, another, voice), "a calm sea", ""},
		// RunningHub takes pictures of up to 10 MB, and no GIF.
		{fallbackPlan(t, "xt.omni-video", picture, mediaReference{ContentType: "image/png", Size: 15 << 20}), "a calm sea", ""},
		{fallbackPlan(t, "xt.omni-video", picture, mediaReference{ContentType: "image/gif", Size: 1 << 10}), "a calm sea", ""},
	} {
		if got := pick(c.plan, c.text); got != c.want {
			t.Fatalf("%s with %d references: %q, want %q", c.plan.Model, len(c.plan.References), got, c.want)
		}
	}
	// A backup the release no longer lists for the model, or one of the same provider, is not used.
	stale := fallbackPlan(t, "xt.omni-video")
	stale.Backups = []mediaBackup{{Provider: mediaProviderRunningHub, Model: "rh.kling-v3-pro", Params: map[string]any{}}}
	if got := pick(stale, "a calm sea"); got != "" {
		t.Fatal("an unlisted backup was used", got)
	}
	same := fallbackPlan(t, "xt.omni-video")
	same.Backups = []mediaBackup{{Provider: mediaProviderXtasy, Model: "xt.omni-video-2-5", Params: map[string]any{}}}
	if got := pick(same, "a calm sea"); got != "" {
		t.Fatal("a backup of the same provider was used", got)
	}
}

// A refusal of a submission says no task was created, whatever its reason; only one on the operator's side gives a free
// attempt back. A transient one says neither, and a resend takes both back: the first send may have made the task.
func TestRefusedSubmissionsSayNoTaskWasCreatedOnlyForTheFirstSend(t *testing.T) {
	for _, c := range []struct {
		err             *rhError
		noTask, refused bool
	}{
		{&rhError{Code: "media_provider_unauthorized"}, true, true},
		{&rhError{Code: "media_params_invalid"}, true, false},
		{&rhError{Code: "media_provider_unavailable", Transient: true}, false, false},
	} {
		e, _ := asRHError(refusedAnswer(c.err))
		if e.NoTask != c.noTask || e.Refused != c.refused {
			t.Fatal(c.err.Code, e.NoTask, e.Refused)
		}
	}
	first := &scriptedMediaHub{answers: []error{refusedAnswer(&rhError{Code: "media_provider_unauthorized"})}}
	if _, err := submitMedia(t.Context(), first, "", nil, func() {}); err == nil {
		t.Fatal("refusal")
	} else if e, _ := asRHError(err); !e.NoTask || !e.Refused {
		t.Fatal("a refusal of the first send", e)
	}
	resent := &scriptedMediaHub{answers: []error{&rhError{Code: "media_provider_busy", Transient: true, RetryAfter: time.Millisecond},
		refusedAnswer(&rhError{Code: "media_provider_unauthorized"})}}
	if _, err := submitMedia(t.Context(), resent, "", nil, func() {}); err == nil {
		t.Fatal("refusal")
	} else if e, _ := asRHError(err); e.NoTask || e.Refused || resent.sends != 2 {
		t.Fatal("a refusal of a resend", e, resent.sends)
	}
}

// Each provider says a task is gone only in its own words about the task: a failed (or expired, refused) task ended,
// final even when its code calls the cause busy. A refused key, an error status, a "no such task" (structured or not)
// or a code beside a running task says nothing of it. A client error, a rate limit and RunningHub's flat refusal made
// no task; a redirect or another success status may have.
func TestProviderAnswersSayWhetherATaskExistsOrEnded(t *testing.T) {
	flags := func(err error) string {
		e, ok := asRHError(err)
		if !ok {
			return "not an rhError"
		}
		return fmt.Sprintf("%s noTask=%v ended=%v transient=%v", e.Code, e.NoTask, e.Ended, e.Transient)
	}
	f := newFakeRunningHub(t)
	hub := newRunningHub(Config{RunningHubAPIKey: fakeRunningHubKey, RunningHubBaseURL: f.api.URL, MediaMaxFileBytes: 1 << 20, MediaResultHosts: []string{".runninghub.ai"}})
	for _, c := range []struct {
		status int
		answer any
		want   string
	}{
		{202, nil, "media_failed noTask=false ended=false transient=false"},
		{400, nil, "media_failed noTask=true ended=false transient=false"},
		{429, nil, "media_provider_busy noTask=true ended=false transient=true"},
		{200, map[string]any{"taskId": "", "status": "", "errorCode": "421", "errorMessage": "x", "results": nil}, "media_provider_busy noTask=true ended=false transient=true"},
		// A flat answer whose code says nothing (unreadable, or zero) does not say no task was made.
		{200, map[string]any{"taskId": "", "status": "", "errorCode": map[string]any{}, "results": nil}, "media_provider_unavailable noTask=false ended=false transient=true"},
		{200, map[string]any{"taskId": "", "status": "", "errorCode": 0, "results": nil}, "media_failed noTask=false ended=false transient=false"},
		{200, map[string]any{"taskId": "", "status": "", "errorCode": json.RawMessage("-0"), "results": nil}, "media_failed noTask=false ended=false transient=false"},
		{200, map[string]any{"taskId": "", "status": "", "errorCode": "00", "results": nil}, "media_failed noTask=false ended=false transient=false"},
		{200, map[string]any{"taskId": "", "status": "", "errorCode": "+0", "results": nil}, "media_failed noTask=false ended=false transient=false"},
		{200, map[string]any{"taskId": "", "status": "", "errorCode": "-0", "results": nil}, "media_failed noTask=false ended=false transient=false"},
		{200, map[string]any{"taskId": "", "status": "", "errorCode": 200, "results": nil}, "media_failed noTask=false ended=false transient=false"},
		{200, map[string]any{"taskId": "", "status": "", "errorCode": "0200", "results": nil}, "media_failed noTask=false ended=false transient=false"},
		{200, map[string]any{"taskId": "", "status": "", "errorCode": "+421", "results": nil}, "media_failed noTask=true ended=false transient=false"},
		{200, map[string]any{"taskId": "t9", "status": "FAILED", "results": nil}, "media_failed noTask=false ended=true transient=false"},
	} {
		f.set(func(int) (int, any) { return c.status, c.answer }, nil)
		if _, err := hub.submit(t.Context(), "/openapi/v2/seedream-v5-pro/text-to-image", map[string]any{"prompt": "a lake"}); flags(err) != c.want {
			t.Fatalf("RunningHub's submission answered %d %v: %s, want %s", c.status, c.answer, flags(err), c.want)
		}
	}
	for _, c := range []struct {
		status int
		answer any
		want   string
	}{
		{200, map[string]any{"taskId": "t1", "status": "FAILED", "errorCode": "433"}, "media_content_rejected noTask=false ended=true transient=false"},
		{200, map[string]any{"taskId": "t1", "status": "FAILED", "errorCode": "421"}, "media_provider_busy noTask=false ended=true transient=false"},
		{200, map[string]any{"taskId": "t1", "status": "FAILED", "errorCode": "804"}, "media_failed noTask=false ended=true transient=false"},
		{200, map[string]any{"taskId": "", "status": "", "errorCode": "423"}, "media_task_missing noTask=false ended=false transient=false"},
		{200, map[string]any{"taskId": "t1", "status": "RUNNING", "errorCode": "1004"}, "media_task_missing noTask=false ended=false transient=false"},
		{200, map[string]any{"taskId": "t1", "status": "RUNNING", "errorCode": "806"}, "media_provider_unauthorized noTask=false ended=false transient=false"},
		{401, nil, "media_provider_unauthorized noTask=false ended=false transient=false"},
	} {
		f.set(nil, func(string, int) (int, any) { return c.status, c.answer })
		if _, err := hub.query(t.Context(), "t1"); flags(err) != c.want {
			t.Fatalf("RunningHub's query answered %d %v: %s, want %s", c.status, c.answer, flags(err), c.want)
		}
	}

	var mu sync.Mutex
	status, body := 0, ""
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if status >= 300 && status < 400 {
			w.Header().Set("Location", "/openapi/v1/tasks/xt_9")
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(api.Close)
	x := newXtasy(Config{XtasyAPIKey: "xtk_test-key-0123456789", XtasyBaseURL: api.URL, MediaMaxFileBytes: 1 << 20})
	answer := func(s int, b string) {
		mu.Lock()
		status, body = s, b
		mu.Unlock()
	}
	request := map[string]any{"model_id": "model_x", "prompt": "a lake", xtasyIdempotencyField: "awwo-run-r1"}
	for _, c := range []struct {
		status int
		body   string
		want   string
	}{
		{303, "", "media_failed noTask=false ended=false transient=false"},
		{401, `{"error":{"code":"API_KEY_REVOKED"}}`, "media_provider_unauthorized noTask=true ended=false transient=false"},
		{422, `{"error":{"code":"INVALID_PARAMETER"}}`, "media_params_invalid noTask=true ended=false transient=false"},
		// A 403 refusing the content in so many words is not the key's (which a backup would be asked to mend); another
		// 403, one about the account or an outage among them, a 401 or a 402 still is the key's or the balance's,
		// whatever its code says besides.
		{403, `{"error":{"code":"CONTENT_POLICY_VIOLATION"}}`, "media_content_rejected noTask=true ended=false transient=false"},
		{403, `{"error":{"code":"NSFW_CONTENT_INSUFFICIENT_SAFETY"}}`, "media_content_rejected noTask=true ended=false transient=false"},
		{403, `{"error":{"code":"CONTENT_FILTERED"}}`, "media_content_rejected noTask=true ended=false transient=false"},
		{403, `{"error":{"code":"UNSAFE_CONTENT"}}`, "media_content_rejected noTask=true ended=false transient=false"},
		{403, `{"error":{"code":"CONTENT_MODERATED"}}`, "media_content_rejected noTask=true ended=false transient=false"},
		{403, `{"error":{"code":"ACCESS_DENIED_BY_POLICY"}}`, "media_provider_unauthorized noTask=true ended=false transient=false"},
		{403, `{"error":{"code":"REGION_BLOCKED_BY_POLICY"}}`, "media_provider_unauthorized noTask=true ended=false transient=false"},
		{403, `{"error":{"code":"CONTENT_MODERATION"}}`, "media_provider_unauthorized noTask=true ended=false transient=false"},
		{403, `{"error":{"code":"ACCOUNT_POLICY_SUSPENDED"}}`, "media_provider_unauthorized noTask=true ended=false transient=false"},
		{403, `{"error":{"code":"ACCOUNT_POLICY_VIOLATION"}}`, "media_provider_unauthorized noTask=true ended=false transient=false"},
		{403, `{"error":{"code":"MODERATION_SERVICE_UNAVAILABLE"}}`, "media_provider_unauthorized noTask=true ended=false transient=false"},
		{401, `{"error":{"code":"CONTENT_POLICY_VIOLATION"}}`, "media_provider_unauthorized noTask=true ended=false transient=false"},
		{402, `{"error":{"code":"CONTENT_MODERATION"}}`, "media_provider_balance noTask=true ended=false transient=false"},
		{202, `{"task_id":"xt_9","status":"failed","billing":{"status":"released","charged":"0"}}`, "media_failed noTask=false ended=true transient=false"},
	} {
		answer(c.status, c.body)
		if _, err := x.submit(t.Context(), xtasyEndpoints[mediaKindImage], request); flags(err) != c.want {
			t.Fatalf("X-tasy's submission answered %d %s: %s, want %s", c.status, c.body, flags(err), c.want)
		}
	}
	for _, c := range []struct {
		status int
		body   string
		want   string
	}{
		// A key of another account finds none of the old one's tasks: "no such task" is not the task's end.
		{404, `{"error":{"code":"TASK_NOT_FOUND"}}`, "media_task_missing noTask=false ended=false transient=false"},
		{404, `<html>not found</html>`, "media_task_missing noTask=false ended=false transient=false"},
		{401, `{"error":{"code":"API_KEY_REVOKED"}}`, "media_provider_unauthorized noTask=false ended=false transient=false"},
		{200, `{"task_id":"xt_1","status":"expired","billing":{"status":"released","charged":"0"}}`, "media_result_unavailable noTask=false ended=true transient=false"},
		{200, `{"task_id":"xt_1","status":"expired","error":{"code":"CONTENT_MODERATION_REJECTED"},"billing":{"status":"released","charged":"0"}}`, "media_content_rejected noTask=false ended=true transient=false"},
		{200, `{"task_id":"xt_1","status":"expired","error":{"code":"CONTENT_MODERATION"},"billing":{"status":"released","charged":"0"}}`, "media_result_unavailable noTask=false ended=true transient=false"},
		{200, `{"task_id":"xt_1","status":"expired","error":{"code":"CONTENT_EXPIRED"},"billing":{"status":"released","charged":"0"}}`, "media_result_unavailable noTask=false ended=true transient=false"},
		{200, `{"task_id":"xt_1","status":"expired","error":{"code":"MODERATION_TIMEOUT"},"billing":{"status":"released","charged":"0"}}`, "media_result_unavailable noTask=false ended=true transient=false"},
		{200, `{"task_id":"xt_1","status":"failed","error":{"code":"CONTENT_REJECTED"},"billing":{"status":"released","charged":"0"}}`, "media_content_rejected noTask=false ended=true transient=false"},
	} {
		answer(c.status, c.body)
		if _, err := x.query(t.Context(), "xt_1"); flags(err) != c.want {
			t.Fatalf("X-tasy's query answered %d %s: %s, want %s", c.status, c.body, flags(err), c.want)
		}
	}
	// A task X-tasy completed with only an extra beside its result delivered, and may be charged: it did not end unmade.
	frame, _ := json.Marshal(map[string]any{"task_id": "xt_1", "status": "completed", "outputs": []any{map[string]any{"output_id": "o1", "role": "last_frame",
		"url": "/openapi/v1/tasks/xt_1/outputs/o1/content"}}})
	if _, err := parseXtasyTask(frame, "xt_1", "https://service.xtasyart.com"); flags(err) != "media_no_output noTask=false ended=false transient=false" {
		t.Fatal("X-tasy's task without its result", flags(err))
	}
}

// A failed backup fails its run with what went wrong first, unless the backup refused the content, a real person
// included (told as refused content: the switch its own code speaks of may not be the reader's).
func TestMediaBackupFailureIsTheFirstUnlessTheContent(t *testing.T) {
	for _, c := range [][3]string{
		{"media_provider_unauthorized", "media_params_invalid", "media_provider_unauthorized"},
		{"media_provider_unauthorized", "media_provider_balance", "media_provider_unauthorized"},
		{"media_failed", "media_content_rejected", "media_content_rejected"},
		{"media_failed", "media_real_person_rejected", "media_content_rejected"},
		{"", "media_timeout", "media_timeout"},
	} {
		if got := mediaBackupFailure(c[0], c[1]); got != c[2] {
			t.Fatalf("first %s, backup %s: %s, want %s", c[0], c[1], got, c[2])
		}
	}
}

// scriptedMediaHub answers each submission with the next of its answers.
type scriptedMediaHub struct {
	answers []error
	sends   int
}

func (h *scriptedMediaHub) submit(context.Context, string, map[string]any) (rhTask, error) {
	h.sends++
	return rhTask{}, h.answers[h.sends-1]
}
func (h *scriptedMediaHub) query(context.Context, string) (rhTask, error) { return rhTask{}, nil }
func (h *scriptedMediaHub) download(context.Context, string, io.Writer) (int64, error) {
	return 0, nil
}
func (h *scriptedMediaHub) fileLimit() int64 { return 0 }

// fakeXtasy stands in for X-tasy's API: submit answers each generation request, query each task read, upload each
// reference file; every output is a JPEG.
type fakeXtasy struct {
	api     *httptest.Server
	mu      sync.Mutex
	submits []map[string]any
	keys    []string
	uploads int
	submit  func(n int) (int, map[string]any, http.Header)
	query   func(task string) (int, any)
	upload  func(n int) (int, any)
}

func newFakeXtasy(t *testing.T, a *App) *fakeXtasy {
	f := &fakeXtasy{}
	f.submit = func(n int) (int, map[string]any, http.Header) {
		return 202, map[string]any{"task_id": fmt.Sprintf("xt_%d", n), "status": "running"}, nil
	}
	f.query = func(task string) (int, any) { return 200, xtasyCompleted(task) }
	f.upload = func(n int) (int, any) { return 201, map[string]any{"file_id": fmt.Sprintf("file_%d", n)} }
	jpeg := append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, bytes.Repeat([]byte{0x11}, 512)...)
	f.api = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/openapi/v1/files":
			f.uploads++
			status, reply := f.upload(f.uploads)
			writeJSON(w, status, reply)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/openapi/v1/files/"):
			writeJSON(w, 200, map[string]any{"status": "ready"})
		case r.Method == http.MethodPost:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.submits = append(f.submits, body)
			f.keys = append(f.keys, r.Header.Get("Idempotency-Key"))
			status, reply, header := f.submit(len(f.submits))
			for name, values := range header {
				w.Header()[name] = values
			}
			writeJSON(w, status, reply)
		case strings.HasSuffix(r.URL.Path, "/content"):
			_, _ = w.Write(jpeg)
		default:
			status, reply := f.query(strings.TrimPrefix(r.URL.Path, "/openapi/v1/tasks/"))
			writeJSON(w, status, reply)
		}
	}))
	t.Cleanup(f.api.Close)
	f.configure(a)
	return f
}

func (f *fakeXtasy) configure(a *App) {
	a.cfg.XtasyAPIKey, a.cfg.XtasyBaseURL = "xtk_test-key-0123456789", f.api.URL
	a.xtasy = newXtasy(a.cfg)
}

func (f *fakeXtasy) set(submit func(n int) (int, map[string]any, http.Header), query func(task string) (int, any)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if submit != nil {
		f.submit = submit
	}
	if query != nil {
		f.query = query
	}
}

func (f *fakeXtasy) setUpload(upload func(n int) (int, any)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.upload = upload
}

func (f *fakeXtasy) sent() ([]map[string]any, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.submits...), append([]string(nil), f.keys...)
}

func xtasyCompleted(task string) map[string]any {
	return map[string]any{"task_id": task, "status": "completed", "billing": map[string]any{"status": "settled", "charged": "12"},
		"outputs": []any{map[string]any{"output_id": "o1", "role": "output", "url": "/openapi/v1/tasks/" + task + "/outputs/o1/content"}}}
}

// xtasyFailed is X-tasy's answer about a task that failed on its side, charging nothing.
func xtasyFailed(task string) (int, any) {
	return 200, map[string]any{"task_id": task, "status": "failed", "error": map[string]any{"code": "INTERNAL_ERROR"},
		"billing": map[string]any{"status": "released", "charged": "0"}}
}

// xtasyRefusal is X-tasy's answer refusing the key, as it answered on 2026-10-15.
func xtasyRefusal(int) (int, map[string]any, http.Header) {
	return 401, map[string]any{"error": map[string]any{"code": "API_KEY_CREDENTIALS_CHANGED", "retryable": false}}, nil
}

// rhFlatRefusal is RunningHub's 200 answer refusing a submission with code, naming no task.
func rhFlatRefusal(code string) func(int) (int, any) {
	return func(int) (int, any) {
		return 200, map[string]any{"taskId": "", "status": "", "errorCode": code, "errorMessage": "x", "results": nil}
	}
}

// mediaGenerationState is a run's media task and its generation's charge flags.
func mediaGenerationState(t *testing.T, h *harness, tid, rid string) (task map[string]any, refused bool, accepted *bool) {
	t.Helper()
	var raw []byte
	if e := h.db.QueryRow(t.Context(), `SELECT r.media_task,g.provider_refused,g.provider_accepted FROM runs r
		JOIN media_generations g ON g.tenant_id=r.tenant_id AND g.run_id=r.id WHERE r.tenant_id=$1 AND r.id=$2`, tid, rid).Scan(&raw, &refused, &accepted); e != nil {
		t.Fatal(e)
	}
	if e := json.Unmarshal(raw, &task); e != nil {
		t.Fatal(e)
	}
	return task, refused, accepted
}

func backupStatuses(t *testing.T, h *harness, tid, rid string) int {
	t.Helper()
	var n int
	if e := h.db.QueryRow(t.Context(), "SELECT count(*) FROM run_events WHERE tenant_id=$1 AND run_id=$2 AND data->>'type'='media_status' AND data->>'status'='backup'", tid, rid).Scan(&n); e != nil {
		t.Fatal(e)
	}
	return n
}

// mediaRecord is a run's stored media record, read loosely: its model and whether it says a backup made it.
func mediaRecord(t *testing.T, output string) (model string, backup bool) {
	t.Helper()
	var record map[string]any
	if e := json.Unmarshal([]byte(output), &record); e != nil || record["type"] != mediaOutputType {
		t.Fatal("media record", output, e)
	}
	model, _ = record["model"].(string)
	return model, record["backup"] == true
}

// sentWhenItsRunBegan reports whether a run's media task keeps the time the run began as the time its generation was
// first sent, as it does after a backup of a generation the first provider never took.
func sentWhenItsRunBegan(t *testing.T, h *harness, tid, rid string) bool {
	t.Helper()
	var same bool
	if e := h.db.QueryRow(t.Context(), `SELECT media_task->>'submittedAt'=to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
		FROM runs WHERE tenant_id=$1 AND id=$2`, tid, rid).Scan(&same); e != nil {
		t.Fatal(e)
	}
	return same
}
