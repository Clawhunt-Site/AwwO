package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"awwo/backend/internal/webread"

	"github.com/jackc/pgx/v5"
)

// Importing a public web page into the knowledge base. A member names one address; the API (never a model or a
// worker) fetches it through internal/webread: public addresses only, checked as each connection is made, robots.txt
// obeyed, an honest user agent, no cookies, a challenge page refused rather than worked around. The readable text
// becomes a knowledge source with its provenance, and reaches a model only when someone selects it for a run, quoted
// as untrusted evidence. Off unless AWWO_WEB_READER=on; each workspace has a daily allowance.

const webReaderUserAgent = "AwwO-Reader/1.0 (+https://awwo.clawhunt.store)"
const webReadsToday = "w.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
const webSourceAction = "knowledge.source.web"

// webReadSlotWait is how long a read waits for one of the reading slots before the server says it is busy; with
// the reader's own 20 s deadline it stays inside the web client's 45 s.
const webReadSlotWait = 15 * time.Second

var (
	webRobotsOnce sync.Once
	webRobots     *webread.RobotsCache
	// At most four pages are being read at once across the whole API.
	webReadSlots = make(chan struct{}, 4)
	// webReadTestOptions lets tests point the reader at loopback servers; nil in production.
	webReadTestOptions func(*webread.Options)
)

func sharedWebRobots() *webread.RobotsCache {
	webRobotsOnce.Do(func() { webRobots = webread.NewRobotsCache(24*time.Hour, 2048) })
	return webRobots
}

// interruptWebReads settles, at startup, the reads a previous process left started: they stay counted, and their
// operation may be tried again.
func interruptWebReads(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, "UPDATE web_reads SET status='failed',error_code='interrupted',finished_at=clock_timestamp() WHERE status='started'")
	return err
}

type webSourceInput struct {
	URL         string        `json:"url"`
	Title       string        `json:"title"`
	OperationID string        `json:"operationId"`
	Fit         *webSourceFit `json:"fit,omitempty"`
}

// webSourceFit is set for a page read from a conversation: the page is cited by the task its message starts, beside
// the knowledge that task already cites (RevisionIDs), and a task quotes at most maxKnowledgeContextBytes of knowledge.
// The page's text is cut to its Share of the room those revisions leave, measured as freezeKnowledgeContext will quote
// it, so a long page arrives shortened (its provenance says so) rather than making the task refuse all of it. Share
// counts this page and the pages the message still has to read; together they may take the whole room.
type webSourceFit struct {
	RevisionIDs []string `json:"revisionIds"`
	Share       int      `json:"share"`
}

// A fitted page needs at least this much of its task's room, and at least webFitLeastText of its text must remain
// once it is cut, or the read is refused as having no room (before the read, where the room alone shows it).
const webFitLeastRoom = 4 << 10
const webFitLeastText = 1 << 10

// webFitMargin is left of each page's share: a page whose text was saved before comes back as that document, whose
// title and provenance (the time it was fetched, whether robots.txt came from the cache) may run a few bytes longer.
const webFitMargin = 256

// webFitTries bounds how many saved documents with the same text one fitted read looks past for a text of its own
// (fitExistingSource): a workspace holding more copies of one page, each a character apart, gets web_page_no_room.
const webFitTries = 64

// webSourceURILimit is the longest address a source keeps (validKnowledgeText): a longer one is refused before it is
// read, so the refusal counts nothing.
const webSourceURILimit = 2000

func (f *webSourceFit) check() error {
	if f == nil {
		return nil
	}
	if f.Share < 1 || len(f.RevisionIDs)+f.Share > maxKnowledgeRunReferences {
		return knowledgeInvalid("fit.share must be at least 1, and a task cites at most 8 knowledge revisions with the pages")
	}
	return nil
}

func webFitNoRoom() error {
	return knowledgeError{413, "knowledge_context_limit", "The knowledge this task already cites leaves no room for another page; clear some of it first"}
}

// webPageNoRoom refuses a page once it has been read (the read counts): its own title, addresses and details leave
// too little of its share for its text. Its own code, so a caller that makes room after knowledge_context_limit and
// asks again does not read it again for nothing.
func webPageNoRoom() error {
	return knowledgeError{413, "web_page_no_room", "This page's own details leave no room for its text in the task; clear some cited knowledge first"}
}

