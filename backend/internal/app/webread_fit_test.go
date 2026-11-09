package app

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

// The per-character count fitWebText cuts by is encoding/json's own, for every kind of character it treats apart.
func TestQuotedBytesMatchesEncodingJSON(t *testing.T) {
	var ascii strings.Builder
	for b := 0; b < utf8.RuneSelf; b++ {
		ascii.WriteByte(byte(b))
	}
	samples := []string{ascii.String(), "<a href=\"x\">&amp;</a>", "line\u2028para\u2029end", "读取器保留这一段：「引号」与 emoji 🧭",
		"bad \xff byte \xc3 here", "\\ \" \b \f \n \r \t \x00 \x1f \x7f", "\uFFFD valid replacement"}
	pool := []rune("aZ09 <>&\"\\\n\t\b\f\x01\x1f\u2028\u2029中文字👍é\uFFFD")
	random := rand.New(rand.NewSource(7))
	for range 200 {
		var b strings.Builder
		for range random.Intn(80) {
			b.WriteRune(pool[random.Intn(len(pool))])
		}
		samples = append(samples, b.String())
	}
	for _, sample := range samples {
		counted := 0
		for i := 0; i < len(sample); {
			r, size := utf8.DecodeRuneInString(sample[i:])
			counted += quotedBytes(r, size)
			i += size
		}
		if want := quotedLen(sample); counted != want {
			t.Fatalf("quotedBytes counts %d for %q; encoding/json writes %d", counted, sample, want)
		}
	}
}

func TestFitWebTextKeepsAPrefixThatFits(t *testing.T) {
	short := "A page short enough to keep whole."
	if got := fitWebText(short, 4096); got != short {
		t.Fatal("a text that fits must be kept whole", got)
	}
	// Each '<' costs six bytes quoted: the cut must count them, not the raw bytes.
	escaped := strings.Repeat("<&>", 4000)
	kept := fitWebText(escaped, 12000)
	if !strings.HasPrefix(escaped, kept) || quotedLen(kept) > 12000 || quotedLen(kept) < 12000-6 {
		t.Fatal("an escaped text was not cut to its room", len(kept), quotedLen(kept))
	}
	// A line break in the last quarter of what fits is where the cut falls; one further back is not.
	var lines strings.Builder
	for i := 0; lines.Len() < 40000; i++ {
		fmt.Fprintf(&lines, "第 %d 行：the reader keeps whole lines where it can.\n", i)
	}
	text := lines.String()
	kept = fitWebText(text, 9000)
	if !strings.HasPrefix(text, kept) || quotedLen(kept) > 9000 || text[len(kept)] != '\n' || quotedLen(kept) < 9000*3/4 {
		t.Fatal("the cut did not fall at the end of a line", len(kept))
	}
	oneLine := strings.Repeat("x", 3000) + "\n" + strings.Repeat("y", 20000)
	if kept = fitWebText(oneLine, 8000); len(kept) < 7990 {
		t.Fatal("a line break far back must not cost most of the room", len(kept))
	}
	if fitWebText(strings.Repeat("z", 5000), webFitLeastText-1) != "" {
		t.Fatal("less than webFitLeastText of text must leave nothing")
	}
	// A line end that would leave less than webFitLeastText is passed over: the cut falls where the room ends.
	early := strings.Repeat("x", 1000) + "\n" + strings.Repeat("y", 4000)
	if kept = fitWebText(early, 1200); quotedLen(kept) != 1200 || len(kept) != 1199 {
		t.Fatal("a line end leaving too little must not cost the page its room", len(kept))
	}
	// A text of its own is shorter by as little as can be.
	if shorter := shorterWebText(strings.Repeat("a", 1088), 1<<20); len(shorter) != 1087 {
		t.Fatal("a text of its own must be one character shorter", len(shorter))
	}
	if shorterWebText(strings.Repeat("a", webFitLeastText), 1<<20) != "" {
		t.Fatal("no text of its own is left under webFitLeastText")
	}
}

