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

// TestXtasyLiveEveryModel generates once with every X-tasy model, at the settings a new node ships with, through the
// API's own client, and records what X-tasy reserved and charged. It spends real credits, so it runs only when
// AWWO_XTASY_LIVE_KEY_FILE names a file holding an AWWO_XTASY_API_KEY=... line; AWWO_XTASY_LIVE_OUT names where
// one JSON line per model is written. The key is never printed.
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
	if validateXtasyConfig(c) != nil {
		t.Fatal("the key file holds no valid AWWO_XTASY_API_KEY")
	}
	x := newXtasy(c)
	only := os.Getenv("AWWO_XTASY_LIVE_MODELS")
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
			params, _ := m.resolveMediaParams(nil)
			record["params"] = params
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
			defer cancel()
			started := time.Now()
			task, err := submitMedia(ctx, x, m.Endpoint, xtasyRequest(m, "A quiet mountain lake at sunrise, soft light", params, "verify-"+m.ID+"-"+stamp), func() {})
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
