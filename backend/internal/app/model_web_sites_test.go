package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// namedSite serves every host name (serveWebSite): two readable pages, a page that redirects to another site, and a
// handler for that other site, elsewhere.test, which fails the test if anything is ever requested of it.
func namedSite(t *testing.T) {
	page := func(title, fact string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprintf(w, `<html lang="en"><head><title>%s</title></head><body><article><h1>%s</h1>
<p>%s</p>
<p>The second paragraph gives enough words for the reader to treat this as the article body rather than navigation.</p></article></body></html>`, title, title, fact)
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "User-agent: *\nAllow: /\n") })
	mux.HandleFunc("/article", page("Release notes", "ARTICLE-FACT: version 2.4 adds offline search across every workspace document."))
	mux.HandleFunc("/more", page("More notes", "MORE-FACT: version 2.5 adds shared folders and keeps offline search on the device."))
	mux.HandleFunc("/hop", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://elsewhere.test/landing", http.StatusFound)
	})
	mux.HandleFunc("elsewhere.test/", func(_ http.ResponseWriter, r *http.Request) {
		t.Errorf("a site no member named was requested: %s%s", r.Host, r.URL.Path)
	})
	serveWebSite(t, mux)
}

// importPage reads an address as a member does (the pages a message names are read this way) and returns the saved
// source's revision: status 201 for a new source, 200 when the same text was saved before.
func importPage(t *testing.T, h *harness, c *http.Cookie, tid, address, operation string, status int) string {
	t.Helper()
	doc := h.request(t, c, "POST", "/tenants/"+tid+"/knowledge/sources/web", map[string]any{"url": address, "operationId": operation,
		"fit": map[string]any{"revisionIds": []string{}, "share": 1}}, status)
	return doc["currentRevisionId"].(string)
}

func snapshotSites(t *testing.T, h *harness, tid, run string) string {
	t.Helper()
	return scalar(t, h, "SELECT coalesce(((execution_snapshot::jsonb)->'webReads'->'hosts')::text,'') FROM runs WHERE tenant_id=$1 AND id=$2", tid, run)
}

// Named sites only (AWWO_MODEL_WEB_READS=named): a run whose quoted source a member had AwwO read may ask for pages on
// that source's site and its www. form, and on no other. Another site and a subdomain are refused before anything is
// counted; a page on the named site that redirects to another site is counted and not followed; the other site is
// never requested.
func TestPostgresModelPageReadsNamedSitesOnly(t *testing.T) {
	namedSite(t)
	const request = `AWWO-READ-PAGES {"urls":["http://www.site.test/more","http://elsewhere.test/page","http://docs.site.test/guide","http://site.test/hop"]}`
	var mu sync.Mutex
	var calls []observedPiCall
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		mu.Lock()
		calls = append(calls, call)
		first := len(calls) == 1
		mu.Unlock()
		if first {
			streamText(w, request)
			completePi(w, request)
			return
		}
		completePi(w, "Version 2.5 adds shared folders (http://www.site.test/more).")
	})
	defer pi.Close()
	h := modelReadsHarness(t, pi.URL)
	h.a.cfg.ModelWebReadsNamedOnly = true
	c, tid, _ := h.register(t, "model-reads-named@example.test")
	_, _, sid := h.fixture(t, c, tid)
	revision := importPage(t, h, c, tid, "http://site.test/article", "named-sites-import", 201)
	id := h.request(t, c, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": sid, "prompt": "What came after version 2.4?",
		"knowledgeRevisionIds": []string{revision}, "operationId": "named-sites-run"}, 202)["id"].(string)
	done := h.awaitRun(t, c, tid, id, "completed")
	if done["output"] != "Version 2.5 adds shared folders (http://www.site.test/more)." {
		t.Fatalf("stored output: %#v", done["output"])
	}
	if sites := snapshotSites(t, h, tid, id); sites != `["site.test"]` {
		t.Fatalf("the run froze the sites %s", sites)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 2 {
		t.Fatalf("want two model calls, got %d", len(calls))
	}
	note := webReadSitesNote(&webReadPlan{Hosts: []string{"site.test"}})
	if !strings.Contains(calls[0].SystemPrompt, webReadFrame+note) || !strings.Contains(calls[1].SystemPrompt, webReadFrame+note) {
		t.Fatalf("both calls are told the named sites:\n%s", calls[0].SystemPrompt)
	}
	for _, want := range []string{"ARTICLE-FACT", "MORE-FACT", "- read: http://www.site.test/more",
		"- not read: http://elsewhere.test/page (it is not on a site this task's own sources name)",
		"- not read: http://docs.site.test/guide (it is not on a site this task's own sources name)",
		"- not read: http://site.test/hop (it is not on a site this task's own sources name)"} {
		if !strings.Contains(calls[1].Prompt, want) {
			t.Fatalf("second call's prompt lacks %q:\n%s", want, calls[1].Prompt)
		}
	}
	// Two reads counted for the run: the page on the www. form, and the one whose redirect left the site.
	if reads := scalar(t, h, "SELECT coalesce(string_agg(host||':'||status||':'||coalesce(error_code,''),',' ORDER BY operation_id),'') FROM web_reads WHERE tenant_id=$1 AND operation_id LIKE $2", tid, "model:"+id+":%"); reads != "www.site.test:ok:,site.test:failed:model_host_not_named" {
		t.Fatalf("the run's reads: %s", reads)
	}
}