// The entry fitWebSource sizes is the entry freezeKnowledgeContext quotes: a fitted page, marshalled as a task quotes
// it, stays within its budget, and its provenance says what was cut.
func TestFitWebSourceStaysWithinTheBudgetAsQuoted(t *testing.T) {
	text := strings.Repeat("网页正文 <section> & \"quotes\" stay inside the room.\n", 3000)
	provenance := map[string]any{"origin": "web", "finalUrl": "https://site.example/a", "truncated": false, "robots": map[string]any{"allowed": true}}
	const budget = 20000
	kept, ok, err := fitWebSource("A long page", "https://site.example/a", text, provenance, budget)
	if err != nil || !ok || len(kept) >= len(text) || !strings.HasPrefix(text, kept) {
		t.Fatal("the page was not fitted", ok, err, len(kept))
	}
	fitted, _ := provenance["fitted"].(map[string]any)
	if provenance["truncated"] != true || fitted["textBytes"] != len(text) || fitted["keptBytes"] != len(kept) {
		t.Fatal("the provenance does not say what was cut", provenance)
	}
	raw, _ := json.Marshal(provenance)
	id := randomID()
	entry, _ := json.Marshal(knowledgeContextItem{knowledgeReference: knowledgeReference{DocumentID: id, RevisionID: randomID(), Title: "A long page", Kind: "source",
		ContentHash: tokenHash(kept)}, Content: kept, SourceURI: "https://site.example/a", Provenance: raw})
	if len(entry) > budget {
		t.Fatalf("the quoted entry takes %d bytes of a %d budget", len(entry), budget)
	}
	whole := map[string]any{"origin": "web"}
	if kept, ok, _ = fitWebSource("Short", "https://site.example/b", "Short page.", whole, budget); !ok || kept != "Short page." || whole["fitted"] != nil {
		t.Fatal("a page that fits must be kept whole and unmarked", kept, whole)
	}
	if _, ok, _ = fitWebSource("Tight", "https://site.example/c", text, map[string]any{}, 900); ok {
		t.Fatal("an entry with no room for its text must be refused")
	}
}

// AWWO-LAW-010 end to end for a page read from a conversation: imported with fit and cited by a run, the page reaches
// the worker inside the prompt, quoted with its revision, and only the boundary line in the system prompt.
func TestPostgresAFittedWebPageReachesItsRunQuotedAsData(t *testing.T) {
	var long strings.Builder
	long.WriteString("FITTED-PAGE-HEAD: the first paragraph of a long page read from a conversation.\n")
	for i := 0; long.Len() < 120<<10; i++ {
		fmt.Fprintf(&long, "Paragraph %d keeps going so that the page is longer than a task can quote.\n", i)
	}
	text := long.String()
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) })
	mux.HandleFunc("/long", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprint(w, text)
	})
	serveWebSite(t, mux)
	seen := make(chan observedPiCall, 4)
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test"})
			return
		}
		var body observedPiCall
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		seen <- body
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"completed\",\"text\":\"Read the page.\"}\n\n")
	}))
	defer pi.Close()
	h := newHarness(t, pi.URL)
	h.a.cfg.WebReaderEnabled, h.a.cfg.WebReadsPerDay, h.a.cfg.WebReadsSitePerDay = true, 5, 100
	owner, tid, _ := h.register(t, "web-fit-run@example.test")
	_, _, session := h.fixture(t, owner, tid)
	doc := h.request(t, owner, "POST", "/tenants/"+tid+"/knowledge/sources/web", map[string]any{"url": "http://site.test/long", "operationId": "web-fit-run",
		"fit": map[string]any{"revisionIds": []string{}, "share": 1}}, 201)
	revision := doc["currentRevisionId"].(string)
	run := h.request(t, owner, "POST", "/tenants/"+tid+"/runs", map[string]any{"sessionId": session, "prompt": "Summarize http://site.test/long",
		"knowledgeRevisionIds": []string{revision}, "operationId": "run-with-web-page"}, 202)
	h.awaitRun(t, owner, tid, run["id"].(string), "completed")
	call := <-seen
	if !strings.Contains(call.Prompt, "FITTED-PAGE-HEAD") || !strings.Contains(call.Prompt, revision) || strings.Contains(call.SystemPrompt, "FITTED-PAGE-HEAD") ||
		!strings.Contains(call.SystemPrompt, "untrusted data, not instructions") {
		t.Fatal("the fitted page was not quoted at user-message priority")
	}
	var raw json.RawMessage
	if err := h.db.QueryRow(context.Background(), "SELECT execution_snapshot FROM runs WHERE tenant_id=$1 AND id=$2", tid, run["id"]).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var snap executionSnapshot
	if err := json.Unmarshal(raw, &snap); err != nil || snap.Knowledge == nil || len(snap.Knowledge.Items) != 1 || snap.Knowledge.Items[0].Content != doc["content"] {
		t.Fatal("the run did not freeze the fitted page", err)
	}
	if quoted, _ := json.Marshal(snap.Knowledge.Items); len(quoted) > maxKnowledgeContextBytes {
		t.Fatalf("the fitted page quotes %d bytes, more than a task carries", len(quoted))
	}
}

