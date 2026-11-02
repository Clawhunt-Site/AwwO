package operator_test

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"awwo/backend/internal/operator"
)

// seedLearning builds four workspaces: w-yes, whose owner's consent holds; w-no, which never consented; w-moved, whose
// consent was given by other, who no longer owns it; and w-paused, consenting but suspended. Each has canvas outcomes or
// runs to export.
func seedLearning(t *testing.T, h *harness) {
	t.Helper()
	long := strings.Repeat("x", 256<<10-10) + "opaque-worker-token-9" + strings.Repeat("y", 100)
	for _, sql := range []string{
		"INSERT INTO tenants(id,name,status) VALUES('w-yes','Consenting','active'),('w-no','Not consenting','active'),('w-moved','Handed over','active'),('w-paused','Paused','suspended')",
		`INSERT INTO memberships(tenant_id,user_id,role) VALUES('w-yes','person','owner'),('w-no','other','owner'),('w-moved','person','owner'),('w-moved','other','admin'),
			('w-paused','person','owner')`,
		`INSERT INTO workspace_learning(tenant_id,consent_at,consent_by) VALUES('w-yes',now()-interval '1 hour','person'),('w-moved',now()-interval '1 hour','other'),
			('w-paused',now()-interval '1 hour','person')`,
		"INSERT INTO agents(id,tenant_id,name) VALUES('ag-yes','w-yes','Writer'),('ag-no','w-no','Writer'),('ag-moved','w-moved','Writer'),('ag-paused','w-paused','Writer')",
		"INSERT INTO canvases(id,tenant_id,name) VALUES('cv-yes','w-yes','Yes'),('cv-no','w-no','No'),('cv-moved','w-moved','Moved'),('cv-paused','w-paused','Paused')",
		`INSERT INTO node_sessions(id,tenant_id,canvas_id,node_id,agent_id) VALUES('s-yes','w-yes','cv-yes','n','ag-yes'),('s-qwen','w-yes','cv-yes','q','ag-yes'),
			('s-fed','w-yes','cv-yes','fed','ag-yes'),('s-no','w-no','cv-no','n','ag-no'),('s-moved','w-moved','cv-moved','n','ag-moved'),('s-paused','w-paused','cv-paused','n','ag-paused')`,
		`INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output,actor_id,execution_snapshot,created_at) VALUES
			('r-before','w-yes','s-yes','op-1','h','Before consent','completed','old','person','{}',now()-interval '2 hours'),
			('r-claude','w-yes','s-yes','op-2','h','Write it; api_key: sk-abcdefghijklmnop','completed','Done with opaque-worker-token-9 and pw12x; mail ada@example.com or 13812345678',
				'person','{"model":"bedrock.claude-opus-5-5","instructions":"Be brief. password=hunter22","health":{"models":[{"id":"bedrock.claude-opus-5-5","provider":"bedrock"}]}}',now()-interval '30 minutes'),
			('r-qwen','w-yes','s-qwen','op-3','h','Plan it','failed','','person','{"model":"qwen3.8-27b-p6","health":{"models":[{"id":"qwen3.8-27b-p6","provider":"llmgate"}]}}',now()-interval '29 minutes'),
			('r-qwen2','w-yes','s-qwen','op-3b','h','Plan it again','completed','x','person','{"model":"qwen3.8-27b-p6"}',now()-interval '28 minutes'),
			('r-fed','w-yes','s-fed','op-3c','h','Fed from upstream','completed','x','person','{"model":"qwen3.8-27b-p6"}',now()-interval '27 minutes'),
			('r-alias','w-yes','s-yes','op-4','h','An alias','completed','x','person','{"model":"deepseek-reviewer"}',now()-interval '24 minutes'),
			('r-team','w-yes','s-yes','op-5','h','A team','completed','x','person','{"model":"qwen3.8-27b-p6","team":{}}',now()-interval '23 minutes'),
			('r-byok','w-yes','s-yes','op-6','h','Own key','completed','x','person','{"model":"byok_conn-secret-1_0123456789abcdef"}',now()-interval '22 minutes'),
			('r-market','w-yes','s-yes','op-7','h','Market','completed','The author''s secret method','person','{"model":"qwen3.8-27b-p6","market":{},"instructions":"The author''s instructions"}',now()-interval '21 minutes'),
			('r-media','w-yes','s-yes','op-8','h','Media','completed','x','person','{"media":{}}',now()-interval '20 minutes'),
			('r-no','w-no','s-no','op-9','h','Not consenting','completed','Their work','person','{}',now()-interval '20 minutes'),
			('r-moved','w-moved','s-moved','op-10','h','Moved work','completed','x','person','{}',now()-interval '10 minutes'),
			('r-paused','w-paused','s-paused','op-12','h','Paused work','completed','x','person','{}',now()-interval '10 minutes')`,
		"INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES('m-1','w-yes','s-yes','r-claude','assistant','Bearer abcdefghijklmnop.qrstu')",
		"INSERT INTO run_ratings(tenant_id,run_id,user_id,rating) VALUES('w-yes','r-claude','person',1)",
		`INSERT INTO graph_runs(id,tenant_id,canvas_id,actor_id,operation_id,request_hash,document_version,document,scope,status) VALUES
			('g-yes','w-yes','cv-yes','person','g-op-1','h',1,'{"edges":[{"fromNode":"n","toNode":"fed"}]}','[]','completed'),
			('g-no','w-no','cv-no','person','g-op-2','h',1,'{}','[]','completed'),('g-byok','w-no','cv-no','person','g-op-3','h',1,'{}','[]','completed')`,
		"INSERT INTO graph_run_nodes(tenant_id,graph_id,node_id,ordinal,state,run_id,session_id) VALUES('w-yes','g-yes','fed',0,'done','r-fed','s-fed')",
		`INSERT INTO node_outcomes(tenant_id,canvas_id,graph_id,node_id,run_id,template,model,effort,state,code,ran_at) VALUES
			('w-yes','cv-yes','g-yes','n','r-claude','frontend','bedrock.claude-opus-5-5','medium','done','',now()-interval '30 minutes'),
			('w-no','cv-no','g-no','n',NULL,'review','qwen3.8-27b-p6','','failed','output_limit',now()-interval '20 minutes'),
			('w-no','cv-no','g-byok','n','r-no','review','byok_conn-secret-2_0123456789abcdef','','done','',now()-interval '19 minutes')`,
	} {
		h.exec(t, sql)
	}
	// A run whose output the 256 KiB cut runs through the middle of a secret.
	h.exec(t, `INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output,actor_id,execution_snapshot,created_at)
		VALUES('r-long','w-yes','s-yes','op-11','h','Long','completed',$1,'person','{"model":"qwen3.8-27b-p6"}',now()-interval '15 minutes')`, long)
}

