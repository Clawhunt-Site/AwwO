package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// The service knows a page's automatic repair by the first line of its message, and only there.
func TestPageRepairKindReadsTheMessageFirstLine(t *testing.T) {
	for prompt, want := range map[string]string{
		"AwwO page repair · field \"figure\"\nAwwO ran the page you delivered":           "page",
		"AwwO page repair · field \"figure\" · still\nAwwO ran the figure you delivered": "still",
		"AwwO page repair · field \"figure\"":                                            "", // no line of its own
		"Please look: AwwO page repair · field \"figure\"\n":                             "", // a person quoting it
		" AwwO page repair · field \"figure\"\n":                                         "",
		"AwwO page repair · field \"\"\n":                                                "",
		"AwwO page repair · field \"a\nb\"\n":                                            "",
		"AwwO page repair · field \"figure\" · stil\n":                                   "",
		"AwwO page repair · field \"page\"2\"\nAwwO ran the page":                        "page", // an id may hold a quote
		"AwwO page repair · field \"page\"2\" · still\nAwwO ran the figure":              "still",
		"AwwO page repair · field \"x\" · still\" · still\nAwwO ran the figure":          "still",
		"AwwO page repair · field \"x\" · still\"\nAwwO ran the page":                    "page",
		"this page fails, fix it":                                                        "",
		"":                                                                               "",
	} {
		if got := pageRepairKind(prompt); got != want {
			t.Errorf("%q is %q, want %q", prompt, got, want)
		}
	}
	if !strings.HasPrefix("AwwO page repair · field \"figure\"\n", pageRepairPrefix) {
		t.Error("the stored-prompt prefix is not how the first line begins")
	}
}

// The page writes that first line (apps/web/src/canvas/pageRepair.ts); were it to change, the service would no longer
// know a repair and would let every browser repair a repair again. So the two are pinned together.
func TestPageRepairHeaderIsThePagesFirstLine(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "web", "src", "canvas", "pageRepair.ts"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	for _, want := range []string{
		"const PAGE_REPAIR_HEADER = /^AwwO page repair · field \"([^\\n]+)\"( · still)?\\n/;",
		"`AwwO page repair · field \"${field.id}\" · still`,",
		"`AwwO page repair · field \"${field.id}\"`,",
		"].join('\\n');",
	} {
		if !strings.Contains(source, want) {
			t.Errorf("pageRepair.ts no longer has %s", want)
		}
	}
}

// A page that keeps failing went back to its node from every browser that showed it (a second device, a collaborator's,
// a repair's result that came after the page's 30 minutes), each a paid run: the service runs no repair of a repair
// until another run of the node.
func TestPostgresPageRepairIsNotRepairedByItself(t *testing.T) {
	var calls atomic.Int32
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			writeJSON(w, 200, map[string]any{"ready": true, "model": "test-model", "provider": "test"})
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(202)
			return
		}
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fmt.Fprint(w, "data: {\"type\":\"text_delta\",\"delta\":\"ok\"}\n\ndata: {\"type\":\"completed\",\"text\":\"ok\"}\n\n")
	}))
	defer pi.Close()
	h := newHarness(t, pi.URL)
	c, tid, _ := h.register(t, "page-repair@example.test")
	_, _, sid := h.fixture(t, c, tid)
	_, _, other := h.fixture(t, c, tid)
	prefix := "/tenants/" + tid
	page := "AwwO page repair · field \"page\"\nAwwO ran the page you delivered in \"Page\", and it failed with this error"
	still := "AwwO page repair · field \"page\" · still\nAwwO ran the figure you delivered in \"Page\", and it never moves"
	stored := func(session string) (n int) {
		t.Helper()
		if err := h.db.QueryRow(context.Background(), "SELECT count(*) FROM runs WHERE tenant_id=$1 AND session_id=$2", tid, session).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	operations := 0
	send := func(session, prompt string, status int) map[string]any {
		t.Helper()
		operations++
		body := map[string]string{"sessionId": session, "prompt": prompt, "operationId": fmt.Sprintf("page-repair-%02d", operations)}
		v := h.request(t, c, "POST", prefix+"/runs", body, status)
		if status == 202 {
			h.awaitRun(t, c, tid, v["id"].(string), "completed")
		}
		return v
	}
	ran := func(session, prompt string) { t.Helper(); send(session, prompt, 202) }
	refused := func(session, prompt string) {
		t.Helper()
		before, runs := calls.Load(), stored(session)
		v := send(session, prompt, 409)
		if code := v["error"].(map[string]any)["code"]; code != "page_repair_chained" {
			t.Fatalf("refused as %v", code)
		}
		if calls.Load() != before || stored(session) != runs {
			t.Fatal("a refused repair ran or was stored")
		}
	}

	ran(sid, "Build the sign-in page")
	repair := send(sid, page, 202) // the page failed: it goes back to its node once
	accepted := map[string]string{"sessionId": sid, "prompt": page, "operationId": fmt.Sprintf("page-repair-%02d", operations)}
	refused(sid, page) // another browser asks for the same delivery, or for the repair's own result
	// A retry of the accepted repair (its answer was lost) still finds it: the operation's own run is no second repair.
	if v := h.request(t, c, "POST", prefix+"/runs", accepted, 200); v["id"] != repair["id"] {
		t.Fatalf("the retry found another run: %v", v)
	}
	ran(other, page)   // another node's session has its own once
	ran(sid, still)    // a figure that never moves has its own once, after the error's repair
	refused(sid, page) // two repairs in a row: nothing more by itself
	refused(sid, still)
	ran(sid, "The button still does nothing") // a person asks the node again
	ran(sid, page)                            // and its new delivery may go back once
	refused(sid, page)

	// A field's id has no length limit of its own: the stored repair is still known by its whole first line.
	_, _, long := h.fixture(t, c, tid)
	longPage := "AwwO page repair · field \"" + strings.Repeat("f", 1500) + "\"\nAwwO ran the page you delivered"
	ran(long, longPage)
	refused(long, longPage)
	// Nor a quote: a plan's field ids may hold one, and the page writes the id as it is.
	_, _, quoted := h.fixture(t, c, tid)
	quotedPage := "AwwO page repair · field \"page\"2\"\nAwwO ran the page you delivered"
	ran(quoted, quotedPage)
	refused(quoted, quotedPage)

	// A run's created_at is the time its admission's transaction began: a repair whose transaction began before two of a
	// person's runs were admitted, and that ran after both, is still the session's latest run.
	_, _, order := h.fixture(t, c, tid)
	for _, row := range []struct{ prompt, created, updated string }{
		{"Make the button blue", "90 seconds", "80 seconds"},
		{"And the title larger", "70 seconds", "60 seconds"},
		{page, "2 minutes", "10 seconds"},
	} {
		if _, err := h.db.Exec(context.Background(), "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,created_at,updated_at) VALUES($1,$2,$3,$1,'h',$4,'completed',now()-$5::interval,now()-$6::interval)",
			randomID(), tid, order, row.prompt, row.created, row.updated); err != nil {
			t.Fatal(err)
		}
	}
	refused(order, page)

	if calls.Load() != 8 {
		t.Fatalf("%d model calls, want the 8 runs admitted", calls.Load())
	}
}