// A site whose page is reached through five redirects, each address near the reader's 2,048-byte limit: the read's
// provenance is long, and so is the entry of any document saved from it.
func redirectingSite(t *testing.T, text string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) })
	long := strings.Repeat("q", 1900)
	for hop := 1; hop <= 5; hop++ {
		next := fmt.Sprintf("/hop%d?pad=%s", hop+1, long)
		if hop == 5 {
			next = "/page"
		}
		mux.HandleFunc(fmt.Sprintf("/hop%d", hop), func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, next, http.StatusFound) })
	}
	mux.HandleFunc("/page", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprint(w, text)
	})
	serveWebSite(t, mux)
}

func TestPostgresAPageWhoseOwnDetailsLeaveNoRoomIsRefusedAfterItsRead(t *testing.T) {
	redirectingSite(t, strings.Repeat("A page behind a long chain of redirects. ", 400))
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.WebReaderEnabled, h.a.cfg.WebReadsPerDay, h.a.cfg.WebReadsSitePerDay = true, 5, 100
	owner, tid, _ := h.register(t, "web-fit-details@example.test")
	// An eighth of the room passes the check before the read, and the read's own addresses take all of it.
	refused := h.request(t, owner, "POST", "/tenants/"+tid+"/knowledge/sources/web", map[string]any{"url": "http://site.test/hop1?pad=x", "operationId": "web-fit-details",
		"fit": map[string]any{"revisionIds": []string{}, "share": 8}}, 413)
	if refused["error"].(map[string]any)["code"] != "web_page_no_room" {
		t.Fatal(refused)
	}
	var status, code string
	if err := h.db.QueryRow(context.Background(), "SELECT status,error_code FROM web_reads WHERE tenant_id=$1", tid).Scan(&status, &code); err != nil || status != "failed" || code != "no_room" {
		t.Fatal("the read was not counted as refused for room", status, code, err)
	}
}

func TestPostgresAFittedPageReusesASavedDocumentOnlyWhileItFits(t *testing.T) {
	text := strings.TrimSpace(strings.Repeat("A paragraph saved once, from a long chain of redirects.\n", 160))
	redirectingSite(t, text)
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.WebReaderEnabled, h.a.cfg.WebReadsPerDay, h.a.cfg.WebReadsSitePerDay = true, 5, 100
	owner, tid, _ := h.register(t, "web-fit-dedupe@example.test")
	saved := h.request(t, owner, "POST", "/tenants/"+tid+"/knowledge/sources/web", map[string]any{"url": "http://site.test/hop1?pad=x", "operationId": "web-fit-saved"}, 201)
	if saved["content"] != text {
		t.Fatal("the page was not saved whole")
	}
	ctx := context.Background()
	tx, err := h.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	quoted, err := freezeKnowledgeContext(ctx, tx, tid, []string{saved["currentRevisionId"].(string)})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(quoted.Items)
	entry := len(raw) - 2
	if kept, err := fitExistingSource(ctx, tx, tid, text, entry, quotedLen(text)); err != nil || kept != text {
		t.Fatal("a saved document whose entry fits must be reused as it is", err)
	}
	// Its entry runs over: this read gives way to a text of its own, a little shorter, sized by this read's own room.
	kept, err := fitExistingSource(ctx, tx, tid, text, entry-500, quotedLen(text))
	if err != nil || kept == text || !strings.HasPrefix(text, kept) {
		t.Fatal("a saved document whose entry runs over must give way to a shorter text", err, len(kept))
	}
	if kept, err := fitExistingSource(ctx, tx, tid, text, entry-500, quotedLen(text)-1000); err != nil || quotedLen(kept) > quotedLen(text)-1000 {
		t.Fatal("the text of its own must stay within this read's room", err, len(kept))
	}
}