// webFitBudget is how many bytes of the task's quoted knowledge the page may take: its share of what the cited
// revisions leave, less the comma that joins it to them and webFitMargin.
func webFitBudget(ctx context.Context, q querier, tid string, fit *webSourceFit) (int, error) {
	used := len("[]")
	cited, err := freezeKnowledgeContext(ctx, q, tid, fit.RevisionIDs)
	if err != nil {
		return 0, err
	}
	if cited != nil {
		raw, err := json.Marshal(cited.Items)
		if err != nil {
			return 0, err
		}
		used = len(raw)
	}
	return (maxKnowledgeContextBytes-used)/fit.Share - 1 - webFitMargin, nil
}

// quotedWebItemBytes is the size of the page's entry in its task's quoted knowledge (a knowledgeContextItem as
// freezeKnowledgeContext marshals it) with its text empty; the identities take the lengths randomID and tokenHash give.
func quotedWebItemBytes(title, uri string, provenance map[string]any) (int, error) {
	pr, err := json.Marshal(provenance)
	if err != nil {
		return 0, err
	}
	id := strings.Repeat("a", len(randomID()))
	raw, err := json.Marshal(knowledgeContextItem{knowledgeReference: knowledgeReference{DocumentID: id, RevisionID: id, Title: title, Kind: "source",
		ContentHash: tokenHash("")}, SourceURI: uri, Provenance: pr})
	if err != nil {
		return 0, err
	}
	return len(raw), nil
}

// What json.Marshal spends inside a string's quotes on each ASCII byte (escapes for quotes, backslashes, control
// characters and, as it escapes HTML, <, > and &), on an invalid byte and on U+2028 and U+2029, measured once from
// encoding/json itself. Every other character costs its own UTF-8 bytes.
var quotedASCII, quotedInvalid, quotedLineSeparator, quotedParagraphSeparator = measureQuoted()

func measureQuoted() (ascii [utf8.RuneSelf]int, invalid, line, paragraph int) {
	for b := range ascii {
		ascii[b] = quotedLen(string([]byte{byte(b)}))
	}
	return ascii, quotedLen("\xff"), quotedLen("\u2028"), quotedLen("\u2029")
}

// quotedBytes is what one character of a string costs inside its JSON quotes, as json.Marshal writes it.
func quotedBytes(r rune, size int) int {
	switch {
	case r == utf8.RuneError && size == 1:
		return quotedInvalid
	case r < utf8.RuneSelf:
		return quotedASCII[r]
	case r == '\u2028':
		return quotedLineSeparator
	case r == '\u2029':
		return quotedParagraphSeparator
	}
	return size
}

// quotedLen is the bytes json.Marshal spends on s inside its quotes.
func quotedLen(s string) int {
	raw, _ := json.Marshal(s)
	return len(raw) - 2
}

// fitWebText cuts text so that it costs at most room bytes quoted, at the last line break when that keeps at least
// three quarters of what fits; "" when less than webFitLeastText would remain.
func fitWebText(text string, room int) string {
	return fitWebTextAt(text, room, true)
}

// fitWebTextAt is fitWebText, at a line end only where `lineEnd`, one is near and it leaves webFitLeastText of text;
// otherwise where the room ends.
func fitWebTextAt(text string, room int, lineEnd bool) string {
	if quotedLen(text) <= room {
		return text
	}
	cut, spent := 0, 0
	for cut < len(text) {
		r, size := utf8.DecodeRuneInString(text[cut:])
		cost := quotedBytes(r, size)
		if spent+cost > room {
			break
		}
		spent += cost
		cut += size
	}
	keep := func(at int) string {
		kept := strings.TrimRight(text[:at], " \t\r\n")
		// The count above follows encoding/json; should the two ever disagree, the measured size decides.
		for kept != "" && quotedLen(kept) > room {
			_, size := utf8.DecodeLastRuneInString(kept)
			kept = kept[:len(kept)-size]
		}
		return kept
	}
	if line := strings.LastIndexByte(text[:cut], '\n'); lineEnd && line >= cut*3/4 {
		if kept := keep(line); len(kept) >= webFitLeastText {
			return kept
		}
	}
	if kept := keep(cut); len(kept) >= webFitLeastText {
		return kept
	}
	return ""
}