// What names a site is a member's own read of a page the run quotes, and nothing else: a run that quotes nothing, and
// a run that quotes a page only a model's read saved, are offered no reads and send what they always sent.
func TestPostgresModelPageReadsNamedSitesNeedAMembersRead(t *testing.T) {
	namedSite(t)
	var mu sync.Mutex
	// Each run's request to the worker, whole, by the key its prompt carries.
	bodies := map[string][]map[string]any{}
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test", "models": []map[string]any{{"id": "test-model", "provider": "test", "maxContextTextBytes": 262144}}})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		prompt, _ := body["prompt"].(string)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		http.NewResponseController(w).Flush()
		if strings.Contains(prompt, "ask for the page") && !strings.Contains(prompt, "AwwO read web pages") {
			completePi(w, `AWWO-READ-PAGES {"urls":["http://site.test/article"]}`)
			return
		}
		mu.Lock()
		for _, key := range []string{"NOTHING-QUOTED", "MODEL-READ-QUOTED", "MEMBER-READ-QUOTED"} {
			if strings.Contains(prompt, key) {
				bodies[key] = append(bodies[key], body)
			}
		}
		mu.Unlock()
		completePi(w, "done")
	}))
	defer pi.Close()
	h := modelReadsHarness(t, pi.URL)
	c, tid, _ := h.register(t, "model-reads-unnamed@example.test")
	prefix := "/tenants/" + tid
	sessions := map[string]string{} // each run's conversation
	run := func(prompt, operation string, revisions []string) string {
		_, _, sid := h.fixture(t, c, tid)
		body := map[string]any{"sessionId": sid, "prompt": prompt, "operationId": operation}
		if revisions != nil {
			body["knowledgeRevisionIds"] = revisions
		}
		id := h.request(t, c, "POST", prefix+"/runs", body, 202)["id"].(string)
		h.awaitRun(t, c, tid, id, "completed")
		sessions[id] = sid
		return id
	}
	// Any site: a model's own read saves the article.
	first := run("Please ask for the page", "unnamed-model-read", nil)
	if n := scalar(t, h, "SELECT count(*)::text FROM web_reads WHERE tenant_id=$1 AND operation_id=$2 AND status='ok'", tid, modelReadOperation(first, 1)); n != "1" {
		t.Fatalf("the model's read was not saved: %s", n)
	}
	saved := scalar(t, h, "SELECT current_revision_id FROM knowledge_documents WHERE tenant_id=$1 AND title='Release notes'", tid)
	// The switch off: what the two runs below send and store where page reads do not exist at all.
	h.a.cfg.ModelWebReads = false
	nothingOff := run("NOTHING-QUOTED: say hello", "unnamed-nothing-off", nil)
	modelReadOff := run("MODEL-READ-QUOTED: use the saved page", "unnamed-model-quoted-off", []string{saved})
	// Named sites only, from here on. A member reads another page of the same site, which the runs below do not quote:
	// a member's read names its site only for a run that quotes its page.
	h.a.cfg.ModelWebReads, h.a.cfg.ModelWebReadsNamedOnly = true, true
	if other := importPage(t, h, c, tid, "http://site.test/more", "unnamed-other-import", 201); other == saved {
		t.Fatal("the other page is the same source")
	}
	nothing := run("NOTHING-QUOTED: say hello", "unnamed-nothing", nil)
	modelRead := run("MODEL-READ-QUOTED: use the saved page", "unnamed-model-quoted", []string{saved})
	// The same page once a member has read it (the same text is the same source): now its site is named.
	if again := importPage(t, h, c, tid, "http://site.test/article", "unnamed-member-import", 200); again != saved {
		t.Fatalf("the member's read of the same text made another source: %s, %s", again, saved)
	}
	memberRead := run("MEMBER-READ-QUOTED: use the saved page", "unnamed-member-quoted", []string{saved})
	mu.Lock()
	defer mu.Unlock()
	for key, ids := range map[string][2]string{"NOTHING-QUOTED": {nothingOff, nothing}, "MODEL-READ-QUOTED": {modelReadOff, modelRead}} {
		if sites := snapshotSites(t, h, tid, ids[1]); sites != "" || strings.Contains(scalar(t, h, "SELECT execution_snapshot::text FROM runs WHERE tenant_id=$1 AND id=$2", tid, ids[1]), "webReads") {
			t.Fatalf("%s: a run no member named a site for froze page reads (%s)", key, sites)
		}
		// The whole request and the whole frozen snapshot are what the same run sends and stores with the switch off
		// (AWWO-LAW-013); only the run's and its conversation's own ids differ.
		if len(bodies[key]) != 2 {
			t.Fatalf("%s: want the run with the switch off and the one with named sites, got %d calls", key, len(bodies[key]))
		}
		off, named := bodies[key][0], bodies[key][1]
		// Each request carries its own run's and conversation's ids, which are then set aside.
		for i, body := range []map[string]any{off, named} {
			if body["runId"] != ids[i] || body["sessionId"] != sessions[ids[i]] || sessions[ids[i]] == "" {
				t.Fatalf("%s: request %d carries run %v and conversation %v, want %s and %s", key, i, body["runId"], body["sessionId"], ids[i], sessions[ids[i]])
			}
			delete(body, "runId")
			delete(body, "sessionId")
		}
		if !reflect.DeepEqual(off, named) {
			t.Fatalf("%s: a run no member named a site for sends something else than with the switch off:\n%v\n%v", key, off, named)
		}
		if same := scalar(t, h, "SELECT ((a.execution_snapshot::jsonb)=(b.execution_snapshot::jsonb))::text FROM runs a, runs b WHERE a.tenant_id=$1 AND b.tenant_id=$1 AND a.id=$2 AND b.id=$3", tid, ids[0], ids[1]); same != "true" {
			t.Fatalf("%s: a run no member named a site for freezes something else than with the switch off", key)
		}
	}
	told, _ := bodies["MEMBER-READ-QUOTED"][0]["systemPrompt"].(string)
	if sites := snapshotSites(t, h, tid, memberRead); sites != `["site.test"]` || !strings.Contains(told, "only on these sites") {
		t.Fatalf("a member's read names its site: %s", sites)
	}
}