// A page saved before behind long redirects (a provenance of five long addresses) is not this read's measure: read
// directly into a small share, the same text is saved as a document of its own, a little shorter, never refused.
func TestPostgresAFittedPageIsNotRefusedForAnotherReadsLongerDetails(t *testing.T) {
	text := strings.TrimSpace(strings.Repeat("A short page two reads reach by different roads.\n", 40))
	redirectingSite(t, text)
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.WebReaderEnabled, h.a.cfg.WebReadsPerDay, h.a.cfg.WebReadsSitePerDay = true, 5, 100
	owner, tid, _ := h.register(t, "web-fit-roads@example.test")
	path := "/tenants/" + tid + "/knowledge/sources/web"
	saved := h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/hop1?pad=x", "operationId": "web-fit-roads-long"}, 201)
	if saved["content"] != text {
		t.Fatal("the page was not saved whole")
	}
	// An eighth of a task: about 7.9 KB, less than the saved document's entry, more than this read's own.
	direct := h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/page", "operationId": "web-fit-roads-direct",
		"fit": map[string]any{"revisionIds": []string{}, "share": 8}}, 201)
	content, _ := direct["content"].(string)
	if direct["id"] == saved["id"] || content == "" || content == text || !strings.HasPrefix(text, content) {
		t.Fatal("the direct read must be saved as a text of its own", direct["id"], saved["id"], len(content))
	}
	provenance, _ := direct["provenance"].(map[string]any)
	if provenance["truncated"] != true {
		t.Fatal("the shorter text must say it was cut", provenance)
	}
	// And it fits its share as a task quotes it.
	item, err := readKnowledgeContextItem(context.Background(), h.db, tid, direct["currentRevisionId"].(string))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal([]knowledgeContextItem{item})
	if budget := (maxKnowledgeContextBytes-len("[]"))/8 - 1 - webFitMargin; len(raw)-len("[]") > budget {
		t.Fatal("the text of its own must fit its share as a task quotes it", len(raw)-len("[]"), budget)
	}
}

func TestPostgresAFittedPageGivesWayToASavedDocumentLongerThanATaskCarries(t *testing.T) {
	// Saved whole (从网址读取), the page runs past the 64 KiB one task quotes.
	var long strings.Builder
	for i := 0; long.Len() < 70<<10; i++ {
		fmt.Fprintf(&long, "Paragraph %d of a page saved whole, longer than any task carries.\n", i)
	}
	text := strings.TrimSpace(long.String())
	redirectingSite(t, text)
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.WebReaderEnabled, h.a.cfg.WebReadsPerDay, h.a.cfg.WebReadsSitePerDay = true, 5, 100
	owner, tid, _ := h.register(t, "web-fit-oversized@example.test")
	saved := h.request(t, owner, "POST", "/tenants/"+tid+"/knowledge/sources/web", map[string]any{"url": "http://site.test/hop1?pad=x", "operationId": "web-fit-oversized"}, 201)
	if saved["content"] != text {
		t.Fatal("the page was not saved whole")
	}
	ctx := context.Background()
	tx, err := h.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := freezeKnowledgeContext(ctx, tx, tid, []string{saved["currentRevisionId"].(string)}); err == nil {
		t.Fatal("the saved document must run past what one task quotes")
	}
	// Measured whatever its size: it gives way to a shorter text, never refusing the read with the limit's code.
	budget := 60 << 10
	kept, err := fitExistingSource(ctx, tx, tid, text, budget, budget-512)
	if err != nil || kept == "" || kept == text || !strings.HasPrefix(text, kept) || quotedLen(kept) > budget-512 {
		t.Fatal("a saved document longer than a task carries must give way to a shorter text", err, len(kept))
	}
}