func readLines(t *testing.T, path string) []map[string]any {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	out := []map[string]any{}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 8<<20)
	for scanner.Scan() {
		var line map[string]any
		if err = json.Unmarshal(scanner.Bytes(), &line); err != nil {
			t.Fatal(err)
		}
		out = append(out, line)
	}
	return out
}

// The learning export: every workspace's content-free outcomes, with ids (and a person's own model) as keyed hashes;
// with --content, only where the deployment offers the consent, only the runs of an active workspace whose consent
// holds, admitted after it was given, redacted (the deployment's own secrets and contact details too, whole across the
// cut), with their provider and whether they may train other models; never a market Agent's or a media run; a new
// file only, its owner's alone; content needs an OS root operator.
func TestLearningExport(t *testing.T) {
	h := database(t)
	seedLearning(t, h)
	dir := t.TempDir()
	since, until := time.Now().UTC().Add(-24*time.Hour), time.Now().UTC().Add(time.Minute)
	secrets := []string{"opaque-worker-token-9", "pw12x", "abc", "pw12x"}
	// Content-free: every workspace's outcomes, no ids or words of theirs.
	plain := filepath.Join(dir, "outcomes.jsonl")
	got, err := h.store.LearningExport(h.ctx, operator.LearningExport{Out: plain, Since: since, Until: until}, operator.Actor{EffectiveUID: 1000})
	if err != nil || got.Outcomes != 3 || got.Runs != 0 || len(got.SHA256) != 64 || got.Bytes == 0 {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err = os.Stat(plain + ".partial"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the export left its partial file", err)
	}
	raw, _ := os.ReadFile(plain)
	for _, word := range []string{"w-yes", "w-no", "cv-yes", "g-yes", "r-claude", "Their work", "Write it", "conn-secret-2"} {
		if strings.Contains(string(raw), word) {
			t.Fatalf("the content-free export names %q", word)
		}
	}
	byTemplate := map[string][]map[string]any{}
	for _, line := range readLines(t, plain) {
		byTemplate[line["template"].(string)] = append(byTemplate[line["template"].(string)], line)
	}
	frontend, review := byTemplate["frontend"], byTemplate["review"]
	if len(frontend) != 1 || len(review) != 2 || frontend[0]["type"] != "outcome" || frontend[0]["workspace"] == review[0]["workspace"] ||
		review[0]["workspace"] != review[1]["workspace"] {
		t.Fatal(byTemplate)
	}
	for _, line := range review {
		if line["code"] == "output_limit" && line["run"] != "" {
			t.Fatal("a node refused at admission given a run's hash", line)
		}
		if line["code"] == "" && !strings.HasPrefix(line["model"].(string), "byok:") {
			t.Fatal("a person's own model named", line)
		}
	}
	if info, err := os.Stat(plain); err != nil || (info.Mode().Perm()&0o077 != 0 && os.PathSeparator == '/') {
		t.Fatal("the file is readable by others", err)
	}
	// Never over a file that exists.
	if _, err = h.store.LearningExport(h.ctx, operator.LearningExport{Out: plain, Since: since, Until: until}, operator.Actor{EffectiveUID: 1000}); !errors.Is(err, operator.ErrInput) {
		t.Fatal("overwrote a file", err)
	}
	content := filepath.Join(dir, "content.jsonl")
	ask := operator.LearningExport{Out: content, Since: since, Until: until, Content: true, ConsentOffered: true, Secrets: secrets}
	// Content needs a root operator, and the deployment offering the consent.
	if _, err = h.store.LearningExport(h.ctx, ask, operator.Actor{EffectiveUID: 1000}); !errors.Is(err, operator.ErrOperator) {
		t.Fatal("content without a root operator", err)
	}
	off := ask
	off.ConsentOffered = false
	if _, err = h.store.LearningExport(h.ctx, off, operator.Actor{EffectiveUID: 0}); !errors.Is(err, operator.ErrExportRefused) {
		t.Fatal("content where the deployment does not offer the consent", err)
	}
	if _, err = os.Stat(content); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a refused export left its file", err)
	}
	got, err = h.store.LearningExport(h.ctx, ask, operator.Actor{EffectiveUID: 0})
	if err != nil || got.Outcomes != 3 || got.Runs != 8 || got.Consenting != 1 || got.DeploymentSecrets != 2 {
		t.Fatalf("%+v %v", got, err)
	}
	raw, _ = os.ReadFile(content)
	for _, word := range []string{"sk-abcdefghijklmnop", "hunter22", "abcdefghijklmnop.qrstu", "opaque-worker-token-9", "opaque-worker", "pw12x",
		"ada@example.com", "13812345678", "Their work", "Before consent", "Not consenting", "Moved work", "Paused work", "The author", "conn-secret-1"} {
		if strings.Contains(string(raw), word) {
			t.Fatalf("the content export holds %q", word)
		}
	}
	runs := map[string]map[string]any{}
	for _, line := range readLines(t, content) {
		if line["type"] == "run" {
			runs[line["prompt"].(string)] = line
		}
	}
	claude, long := runs["Write it; [REDACTED]"], runs["Long"]
	if claude == nil || long == nil || runs["Market"] != nil || runs["Media"] != nil {
		t.Fatal(runs)
	}
	// Every run is for evaluation only: none is marked to train, whatever its model.
	for prompt, line := range runs {
		if line["trainable"] != false {
			t.Errorf("%q: trainable %v", prompt, line["trainable"])
		}
	}
	if claude["provider"] != "bedrock" || claude["rating"] != float64(1) || !strings.Contains(claude["system"].(string), "Be brief.") ||
		!strings.HasPrefix(runs["Own key"]["model"].(string), "byok:") || len(long["output"].(string)) > 256<<10 || !strings.HasSuffix(long["output"].(string), "[REDACTED]") {
		t.Fatal(claude, len(long["output"].(string)))
	}
	if !strings.Contains(claude["output"].(string), "Done with [REDACTED] and [REDACTED]; mail [REDACTED] or [REDACTED]") {
		t.Fatal("the deployment's secrets and the contact details", claude["output"])
	}
	// A consent withdrawn while the export ran takes its file away.
	withdrawn := filepath.Join(dir, "withdrawn.jsonl")
	defer operator.SetLearningExportCheck(func() {
		h.exec(t, "UPDATE workspace_learning SET consent_at=NULL,consent_by=NULL WHERE tenant_id='w-yes'")
	})()
	ask.Out = withdrawn
	if _, err = h.store.LearningExport(h.ctx, ask, operator.Actor{EffectiveUID: 0}); !errors.Is(err, operator.ErrExportRefused) {
		t.Fatal("an export under a withdrawn consent", err)
	}
	for _, path := range []string{withdrawn, withdrawn + ".partial"} {
		if _, err = os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("the export under a withdrawn consent left a file", path, err)
		}
	}
	if _, err = h.store.LearningExport(h.ctx, operator.LearningExport{Out: filepath.Join(dir, "wide.jsonl"), Since: since.Add(-200 * 24 * time.Hour), Until: until},
		operator.Actor{EffectiveUID: 0}); !errors.Is(err, operator.ErrInput) {
		t.Fatal("a window over three months", err)
	}
}

// A window with more runs than one export carries is refused, not cut short.
func TestLearningExportRefusesMoreRunsThanItCarries(t *testing.T) {
	h := database(t)
	seedLearning(t, h)
	defer operator.SetLearningExportMaxRuns(2)()
	out := filepath.Join(t.TempDir(), "content.jsonl")
	_, err := h.store.LearningExport(h.ctx, operator.LearningExport{Out: out, Since: time.Now().UTC().Add(-24 * time.Hour), Until: time.Now().UTC().Add(time.Minute),
		Content: true, ConsentOffered: true}, operator.Actor{EffectiveUID: 0})
	if !errors.Is(err, operator.ErrExportRefused) || !strings.Contains(err.Error(), "narrower") {
		t.Fatal(err)
	}
	for _, path := range []string{out, out + ".partial"} {
		if _, err = os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("a refused export left a file", path, err)
		}
	}
}