// fitExistingSource settles, in the save's transaction, the text a fitted page is saved with. A document with the same
// text may exist already (saved before, under its own title and provenance, which can run longer than this read's):
// it is reused only while its entry, quoted as a task quotes it, fits the budget too. Otherwise this read is saved as a
// text of its own, a little shorter (shorterWebText) and within `room`, what this read's own entry leaves its text once a
// cut marks its provenance, and looked up again. The saved entry is measured whatever its size, so one longer than a
// whole task carries gives way too, never refusing the read with knowledge_context_limit (which the web answers by
// letting go of a page and asking again), and its own details never shorten this read's text.
func fitExistingSource(ctx context.Context, tx pgx.Tx, tid, text string, budget, room int) (string, error) {
	// Each turn ends, or makes the text strictly shorter (down to webFitLeastText), so no saved text ends the search for
	// one of its own early; and at most webFitTries saved texts are looked past, as each is a lookup in the save's
	// transaction under the workspace's lock.
	for tries := 0; ; tries++ {
		var revision string
		e := tx.QueryRow(ctx, "SELECT current_revision_id FROM knowledge_documents WHERE tenant_id=$1 AND source_hash=$2", tid, tokenHash(text)).Scan(&revision)
		if noRows(e) {
			return text, nil
		}
		if e != nil {
			return "", e
		}
		item, e := readKnowledgeContextItem(ctx, tx, tid, revision)
		if e != nil {
			return "", e
		}
		raw, e := json.Marshal([]knowledgeContextItem{item})
		if e != nil {
			return "", e
		}
		entry := len(raw) - len("[]")
		if entry <= budget {
			return text, nil
		}
		if tries+1 >= webFitTries {
			return "", webPageNoRoom()
		}
		if text = shorterWebText(text, room); text == "" {
			return "", webPageNoRoom()
		}
	}
}

// shorterWebText is a text of the page's own shorter than `text` by as little as it can be (a character, or down to
// `room`), cut where that falls, so no shorter text of its own is passed over: "" once less than webFitLeastText would
// be left.
func shorterWebText(text string, room int) string {
	return fitWebTextAt(text, min(room, quotedLen(text)-1), false)
}

// fitWebSource gives the text to save for a page read with fit, and marks the provenance when it was cut; ok is false
// when the page's entry leaves too little room for its text.
func fitWebSource(title, uri, text string, provenance map[string]any, budget int) (string, bool, error) {
	whole, err := quotedWebItemBytes(title, uri, provenance)
	if err != nil {
		return "", false, err
	}
	if whole+quotedLen(text) <= budget {
		return text, true, nil
	}
	// Measured with the marks a cut adds, at their largest (the kept length has at most the digits of the whole).
	provenance["truncated"] = true
	provenance["fitted"] = map[string]any{"textBytes": len(text), "keptBytes": len(text)}
	marked, err := quotedWebItemBytes(title, uri, provenance)
	if err != nil {
		return "", false, err
	}
	kept := fitWebText(text, budget-marked)
	if kept == "" {
		return "", false, nil
	}
	provenance["fitted"] = map[string]any{"textBytes": len(text), "keptBytes": len(kept)}
	return kept, true, nil
}

var webReadStatuses = map[string]int{
	"invalid_url": 400, "blocked_scheme": 400, "blocked_host": 400, "blocked_port": 400, "blocked_address": 400,
	"robots_disallowed": 403, "robots_unavailable": 502, "http_status": 502, "too_large": 413, "unsupported_type": 415,
	"too_many_redirects": 502, "timeout": 504, "network_error": 502, "blocked_by_site_protection": 422,
	"decode_failed": 422, "empty_content": 422,
}

func webReadCode(err error) string {
	var input *webread.Error
	if errors.As(err, &input) {
		return input.Code
	}
	return "network_error"
}

func webReadFailure(w http.ResponseWriter, err error) {
	var input *webread.Error
	if errors.As(err, &input) {
		status := webReadStatuses[input.Code]
		if status == 0 {
			status = 502
		}
		fail(w, status, "web_"+input.Code, input.Message)
		return
	}
	fail(w, 502, "web_network_error", "The page could not be read")
}