// A page just over the least text a cut may leave, saved before behind long redirects, is still saved as a text of its
// own when read directly into a small share: shorter by what it can spare.
func TestPostgresAPageJustOverTheLeastTextFindsATextOfItsOwn(t *testing.T) {
	text := strings.TrimSpace(strings.Repeat("A short page two reads reach by different roads.\n", 22))
	if len(text) < webFitLeastText || len(text)-webFitLeastText >= 64 {
		t.Fatal("the page must be just over the least text", len(text))
	}
	redirectingSite(t, text)
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.WebReaderEnabled, h.a.cfg.WebReadsPerDay, h.a.cfg.WebReadsSitePerDay = true, 5, 100
	owner, tid, _ := h.register(t, "web-fit-least@example.test")
	path := "/tenants/" + tid + "/knowledge/sources/web"
	h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/hop1?pad=x", "operationId": "web-fit-least-long"}, 201)
	direct := h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/page", "operationId": "web-fit-least-direct",
		"fit": map[string]any{"revisionIds": []string{}, "share": 8}}, 201)
	if content, _ := direct["content"].(string); len(content) < webFitLeastText || content == text || !strings.HasPrefix(text, content) {
		t.Fatal("the direct read must keep a text of its own of at least the least text", len(content))
	}
}

// However many shorter copies of a page were saved before, a read goes on to the first text of its own.
func TestPostgresAFittedPageFindsATextOfItsOwnPastManySavedOnes(t *testing.T) {
	text := strings.TrimSpace(strings.Repeat("Many saved copies of one page, each a little shorter than the last.\n", 80))
	room := quotedLen(text) + 200
	budget := room + 600
	// The texts this read tries in turn; the first four were saved before, behind long redirects.
	texts := []string{text}
	for len(texts) < 5 {
		texts = append(texts, shorterWebText(texts[len(texts)-1], room))
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) })
	pad := strings.Repeat("q", 1900)
	for i, saved := range texts[:4] {
		for hop := 1; hop <= 5; hop++ {
			next := fmt.Sprintf("/c%dh%d?pad=%s", i, hop+1, pad)
			if hop == 5 {
				next = fmt.Sprintf("/c%d", i)
			}
			mux.HandleFunc(fmt.Sprintf("/c%dh%d", i, hop), func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, next, http.StatusFound) })
		}
		mux.HandleFunc(fmt.Sprintf("/c%d", i), func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			fmt.Fprint(w, saved)
		})
	}
	serveWebSite(t, mux)
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.WebReaderEnabled, h.a.cfg.WebReadsPerDay, h.a.cfg.WebReadsSitePerDay = true, 10, 100
	owner, tid, _ := h.register(t, "web-fit-many@example.test")
	for i := range texts[:4] {
		saved := h.request(t, owner, "POST", "/tenants/"+tid+"/knowledge/sources/web", map[string]any{"url": fmt.Sprintf("http://site.test/c%dh1?pad=x", i),
			"operationId": fmt.Sprintf("web-fit-many-%d", i)}, 201)
		if saved["content"] != texts[i] {
			t.Fatal("a saved copy is not the text expected", i)
		}
	}
	ctx := context.Background()
	tx, err := h.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	kept, err := fitExistingSource(ctx, tx, tid, text, budget, room)
	if err != nil || kept != texts[4] {
		t.Fatal("the read must find the text of its own past every saved copy", err, len(kept), len(texts[4]))
	}
}