// namedReadHosts takes a member's finished reads of the pages a run quotes, in the run's own workspace, and nothing
// else, each site once, in the order they were first read, and no more than a plan keeps.
func TestPostgresNamedReadHostsAreAMembersReadsOfQuotedPages(t *testing.T) {
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) { completePi(w, "done") })
	defer pi.Close()
	h := newHarness(t, pi.URL)
	_, tid, _ := h.register(t, "named-hosts@example.test")
	_, elsewhere, _ := h.register(t, "named-hosts-elsewhere@example.test")
	member := scalar(t, h, "SELECT user_id FROM memberships WHERE tenant_id=$1 LIMIT 1", tid)
	at := 0
	add := func(tenant, host, status, operation, document string, actor any) {
		at++
		execSQL(t, h, `INSERT INTO web_reads(id,tenant_id,actor_id,operation_id,url_hash,host,status,document_id,created_at)
			VALUES($1,$2,$3,$4,'hash',$5,$6,$7,now()-interval '1 hour'+$8::int*interval '1 second')`, randomID(), tenant, actor, operation, host, status, document, at)
	}
	add(tid, "site.test", "ok", "member-1", "doc-1", member)
	add(tid, "WWW.Site.Test.", "ok", "member-2", "doc-1", member)    // the same site again
	add(tid, "www.www.site.test", "ok", "member-3", "doc-1", member) // another site, whose key starts with www.
	add(tid, "failed.test", "failed", "member-4", "doc-1", member)
	add(tid, "started.test", "started", "member-5", "doc-1", member)
	add(tid, "no-actor.test", "ok", "member-6", "doc-1", nil)
	add(tid, "model.test", "ok", modelReadOperation("run-1", 1), "doc-1", member)
	add(tid, "unquoted.test", "ok", "member-8", "doc-2", member)
	add(elsewhere, "other-workspace.test", "ok", "member-9", "doc-1", member)
	add(tid, "bad_host.test", "ok", "member-10", "doc-1", member)
	add(tid, strings.Repeat("a", modelReadHostBytes)+".test", "ok", "member-11", "doc-1", member)
	add(tid, "a.b.c.d.e.test", "ok", "member-12", "doc-1", member)
	// Six labels as the member gave it: no model may ask for it, though its key (www.a.b.site.test) has five, so it
	// takes no place among the sites a plan keeps.
	add(tid, "www.www.a.b.site.test", "ok", "member-12b", "doc-1", member)
	add(tid, "second.example", "ok", "member-13", "doc-3", member)
	for i := range modelReadHostsMax {
		add(tid, fmt.Sprintf("more-%d.example", i), "ok", fmt.Sprintf("member-more-%d", i), "doc-1", member)
	}
	// A site read again, last of all: it keeps the place of its first read.
	add(tid, "second.example", "ok", "member-again", "doc-1", member)
	quoted := &knowledgeContext{Items: []knowledgeContextItem{{knowledgeReference: knowledgeReference{DocumentID: "doc-1"}}, {knowledgeReference: knowledgeReference{DocumentID: "doc-3"}}}}
	hosts, err := namedReadHosts(context.Background(), h.db, tid, quoted)
	want := []string{"site.test", "www.site.test", "second.example", "more-0.example", "more-1.example", "more-2.example", "more-3.example", "more-4.example"}
	if err != nil || !reflect.DeepEqual(hosts, want) {
		t.Fatalf("named sites %v (%v), want %v", hosts, err, want)
	}
	if !hostNamed("www.www.site.test", hosts) || !hostNamed("www.site.test", hosts) || hostNamed("model.test", hosts) {
		t.Fatal("the named sites are matched as they were named")
	}
	for _, none := range []*knowledgeContext{nil, {}, {Items: []knowledgeContextItem{{knowledgeReference: knowledgeReference{DocumentID: "doc-9"}}}}} {
		if hosts, err = namedReadHosts(context.Background(), h.db, tid, none); err != nil || len(hosts) != 0 {
			t.Fatalf("a run that quotes no page a member read names no site: %v (%v)", hosts, err)
		}
	}
}

