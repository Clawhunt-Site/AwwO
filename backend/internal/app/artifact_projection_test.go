package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func projectionFixture(content string) string {
	value, _ := json.Marshal(map[string]any{"summary": "verified checks", "artifact": map[string]any{"name": "project.zip", "content": base64.StdEncoding.EncodeToString([]byte(content)), "encoding": "base64"}})
	return string(value)
}

func TestFileDeliveryProjectionOmitsBytesAndOnlyLinksMatchingStoredReceipt(t *testing.T) {
	content := "PK sensitive archive fixture"
	raw := projectionFixture(content)
	sum := sha256.Sum256([]byte(content))
	good := deliveryReference{ID: "stored-id", Name: "project.zip", SHA256: hex.EncodeToString(sum[:]), Size: len(content)}
	for _, refs := range []map[string]deliveryReference{nil, {"other": good}, {"artifact": {ID: "wrong", Name: good.Name, SHA256: "wrong", Size: good.Size}}} {
		out, changed := projectFileDelivery(raw, refs)
		if !changed || strings.Contains(out, "awwo-file:") || strings.Contains(out, base64.StdEncoding.EncodeToString([]byte(content))) || !strings.Contains(out, `"contentOmitted":true`) {
			t.Fatal("unsafe metadata projection", out)
		}
	}
	out, _ := projectFileDelivery(raw, map[string]deliveryReference{"artifact": good})
	if !strings.Contains(out, artifactRefPrefix+"stored-id") || strings.Contains(out, "contentOmitted") {
		t.Fatal("stored reference missing", out)
	}
	plain := "ordinary assistant answer"
	if out, changed := projectFileDelivery(plain, nil); changed || out != plain {
		t.Fatal("plain prose changed")
	}
}

func TestHistoryRemovesFileTransportBeforeContextTrimmingWithoutMutatingSnapshot(t *testing.T) {
	if boundedHistoryWithLimits([]json.RawMessage{}, 0, 4096, 32) == nil {
		t.Fatal("frozen empty history must remain an explicit array")
	}
	user := json.RawMessage(`{"role":"user","content":"Build a game"}`)
	assistant, _ := json.Marshal(map[string]string{"role": "assistant", "content": projectionFixture(strings.Repeat("archive-bytes", 6000))})
	history := []json.RawMessage{user, assistant}
	clean := boundedHistoryWithLimits(history, 0, 4096, 32)
	if len(clean) != 2 || strings.Contains(string(clean[1]), base64.StdEncoding.EncodeToString([]byte("archive-bytesarchive-bytes"))) || !strings.Contains(string(clean[1]), "contentOmitted") {
		t.Fatal("history still contained bytes or lost pair")
	}
	if string(history[1]) != string(assistant) {
		t.Fatal("frozen history mutated")
	}
}

func TestInvalidFileProjectionDoesNotClaimValidPendingAndHistoryOmitsExplicitMalformedTransport(t *testing.T) {
	for _, raw := range []string{`{"artifact":{"name":"a.zip","content":"not base64!","encoding":"base64"}}`, `{"artifact":{"name":"a.zip","content":"opaque","encoding":"unknown"}}`} {
		out, _ := projectFileDelivery(raw, nil)
		if !strings.Contains(out, `"invalidContent":true`) || strings.Contains(out, "opaque") || strings.Contains(out, "not base64!") {
			t.Fatal("invalid file presented as pending", out)
		}
	}
	malformed := `Delivery follows: {"artifact":{"encoding":"base64","content":"` + strings.Repeat("UEsDB", 10000)
	if strings.Contains(projectHistoryDelivery(malformed), "UEsDB") {
		t.Fatal("malformed transport leaked into history")
	}
	for _, prefix := range []string{`{"delivery_project":{"content":"`, `Delivery follows: {"delivery_project":{"content":"`} {
		truncated := prefix + strings.Repeat("UEsDBAoAAAAA", 1000)
		if strings.Contains(projectHistoryDelivery(truncated), "UEsDB") {
			t.Fatal("content-first unnamed truncated ZIP leaked")
		}
		assistant, _ := json.Marshal(map[string]string{"role": "assistant", "content": truncated})
		clean := boundedHistoryWithLimits([]json.RawMessage{json.RawMessage(`{"role":"user","content":"keep this task"}`), assistant}, 0, 32768, 32)
		if len(clean) != 2 || strings.Contains(string(clean[1]), "UEsDB") || !strings.Contains(string(clean[0]), "keep this task") {
			t.Fatal("history fallback lost user task or kept file bytes")
		}
	}
	for _, plain := range []string{"ordinary source code", `const payload = { name: 'test', content: 'source text' };`, `const payload = {"encoding":"base64","content":"short source example"};`, "complete original user task"} {
		if projectHistoryDelivery(plain) != plain {
			t.Fatal("non-transport source was truncated")
		}
	}
}