// Saved copies a character apart do not hide the text of its own between them: with copies of 1,088 and 1,024
// characters saved, a read of the first goes on to 1,087.
func TestPostgresSavedCopiesDoNotHideATextOfItsOwn(t *testing.T) {
	long, least := strings.Repeat("a", 1088), strings.Repeat("a", webFitLeastText)
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) })
	pad := strings.Repeat("q", 1900)
	for i, saved := range []string{long, least} {
		for hop := 1; hop <= 5; hop++ {
			next := fmt.Sprintf("/s%dh%d?pad=%s", i, hop+1, pad)
			if hop == 5 {
				next = fmt.Sprintf("/s%d", i)
			}
			mux.HandleFunc(fmt.Sprintf("/s%dh%d", i, hop), func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, next, http.StatusFound) })
		}
		mux.HandleFunc(fmt.Sprintf("/s%d", i), func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			fmt.Fprint(w, saved)
		})
	}
	serveWebSite(t, mux)
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.WebReaderEnabled, h.a.cfg.WebReadsPerDay, h.a.cfg.WebReadsSitePerDay = true, 10, 100
	owner, tid, _ := h.register(t, "web-fit-apart@example.test")
	for i := range 2 {
		h.request(t, owner, "POST", "/tenants/"+tid+"/knowledge/sources/web", map[string]any{"url": fmt.Sprintf("http://site.test/s%dh1?pad=x", i),
			"operationId": fmt.Sprintf("web-fit-apart-%d", i)}, 201)
	}
	ctx := context.Background()
	tx, err := h.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	kept, err := fitExistingSource(ctx, tx, tid, long, quotedLen(long)+800, quotedLen(long)+200)
	if err != nil || len(kept) != 1087 {
		t.Fatal("the text of its own between the saved copies must be found", err, len(kept))
	}
}

// A fit naming another workspace's revision answers as one that does not exist, before anything is read or counted.
func TestPostgresAFitNamingAnotherWorkspacesKnowledgeAnswersNotFound(t *testing.T) {
	redirectingSite(t, strings.Repeat("A page two workspaces read. ", 40))
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.WebReaderEnabled, h.a.cfg.WebReadsPerDay, h.a.cfg.WebReadsSitePerDay = true, 5, 100
	owner, tid, _ := h.register(t, "web-fit-tenant-a@example.test")
	other, otherTid, _ := h.register(t, "web-fit-tenant-b@example.test")
	theirs := h.request(t, other, "POST", "/tenants/"+otherTid+"/knowledge/sources/web", map[string]any{"url": "http://site.test/hop1?pad=x", "operationId": "web-fit-theirs"}, 201)
	path := "/tenants/" + tid + "/knowledge/sources/web"
	for operation, ids := range map[string][]string{"web-fit-foreign": {theirs["currentRevisionId"].(string)}, "web-fit-missing": {"no-such-revision"}} {
		refused := h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/hop1?pad=x", "operationId": operation,
			"fit": map[string]any{"revisionIds": ids, "share": 1}}, 404)
		if refused["error"].(map[string]any)["code"] != "not_found" {
			t.Fatal(operation, refused)
		}
	}
	var reads int
	if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM web_reads WHERE tenant_id=$1", tid).Scan(&reads); err != nil || reads != 0 {
		t.Fatal("a refused fit must read and count nothing", reads, err)
	}
}