// A canvas run's nodes are held to the same named sites: each node's run freezes them and is told them.
func TestPostgresModelPageReadsNamedSitesInACanvasRun(t *testing.T) {
	namedSite(t)
	var mu sync.Mutex
	var systems []string
	pi := teamProvider(t, func(w http.ResponseWriter, r *http.Request, call observedPiCall) {
		mu.Lock()
		systems = append(systems, call.SystemPrompt)
		mu.Unlock()
		completePi(w, "done")
	})
	defer pi.Close()
	h := modelReadsHarness(t, pi.URL)
	h.a.cfg.ModelWebReadsNamedOnly = true
	c, tid, _ := h.register(t, "model-reads-named-graph@example.test")
	base := "/tenants/" + tid
	canvas, _ := graphFixture(t, h, c, tid)
	revision := importPage(t, h, c, tid, "http://site.test/article", "named-sites-graph-import", 201)
	graph := h.request(t, c, "POST", base+"/canvases/"+canvas+"/graph-runs", map[string]any{"knowledgeRevisionIds": []string{revision}, "operationId": "named-sites-graph"}, 202)
	awaitGraph(t, h, c, base+"/canvases/"+canvas+"/graph-runs/"+graph["id"].(string), "completed")
	if n := scalar(t, h, `SELECT count(*)::text FROM runs WHERE tenant_id=$1 AND ((execution_snapshot::jsonb)->'webReads'->'hosts')::text='["site.test"]'`, tid); n != "3" {
		t.Fatalf("want the three nodes' runs to freeze the named site, got %s", n)
	}
	mu.Lock()
	defer mu.Unlock()
	note := webReadSitesNote(&webReadPlan{Hosts: []string{"site.test"}})
	if len(systems) != 3 {
		t.Fatalf("want three node calls, got %d", len(systems))
	}
	for _, system := range systems {
		if !strings.Contains(system, webReadFrame+note) {
			t.Fatalf("a node's call is not told the named sites:\n%s", system)
		}
	}
}