func TestPostgresDeliveryProjectionCoversRecoveryMessagesEventsAndModelHistory(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	cookie, tid, _ := h.register(t, "projection@example.test")
	cid, _, sid := h.fixture(t, cookie, tid)
	rid, op := randomID(), "artifact-projection-operation"
	prompt, content := "Build a game", "PK archive bytes stay out of transcripts"
	raw := projectionFixture(content)
	body, _ := json.Marshal(struct{ SessionID, Prompt string }{sid, prompt})
	if _, e := h.db.Exec(ctx, `INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,output) VALUES($1,$2,$3,$4,$5,$6,'completed',$7)`, rid, tid, sid, op, tokenHash(string(body)), prompt, raw); e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(ctx, `INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES($1,$2,$3,$4,'assistant',$5)`, randomID(), tid, sid, rid, raw); e != nil {
		t.Fatal(e)
	}
	event, _ := json.Marshal(map[string]string{"type": "completed", "text": raw})
	if _, e := h.db.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, rid, event); e != nil {
		t.Fatal(e)
	}
	base := "/tenants/" + tid
	check := func(wantRef bool) {
		t.Helper()
		values := []any{
			h.request(t, cookie, "GET", base+"/runs/"+rid, nil, 200),
			h.request(t, cookie, "GET", base+"/runs?sessionId="+sid, nil, 200),
			h.request(t, cookie, "GET", base+"/sessions/"+sid+"/messages", nil, 200),
			h.request(t, cookie, "POST", base+"/runs", map[string]string{"sessionId": sid, "prompt": prompt, "operationId": op}, 200),
		}
		_, streamed := h.readRaw(t, cookie, base+"/runs/"+rid+"/events", 200)
		values = append(values, string(streamed))
		for _, value := range values {
			encoded, _ := json.Marshal(value)
			if strings.Contains(string(encoded), base64.StdEncoding.EncodeToString([]byte(content))) {
				t.Fatal("raw file bytes exposed")
			}
			if wantRef && !strings.Contains(string(encoded), artifactRefPrefix) {
				t.Fatal("durable reference missing", string(encoded))
			}
			if !wantRef && !strings.Contains(string(encoded), "contentOmitted") {
				t.Fatal("missing safe pending projection")
			}
		}
	}
	check(false)
	n := fileNode(true)
	n.ID = "node-a"
	vals, files, e := graphOutputFiles(n, raw)
	if e != nil {
		t.Fatal(e)
	}
	if _, e := h.db.Exec(ctx, `CREATE FUNCTION reject_delivery_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected projection failure'; END $$;
		CREATE TRIGGER reject_delivery_projection BEFORE UPDATE ON run_events FOR EACH ROW EXECUTE FUNCTION reject_delivery_projection()`); e != nil {
		t.Fatal(e)
	}
	if _, e := h.a.storeArtifacts(ctx, tid, cid, rid, n.ID, raw, vals, files); e == nil {
		t.Fatal("injected publication failure was hidden")
	}
	var artifactCount int
	if e := h.db.QueryRow(ctx, "SELECT count(*) FROM artifacts WHERE tenant_id=$1 AND run_id=$2", tid, rid).Scan(&artifactCount); e != nil || artifactCount != 0 {
		t.Fatal("failed transaction published artifact", e)
	}
	for _, query := range []string{"SELECT output FROM runs WHERE id=$1", "SELECT content FROM messages WHERE run_id=$1 AND role='assistant'", "SELECT data->>'text' FROM run_events WHERE run_id=$1 AND data->>'type'='completed'"} {
		var actual string
		if e := h.db.QueryRow(ctx, query, rid).Scan(&actual); e != nil || actual != raw {
			t.Fatal("failed transaction mutated transcript", e)
		}
	}
	check(false)
	if _, e := h.db.Exec(ctx, "DROP TRIGGER reject_delivery_projection ON run_events; DROP FUNCTION reject_delivery_projection()"); e != nil {
		t.Fatal(e)
	}
	stored, e := h.a.storeArtifacts(ctx, tid, cid, rid, n.ID, raw, vals, files)
	if e != nil {
		t.Fatal(e)
	}
	check(true)
	for _, query := range []string{"SELECT output FROM runs WHERE id=$1", "SELECT content FROM messages WHERE run_id=$1 AND role='assistant'", "SELECT data->>'text' FROM run_events WHERE run_id=$1 AND data->>'type'='completed'"} {
		var actual string
		if e := h.db.QueryRow(ctx, query, rid).Scan(&actual); e != nil || actual != stored {
			t.Fatal("storage not atomically projected", e)
		}
	}
	var bytes []byte
	if e := h.db.QueryRow(ctx, "SELECT content FROM artifacts WHERE tenant_id=$1 AND run_id=$2", tid, rid).Scan(&bytes); e != nil || string(bytes) != content {
		t.Fatal("artifact bytes lost", e)
	}
	// Existing historical rows receive references only in their exact scope.
	if _, e := h.db.Exec(ctx, "UPDATE runs SET output=$2 WHERE id=$1", rid, raw); e != nil {
		t.Fatal(e)
	}
	if output, e := projectStoredDelivery(ctx, h.db, tid, rid, raw); e != nil || output != stored {
		t.Fatal("historical projection", e)
	}
	var unchanged string
	if e := h.db.QueryRow(ctx, "SELECT output FROM runs WHERE id=$1", rid).Scan(&unchanged); e != nil || unchanged != raw {
		t.Fatal("read projection changed historical database row", e)
	}
	for _, scope := range [][2]string{{tid, "other-run"}, {"other-tenant", rid}} {
		if output, e := projectStoredDelivery(ctx, h.db, scope[0], scope[1], raw); e != nil || strings.Contains(output, artifactRefPrefix) {
			t.Fatal("reference scope escaped", e)
		}
	}
	if _, e := h.db.Exec(ctx, "UPDATE artifacts SET node_id='other-node' WHERE tenant_id=$1 AND run_id=$2", tid, rid); e != nil {
		t.Fatal(e)
	}
	if output, e := projectStoredDelivery(ctx, h.db, tid, rid, raw); e != nil || strings.Contains(output, artifactRefPrefix) {
		t.Fatal("wrong node acquired reference", e)
	}
	// Even a legacy unprojected assistant output stays out of a team's frozen model context.
	if _, e := h.db.Exec(ctx, "UPDATE runs SET output=$2 WHERE id=$1", rid, raw); e != nil {
		t.Fatal(e)
	}
	history, _, e := completedTeamHistory(ctx, h.db, tid, sid)
	if e != nil || strings.Contains(string(history[1]), base64.StdEncoding.EncodeToString([]byte(content))) {
		t.Fatal("model history leaked transport", e)
	}
}