func TestPostgresWebImportFitsAPageToItsTask(t *testing.T) {
	var long strings.Builder
	for i := 0; long.Len() < 180<<10; i++ {
		fmt.Fprintf(&long, "第 %d 段 <notes> & \"quotes\": the reader keeps this paragraph for the task that cites it.\n", i)
	}
	page := strings.TrimSpace(long.String())
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) })
	plain := func(text string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			fmt.Fprint(w, text)
		}
	}
	mux.HandleFunc("/long", plain(page))
	mux.HandleFunc("/second", plain("SECOND "+page))
	mux.HandleFunc("/third", plain("THIRD "+page))
	mux.HandleFunc("/short", plain("A short page that fits whole in any task."))
	serveWebSite(t, mux)
	h := newHarness(t, "http://127.0.0.1:1")
	h.a.cfg.WebReaderEnabled, h.a.cfg.WebReadsPerDay, h.a.cfg.WebReadsSitePerDay = true, 20, 100
	owner, tid, _ := h.register(t, "web-fit@example.test")
	path := "/tenants/" + tid + "/knowledge/sources/web"
	reads := func() int {
		var n int
		if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM web_reads WHERE tenant_id=$1", tid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	revision := func(doc map[string]any) string { return doc["currentRevisionId"].(string) }
	cite := func(ids ...string) map[string]any {
		return h.request(t, owner, "GET", "/tenants/"+tid+"/knowledge/context?revisionIds="+strings.Join(ids, ","), nil, 200)
	}

	// A page longer than a task carries arrives cut to the room and marked, and the task can cite it.
	first := h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/long", "operationId": "web-fit-one", "fit": map[string]any{"revisionIds": []string{}, "share": 1}}, 201)
	content := first["content"].(string)
	provenance := first["provenance"].(map[string]any)
	fitted, _ := provenance["fitted"].(map[string]any)
	if provenance["truncated"] != true || fitted["textBytes"] != float64(len(page)) || fitted["keptBytes"] != float64(len(content)) || !strings.HasPrefix(page, content) || len(content) < 40<<10 {
		t.Fatal("the long page was not fitted to its task", len(content), provenance)
	}
	if quoted := cite(revision(first)); len(quoted["items"].([]any)) != 1 {
		t.Fatal("the fitted page cannot be cited", quoted)
	}

	// With the room taken, another page is refused before it is read, and nothing is counted.
	before := reads()
	full := h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/second", "operationId": "web-fit-full", "fit": map[string]any{"revisionIds": []string{revision(first)}, "share": 1}}, 413)
	if full["error"].(map[string]any)["code"] != "knowledge_context_limit" || reads() != before {
		t.Fatal("a page with no room was read or counted", full, reads(), before)
	}

	// Two pages of one message share the room and are cited together.
	half := h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/second", "operationId": "web-fit-half", "fit": map[string]any{"revisionIds": []string{}, "share": 2}}, 201)
	rest := h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/third", "operationId": "web-fit-rest", "fit": map[string]any{"revisionIds": []string{revision(half)}, "share": 1}}, 201)
	if quoted := cite(revision(half), revision(rest)); len(quoted["items"].([]any)) != 2 {
		t.Fatal("the message's two pages cannot be cited together", quoted)
	}
	if len(half["content"].(string)) >= len(content) || len(rest["content"].(string)) >= len(content) {
		t.Fatal("pages sharing the room took a whole room each")
	}

	// A short page is kept whole and unmarked; a repeated operation answers from the first and must not change its fit.
	short := h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/short", "operationId": "web-fit-short", "fit": map[string]any{"revisionIds": []string{revision(half)}, "share": 1}}, 201)
	if short["content"] != "A short page that fits whole in any task." || short["provenance"].(map[string]any)["fitted"] != nil {
		t.Fatal("a page that fits was cut or marked", short)
	}
	if again := h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/second", "operationId": "web-fit-half", "fit": map[string]any{"revisionIds": []string{}, "share": 2}}, 201); again["id"] != half["id"] {
		t.Fatal("a repeated operation was not answered from the first")
	}
	conflict := h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/second", "operationId": "web-fit-half", "fit": map[string]any{"revisionIds": []string{}, "share": 3}}, 409)
	if conflict["error"].(map[string]any)["code"] != "idempotency_conflict" {
		t.Fatal(conflict)
	}

	// A fit outside its bounds is refused as input.
	h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/short", "operationId": "web-fit-zero", "fit": map[string]any{"revisionIds": []string{}, "share": 0}}, 400)
	eight := []string{"r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"}
	h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/short", "operationId": "web-fit-eight", "fit": map[string]any{"revisionIds": eight, "share": 1}}, 400)
	h.request(t, owner, "POST", path, map[string]any{"url": "http://site.test/short", "operationId": "web-fit-missing", "fit": map[string]any{"revisionIds": []string{"no-such-revision"}, "share": 1}}, 404)
}