// replayKnowledgeOperation answers a repeated operationId from its stored response, as knowledgeMutation would,
// before anything is fetched again.
func (a *App) replayKnowledgeOperation(w http.ResponseWriter, r *http.Request, tid, op string, input any) bool {
	hash := tokenHash(webSourceAction + "\x00" + r.PathValue("id") + "\x00" + string(jsonBytes(input)))
	var previousHash string
	var previous json.RawMessage
	var previousStatus int
	err := a.db.QueryRow(r.Context(), "SELECT request_hash,response,status FROM knowledge_operations WHERE tenant_id=$1 AND operation_id=$2", tid, op).Scan(&previousHash, &previous, &previousStatus)
	if noRows(err) {
		return false
	}
	if err != nil {
		a.dbError(w, err)
		return true
	}
	if previousHash != hash {
		fail(w, 409, "idempotency_conflict", "operationId was used for a different knowledge change")
		return true
	}
	writeJSON(w, previousStatus, previous)
	return true
}

// reserveWebRead counts the read against today's allowances before anything is fetched. The workspace row lock
// serializes its own reads (and so the check for the same operation still reading); the site-wide count takes its
// own lock, so concurrent reads from different workspaces cannot pass the site's limit together.
func (a *App) reserveWebRead(w http.ResponseWriter, r *http.Request, tid string, target *url.URL, operationID string) (id string, replay, ok bool) {
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		a.dbError(w, err)
		return "", false, false
	}
	defer tx.Rollback(r.Context())
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return "", false, false
	}
	// Under the workspace lock: an operation another request finished while this one waited is answered from its
	// stored result, and one still reading is refused, so neither is fetched and counted twice.
	// A read lasts at most the slot wait, the fetch deadline and the save, so a started row older than two minutes is
	// one whose settle was lost and no longer blocks a retry.
	var done, reading bool
	if err = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM knowledge_operations WHERE tenant_id=$1 AND operation_id=$2),EXISTS(SELECT 1 FROM web_reads WHERE tenant_id=$1 AND operation_id=$2 AND status='started' AND created_at>clock_timestamp()-interval '2 minutes')", tid, operationID).Scan(&done, &reading); err != nil {
		a.dbError(w, err)
		return "", false, false
	}
	if done {
		return "", true, false
	}
	if reading {
		fail(w, 409, "web_read_in_progress", "This page is still being read; try again in a moment")
		return "", false, false
	}
	// A workspace the free plan's end closes reads nothing new (free_plan.go: no free allowance of any kind after it).
	// Asked after the replay above, so an import it made before the end still answers, and before the read is counted.
	if !a.freePlanAdmitsOwner(w, r, tx, tid) {
		return "", false, false
	}
	if _, err = tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(84321012)"); err != nil {
		a.dbError(w, err)
		return "", false, false
	}
	var today, site int
	if err = tx.QueryRow(r.Context(), "SELECT (SELECT count(*) FROM web_reads w WHERE w.tenant_id=$1 AND "+webReadsToday+"),(SELECT count(*) FROM web_reads w WHERE "+webReadsToday+")", tid).Scan(&today, &site); err != nil {
		a.dbError(w, err)
		return "", false, false
	}
	if today >= a.cfg.WebReadsPerDay {
		fail(w, 429, "web_read_quota", "This workspace has used today's web imports")
		return "", false, false
	}
	if site >= a.cfg.WebReadsSitePerDay {
		fail(w, 429, "web_read_quota", "Web imports have reached today's limit; try again tomorrow")
		return "", false, false
	}
	id = randomID()
	if _, err = tx.Exec(r.Context(), "INSERT INTO web_reads(id,tenant_id,actor_id,operation_id,url_hash,host,status) VALUES($1,$2,$3,$4,$5,$6,'started')", id, tid, currentUser(r).ID, operationID, tokenHash(target.String()), target.Hostname()); err != nil {
		a.dbError(w, err)
		return "", false, false
	}
	if err = tx.Commit(r.Context()); err != nil {
		a.dbError(w, err)
		return "", false, false
	}
	return id, false, true
}

// settleWebRead ends a read still started; it tries again after a database error, since a read left started holds
// its operation until the next start (or two minutes).
func (a *App) settleWebRead(tid, id, status, code string, bytes int64, documentID string) {
	var errorCode, document any
	if code != "" {
		errorCode = code
	}
	if documentID != "" {
		document = documentID
	}
	for attempt := 1; ; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, err := a.db.Exec(ctx, "UPDATE web_reads SET status=$3,error_code=$4,bytes=$5,document_id=$6,finished_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='started'", tid, id, status, errorCode, bytes, document)
		cancel()
		if err == nil {
			return
		}
		a.log.Error("web read settle failed", "error_type", fmt.Sprintf("%T", err), "attempt", attempt)
		if attempt == 3 {
			return
		}
		time.Sleep(time.Duration(attempt) * 300 * time.Millisecond)
	}
}

