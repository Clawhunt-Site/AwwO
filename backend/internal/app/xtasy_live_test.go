package app

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestXtasyLiveEveryModel generates once with every X-tasy model through the API's own client and records what X-tasy
// reserved and charged: at the settings a new node ships with, or at the ones AWWO_XTASY_LIVE_PARAMS and
// AWWO_XTASY_LIVE_REFERENCE give. It spends real credits, so it runs only when
// AWWO_XTASY_LIVE_KEY_FILE names a file holding an AWWO_XTASY_API_KEY=... line; AWWO_XTASY_LIVE_OUT names where
// one JSON line per model is written. AWWO_XTASY_LIVE_PROXY names a loopback proxy (it is used as the development
// download proxy), for a machine whose own exit X-tasy's edge refuses: without it every call there answers 403 and
// reads as media_provider_unauthorized, which is a block, not a key (2026-10-22). The key is never printed.
func TestXtasyLiveEveryModel(t *testing.T) {
	keyFile, out := os.Getenv("AWWO_XTASY_LIVE_KEY_FILE"), os.Getenv("AWWO_XTASY_LIVE_OUT")
	if keyFile == "" || out == "" {
		t.Skip("live X-tasy verification needs AWWO_XTASY_LIVE_KEY_FILE and AWWO_XTASY_LIVE_OUT")
	}
	key := ""
	file, err := os.Open(keyFile)
	if err != nil {
		t.Fatal("key file unreadable")
	}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if v, ok := strings.CutPrefix(strings.TrimSpace(scanner.Text()), "AWWO_XTASY_API_KEY="); ok {
			key = v
		}
	}
	_ = file.Close()
	c := testConfig()
	c.XtasyAPIKey, c.XtasyBaseURL, c.MediaMaxFileBytes = key, defaultXtasyBaseURL, 300<<20
	if proxy := os.Getenv("AWWO_XTASY_LIVE_PROXY"); proxy != "" {
		// The download proxy is a development setting and must be one loopback port, as validateMediaConfig requires of
		// a deployment; validateXtasyConfig alone does not check it, so it is checked here rather than claimed.
		if !loopbackOrigin(proxy) {
			t.Fatal("AWWO_XTASY_LIVE_PROXY must be http://127.0.0.1:<port>")
		}
		c.Env, c.MediaDevProxy = "development", proxy
	}
	if validateXtasyConfig(c) != nil {
		t.Fatal("the key file holds no valid AWWO_XTASY_API_KEY")
	}
	x := newXtasy(c)
	only := os.Getenv("AWWO_XTASY_LIVE_MODELS")
	// AWWO_XTASY_LIVE_PARAMS, a node's params as JSON, measures a setting that is not the default: a ratio other than
	// the model's own, say. Empty: each model's own defaults. It applies to every model the run selects, so a value
	// one of them does not take fails the run (a model generates nothing in that case, and measures nothing).
	var chosen json.RawMessage
	if raw := strings.TrimSpace(os.Getenv("AWWO_XTASY_LIVE_PARAMS")); raw != "" {
		chosen = json.RawMessage(raw)
	}
	// AWWO_XTASY_LIVE_REFERENCE names a picture file (PNG, JPEG or WebP) to generate from, so that a model's listed
	// img2img mode is proved by a generation and not by its listing: X-tasy's own list has advertised a setting its
	// model then refused (2026-10-22, 4K on the 全能图片 5.0 flash model). The picture is uploaded for the run as the
	// run path uploads one, and the generation sends it as the model's one reference_image.
	var reference []byte
	if path := strings.TrimSpace(os.Getenv("AWWO_XTASY_LIVE_REFERENCE")); path != "" {
		data, e := os.ReadFile(path)
		if e != nil {
			t.Fatal("AWWO_XTASY_LIVE_REFERENCE is unreadable")
		}
		contentType, _, kind := sniffMedia(data)
		if kind != mediaKindImage || !mediaReferenceTypes[mediaProviderXtasy][contentType] {
			t.Fatalf("AWWO_XTASY_LIVE_REFERENCE is not a picture X-tasy takes (%s)", contentType)
		}
		reference = data
	}
	results, _ := os.Create(out)
	defer results.Close()
	var mu sync.Mutex
	var wg sync.WaitGroup
	stamp := time.Now().UTC().Format("20060102T150405")
	for _, m := range xtasyModels() {
		if only != "" && !strings.Contains(","+only+",", ","+m.ID+",") {
			continue
		}
		wg.Add(1)
		go func(m *mediaModel) {
			defer wg.Done()
			record := map[string]any{"model": m.ID, "kind": m.Kind}
			defer func() {
				line, _ := json.Marshal(record)
				mu.Lock()
				_, _ = results.Write(append(line, '\n'))
				mu.Unlock()
				t.Log(string(line))
			}()
			params, err := m.resolveMediaParams(chosen)
			if err != nil {
				// Not just recorded: a params set this model does not take would otherwise leave the run with nothing
				// generated and nothing measured, and the test still passing.
				record["error"] = "the given params are not this model's"
				t.Errorf("%s: AWWO_XTASY_LIVE_PARAMS is not this model's parameters", m.ID)
				return
			}
			record["params"] = params
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
			defer cancel()
			started := time.Now()
			// With a picture given, the generation starts from it, as a node with one attached does: uploaded for this
			// run (the upload creates no task and is not charged) and sent as the model's reference, which turns an
			// image model to img2img and a video model to its first frame (xtasyRequest).
			var references []string
			if len(reference) > 0 {
				if m.References == 0 {
					record["error"] = "this model takes no reference picture"
					t.Errorf("%s: AWWO_XTASY_LIVE_REFERENCE given for a model that takes none", m.ID)
					return
				}
				contentType, _, _ := sniffMedia(reference)
				id, e := x.uploadReference(ctx, testReference(reference, contentType), reference, "verify-"+m.ID+"-"+stamp)
				if e != nil {
					record["error"] = "reference upload: " + mediaFailureCode(e)
					t.Errorf("%s: the reference picture was not accepted (%s)", m.ID, mediaFailureCode(e))
					return
				}
				references = []string{id}
				record["reference"] = map[string]any{"bytes": len(reference), "type": contentType, "uploaded": true}
			}
			task, err := submitMedia(ctx, x, m.Endpoint, xtasyRequest(m, "A quiet mountain lake at sunrise, soft light", params, "verify-"+m.ID+"-"+stamp, references), func() {})
			if err != nil {
				record["error"] = mediaFailureCode(err)
				return
			}
			record["task"] = task.TaskID
			for task.Status != "SUCCESS" {
				select {
				case <-ctx.Done():
					record["error"] = "timeout"
					return
				case <-time.After(5 * time.Second):
				}
				next, err := x.query(ctx, task.TaskID)
				if err != nil {
					if e, ok := asRHError(err); ok && e.Transient {
						continue
					}
					record["error"] = mediaFailureCode(err)
					record["billing"] = xtasyLiveBilling(ctx, x, task.TaskID)
					return
				}
				task = next
			}
			record["seconds"] = int(time.Since(started).Seconds())
			files := []map[string]any{}
			for i, result := range task.Results {
				path := filepath.Join(filepath.Dir(out), strings.ReplaceAll(m.ID, ".", "_")+"-"+string(rune('0'+i)))
				f, err := os.Create(path)
				if err != nil {
					record["error"] = "local file"
					return
				}
				head := &headBuffer{limit: 64}
				n, err := x.download(ctx, result.URL, io.MultiWriter(f, head))
				_ = f.Close()
				contentType, _, kind := sniffMedia(head.Bytes())
				entry := map[string]any{"bytes": n, "type": contentType, "fits": mediaResultFits(m.Kind, kind, i+1)}
				if err != nil {
					entry["error"] = mediaFailureCode(err)
				}
				files = append(files, entry)
			}
			record["files"] = files
			record["billing"] = xtasyLiveBilling(ctx, x, task.TaskID)
			record["awwoCredits"] = mediaCreditsFor(m.ID, m.Kind, params)
		}(m)
	}
	wg.Wait()
}

// xtasyLiveBilling reads a task's billing block, which the run path never needs.
func xtasyLiveBilling(ctx context.Context, x *xtasyClient, taskID string) any {
	data, status, _, err := x.do(ctx, "GET", "/openapi/v1/tasks/"+taskID, nil, "")
	if err != nil || status != 200 {
		return nil
	}
	var v struct {
		Billing any `json:"billing"`
	}
	_ = json.Unmarshal(data, &v)
	return v.Billing
}
