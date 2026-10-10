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

// TestTripoLiveCheapest generates one model with each Tripo model at its cheapest setting (no texture: Tripo's
// tables put that at 10 credits for v3.1 and 30 for P1), through the API's own client, and checks that the model
// and its preview download and sniff as a binary glTF and a picture. It spends real credits, so it runs only when
// AWWO_TRIPO_LIVE_KEY_FILE names a file holding an AWWO_TRIPO_API_KEY=... line; AWWO_TRIPO_LIVE_OUT names where one
// JSON line per model is written. AWWO_TRIPO_LIVE_PROXY names a loopback proxy for a machine whose resolver answers
// with non-public addresses (it is used as the development download proxy). The key is never printed.
func TestTripoLiveCheapest(t *testing.T) {
	keyFile, out := os.Getenv("AWWO_TRIPO_LIVE_KEY_FILE"), os.Getenv("AWWO_TRIPO_LIVE_OUT")
	if keyFile == "" || out == "" {
		t.Skip("live Tripo verification needs AWWO_TRIPO_LIVE_KEY_FILE and AWWO_TRIPO_LIVE_OUT")
	}
	key := ""
	file, err := os.Open(keyFile)
	if err != nil {
		t.Fatal("key file unreadable")
	}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if v, ok := strings.CutPrefix(strings.TrimSpace(scanner.Text()), "AWWO_TRIPO_API_KEY="); ok {
			key = v
		}
	}
	_ = file.Close()
	c := testConfig()
	c.TripoAPIKey, c.TripoBaseURL, c.MediaMaxFileBytes = key, defaultTripoBaseURL, 300<<20
	c.TripoResultHosts = strings.Split(defaultTripoResultHosts, ",")
	c.TripoFreeRunsPerDay, c.TripoFreeTotalPerDay = 2, 40
	if proxy := os.Getenv("AWWO_TRIPO_LIVE_PROXY"); proxy != "" {
		c.Env, c.MediaDevProxy = "development", proxy
	}
	if validateTripoConfig(c) != nil {
		t.Fatal("the key file holds no valid AWWO_TRIPO_API_KEY")
	}
	tc := newTripo(c)
	results, _ := os.Create(out)
	defer results.Close()
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, m := range tripoModels() {
		wg.Add(1)
		go func(m *mediaModel) {
			defer wg.Done()
			record := map[string]any{"model": m.ID, "version": m.Version}
			defer func() {
				line, _ := json.Marshal(record)
				mu.Lock()
				_, _ = results.Write(append(line, '\n'))
				mu.Unlock()
				t.Log(string(line))
			}()
			params, err := m.resolveMediaParams(json.RawMessage(`{"texture":false,"pbr":false}`))
			if err != nil {
				record["error"] = "params"
				return
			}
			record["params"] = params
			record["awwoCredits"] = mediaCreditsFor(m.ID, m.Kind, params)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
			defer cancel()
			started := time.Now()
			task, err := submitMedia(ctx, tc, m.Endpoint, tripoRequest(m, "A small wooden treasure chest, stylized game asset", params), func() {})
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
				next, err := tc.query(ctx, task.TaskID)
				if err != nil {
					if e, ok := asRHError(err); ok && e.Transient {
						continue
					}
					record["error"] = mediaFailureCode(err)
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
				n, err := tc.download(ctx, result.URL, io.MultiWriter(f, head))
				_ = f.Close()
				contentType, _, kind := sniffMedia(head.Bytes())
				entry := map[string]any{"output": result.OutputType, "bytes": n, "type": contentType, "fits": mediaResultFits(m.Kind, kind, i+1)}
				if err != nil {
					entry["error"] = mediaFailureCode(err)
				}
				files = append(files, entry)
			}
			record["files"] = files
		}(m)
	}
	wg.Wait()
}