func webSourceTitle(requested string, result *webread.Result, target *url.URL) string {
	for _, candidate := range []string{requested, result.Title, target.Hostname()} {
		candidate = strings.Join(strings.Fields(candidate), " ")
		if candidate == "" {
			continue
		}
		for len(candidate) > 200 {
			_, size := utf8.DecodeLastRuneInString(candidate)
			candidate = candidate[:len(candidate)-size]
		}
		return candidate
	}
	return "Web page"
}

// clipBytes keeps at most max bytes of s, cut on a character boundary.
func clipBytes(s string, max int) string {
	for len(s) > max {
		_, size := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-size]
	}
	return s
}

// webSourceProvenance records the read. What the page itself supplies (its byline, date and language) and the
// addresses are bounded, so a page cannot fill the room its own entry takes in a task's quoted knowledge.
func webSourceProvenance(result *webread.Result) map[string]any {
	redirects := make([]string, len(result.Redirects))
	for i, hop := range result.Redirects {
		redirects[i] = clipBytes(hop, 2048)
	}
	return map[string]any{"origin": "web", "requestedUrl": clipBytes(result.RequestedURL, 2048), "finalUrl": result.FinalURL, "redirects": redirects,
		"fetchedAt": result.FetchedAt.UTC().Format(time.RFC3339), "status": result.Status, "contentType": result.ContentType, "charset": result.Charset,
		"rawSha256": result.RawSHA256, "rawBytes": result.RawBytes, "kind": result.Kind, "extractor": result.Extractor, "truncated": result.Truncated,
		"unconfirmed": result.Unconfirmed, "byline": clipBytes(result.Byline, 200), "published": clipBytes(result.Published, 64), "lang": clipBytes(result.Lang, 35),
		"feedItems": len(result.Items), "robots": map[string]any{"checked": result.Robots.Checked, "allowed": result.Robots.Allowed, "status": result.Robots.Status, "cached": result.Robots.Cached}}
}

