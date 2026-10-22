package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	URL         string `json:"url"`
	Title       string `json:"title"`
	OperationID string `json:"operationId"`
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

func webSourceProvenance(result *webread.Result) map[string]any {
	return map[string]any{"origin": "web", "requestedUrl": result.RequestedURL, "finalUrl": result.FinalURL, "redirects": result.Redirects,
		"fetchedAt": result.FetchedAt.UTC().Format(time.RFC3339), "status": result.Status, "contentType": result.ContentType, "charset": result.Charset,
		"rawSha256": result.RawSHA256, "rawBytes": result.RawBytes, "kind": result.Kind, "extractor": result.Extractor, "truncated": result.Truncated,
		"unconfirmed": result.Unconfirmed, "byline": result.Byline, "published": result.Published, "lang": result.Lang, "feedItems": len(result.Items),
		"robots": map[string]any{"checked": result.Robots.Checked, "allowed": result.Robots.Allowed, "status": result.Robots.Status, "cached": result.Robots.Cached}}
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
	tid := r.PathValue("tenantId")
	input := webSourceInput{URL: b.URL, Title: b.Title}
	if a.replayKnowledgeOperation(w, r, tid, b.OperationID, input) {
		return
	}
	target, err := webread.ValidateURL(b.URL)
	if err != nil {
		webReadFailure(w, err)
		return
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
	a.knowledgeMutation(w, r, b.OperationID, webSourceAction, input, func(tx pgx.Tx) (json.RawMessage, int, error) {
		if err := validKnowledgeText(title, result.Text, result.FinalURL); err != nil {
			return nil, 0, err
		}
		hash := tokenHash(result.Text)
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
			if _, e = publishKnowledgeRevision(r.Context(), tx, tid, id, 1, "", title, result.Text, result.FinalURL, provenance, []knowledgeLinkInput{}, currentUser(r).ID); e != nil {
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