func (a *App) importWebSource(w http.ResponseWriter, r *http.Request) {
	if !a.cfg.WebReaderEnabled {
		fail(w, 503, "web_reader_unavailable", "Importing from a web address is not enabled on this server")
		return
	}
	var b webSourceInput
	if !a.decode(w, r, &b) {
		return
	}
	b.URL, b.Title = strings.TrimSpace(b.URL), strings.TrimSpace(b.Title)
	if len(b.OperationID) < 8 || len(b.OperationID) > 200 {
		a.knowledgeFailure(w, knowledgeInvalid("operationId must contain 8–200 bytes"))
		return
	}
	if len(b.Title) > 200 || strings.ContainsAny(b.Title, "\n\r\x00") {
		a.knowledgeFailure(w, knowledgeInvalid("A title is at most 200 bytes on one line"))
		return
	}
	if err := b.Fit.check(); err != nil {
		a.knowledgeFailure(w, err)
		return
	}
	tid := r.PathValue("tenantId")
	input := webSourceInput{URL: b.URL, Title: b.Title, Fit: b.Fit}
	if a.replayKnowledgeOperation(w, r, tid, b.OperationID, input) {
		return
	}
	target, err := webread.ValidateURL(b.URL)
	if err != nil {
		webReadFailure(w, err)
		return
	}
	// The address as it is read (percent-encoded, so it can run longer than the one written) must be one a source can
	// keep: otherwise the save would fail once the read had counted. (A redirect to a longer one still fails at the save.)
	if len(target.String()) > webSourceURILimit {
		fail(w, 400, "invalid_url", "The address is too long")
		return
	}
	// A page that cannot fit beside what its task cites is refused before it is read, so the refusal counts nothing.
	budget := 0
	if b.Fit != nil {
		if budget, err = webFitBudget(r.Context(), a.db, tid, b.Fit); err != nil {
			a.knowledgeFailure(w, err)
			return
		}
		if budget < webFitLeastRoom {
			a.knowledgeFailure(w, webFitNoRoom())
			return
		}
	}
	// A reading slot first, for a bounded wait: a server busy with other reads answers so, and counts nothing.
	wait := time.NewTimer(webReadSlotWait)
	select {
	case webReadSlots <- struct{}{}:
		wait.Stop()
	case <-wait.C:
		fail(w, 503, "web_reader_busy", "The web reader is busy; try again in a moment")
		return
	case <-r.Context().Done():
		wait.Stop()
		return
	}
	released := false
	release := func() {
		if !released {
			released = true
			<-webReadSlots
		}
	}
	defer release()
	readID, replay, ok := a.reserveWebRead(w, r, tid, target, b.OperationID)
	if replay {
		if !a.replayKnowledgeOperation(w, r, tid, b.OperationID, input) {
			fail(w, 409, "web_read_in_progress", "This page is still being read; try again in a moment")
		}
		return
	}
	if !ok {
		return
	}
	// Whatever happens below, the read ends settled: a read saved with its document is already ok, and the update
	// only touches a read still marked started.
	defer a.settleWebRead(tid, readID, "failed", "not_saved", 0, "")
	opts := webread.Options{UserAgent: webReaderUserAgent, Timeout: 20 * time.Second, MaxBodyBytes: 5 << 20, MaxTextBytes: maxKnowledgeContent - 1024, MaxRedirects: 5, Robots: sharedWebRobots(), Proxy: a.cfg.webReaderProxy()}
	if webReadTestOptions != nil {
		webReadTestOptions(&opts)
	}
	result, err := webread.Fetch(r.Context(), target.String(), opts)
	release()
	if err != nil {
		a.settleWebRead(tid, readID, "failed", webReadCode(err), 0, "")
		webReadFailure(w, err)
		return
	}
	title := webSourceTitle(b.Title, result, target)
	provenance := webSourceProvenance(result)
	text := result.Text
	room := 0
	if b.Fit != nil {
		fitted, ok, err := fitWebSource(title, result.FinalURL, text, provenance, budget)
		if err != nil {
			a.knowledgeFailure(w, err)
			return
		}
		if !ok {
			a.settleWebRead(tid, readID, "failed", "no_room", 0, "")
			a.knowledgeFailure(w, webPageNoRoom())
			return
		}
		text = fitted
		// The room this read's own entry leaves its text once a cut marks its provenance (at its largest): what a text
		// of its own may take where the document saved with the same text runs longer (fitExistingSource).
		marked := maps.Clone(provenance)
		marked["truncated"] = true
		marked["fitted"] = map[string]any{"textBytes": len(result.Text), "keptBytes": len(result.Text)}
		meta, err := quotedWebItemBytes(title, result.FinalURL, marked)
		if err != nil {
			a.knowledgeFailure(w, err)
			return
		}
		room = budget - meta
	}
	a.knowledgeMutation(w, r, b.OperationID, webSourceAction, input, func(tx pgx.Tx) (json.RawMessage, int, error) {
		if b.Fit != nil {
			fitted, e := fitExistingSource(r.Context(), tx, tid, text, budget, room)
			if e != nil {
				return nil, 0, e
			}
			if fitted != text {
				provenance["truncated"] = true
				provenance["fitted"] = map[string]any{"textBytes": len(result.Text), "keptBytes": len(fitted)}
				text = fitted
			}
		}
		if err := validKnowledgeText(title, text, result.FinalURL); err != nil {
			return nil, 0, err
		}
		hash := tokenHash(text)
		var id string
		status := 201
		e := tx.QueryRow(r.Context(), "SELECT id FROM knowledge_documents WHERE tenant_id=$1 AND source_hash=$2", tid, hash).Scan(&id)
		switch {
		case e == nil:
			status = 200
		case !noRows(e):
			return nil, 0, e
		default:
			id = randomID()
			if _, e = tx.Exec(r.Context(), "INSERT INTO knowledge_documents(id,tenant_id,kind,title,source_hash) VALUES($1,$2,'source',$3,$4)", id, tid, title, hash); e != nil {
				return nil, 0, e
			}
			if _, e = publishKnowledgeRevision(r.Context(), tx, tid, id, 1, "", title, text, result.FinalURL, provenance, []knowledgeLinkInput{}, currentUser(r).ID); e != nil {
				return nil, 0, e
			}
		}
		if e = recordKnowledgeOrigin(r.Context(), tx, tid, id, title, result.FinalURL, provenance, currentUser(r).ID); e != nil {
			return nil, 0, e
		}
		if _, e = tx.Exec(r.Context(), "UPDATE web_reads SET status='ok',bytes=$3,document_id=$4,finished_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='started'", tid, readID, result.RawBytes, id); e != nil {
			return nil, 0, e
		}
		value, e := knowledgeDocument(r.Context(), tx, tid, id)
		return value, status, e
	})
}
