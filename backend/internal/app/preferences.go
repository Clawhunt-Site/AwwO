package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// The account settings the 设置 centre saves on the server, so they follow the account to every browser. Language,
// mode and appearance style stay per browser (preferences.tsx); everything here takes effect somewhere real:
// notifications in the web app when a task the page watched ends, the instructions in every canvas plan this person
// asks for (planCanvas), the default model where the canvas assistant has no choice of the reader's yet.
type userPreferences struct {
	Notifications   preferenceNotifications `json:"notifications"`
	Personalization preferencePersonal      `json:"personalization"`
	// DefaultModel is the canvas assistant's model where the reader has not picked one in that workspace, if offered there.
	DefaultModel *preferenceModel `json:"defaultModel"`
}
type preferenceNotifications struct {
	Browser bool `json:"browser"`
	Sound   bool `json:"sound"`
}
type preferencePersonal struct {
	Enabled      bool   `json:"enabled"`
	AboutMe      string `json:"aboutMe"`
	Instructions string `json:"instructions"`
}
type preferenceModel struct {
	Runtime string `json:"runtime"`
	Model   string `json:"model"`
}

const (
	maxAboutMeRunes      = 1000
	maxInstructionsRunes = 2000
	maxDeletionReason    = 1000
)

// settingText accepts printable text with line breaks and tabs. It refuses controls and every invisible format
// character (direction controls, zero-width spaces, tag characters that can carry text a reader of the record cannot
// see) except the zero-width joiner emoji are built with, and the Unicode line and paragraph separators.
func settingText(value string, limit int) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > limit {
		return false
	}
	for _, r := range value {
		if r == '\n' || r == '\t' || r == '\u200d' {
			continue
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == '\u2028' || r == '\u2029' {
			return false
		}
	}
	return true
}

// accountExports bounds the account export, which streams for as long as a large workspace takes: one at a time per
// account, a few an hour, and a small number across the service, apart from the sign-in slots (authRate).
type accountExports struct {
	mu      sync.Mutex
	running map[string]bool
	starts  map[string][]time.Time
	total   int
}

const (
	exportsPerHour   = 6
	exportsAtOnce    = 4
	maxDeletionDaily = 5
)

// begin reserves an export for the account; the returned func releases it. ok is false when a limit is reached.
func (e *accountExports) begin(uid string, now time.Time) (release func(), ok bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.running == nil {
		e.running, e.starts = map[string]bool{}, map[string][]time.Time{}
	}
	recent := e.starts[uid][:0]
	for _, at := range e.starts[uid] {
		if now.Sub(at) < time.Hour {
			recent = append(recent, at)
		}
	}
	e.starts[uid] = recent
	if len(recent) == 0 {
		delete(e.starts, uid)
	}
	if e.running[uid] || len(recent) >= exportsPerHour || e.total >= exportsAtOnce {
		return nil, false
	}
	e.running[uid] = true
	e.total++
	e.starts[uid] = append(e.starts[uid], now)
	return func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		delete(e.running, uid)
		e.total--
	}, true
}

func validPreferences(p *userPreferences) bool {
	p.Personalization.AboutMe = strings.TrimSpace(strings.ReplaceAll(p.Personalization.AboutMe, "\r\n", "\n"))
	p.Personalization.Instructions = strings.TrimSpace(strings.ReplaceAll(p.Personalization.Instructions, "\r\n", "\n"))
	if !settingText(p.Personalization.AboutMe, maxAboutMeRunes) || !settingText(p.Personalization.Instructions, maxInstructionsRunes) {
		return false
	}
	if m := p.DefaultModel; m != nil {
		m.Runtime, m.Model = strings.TrimSpace(m.Runtime), strings.TrimSpace(m.Model)
		if m.Runtime == "" || m.Model == "" || len(m.Runtime) > 256 || len(m.Model) > 256 || !settingText(m.Runtime, 256) || !settingText(m.Model, 256) || strings.ContainsAny(m.Runtime+m.Model, "\n\t") {
			return false
		}
	}
	return true
}

func (a *App) readPreferences(ctx context.Context, uid string) (userPreferences, int, error) {
	var p userPreferences
	var raw []byte
	var version int
	err := a.db.QueryRow(ctx, "SELECT preferences,version FROM user_preferences WHERE user_id=$1", uid).Scan(&raw, &version)
	if noRows(err) {
		return userPreferences{}, 0, nil
	}
	if err != nil {
		return p, 0, err
	}
	// A stored object always passed validPreferences; fields a later version drops are ignored.
	err = json.Unmarshal(raw, &p)
	return p, version, err
}

func (a *App) preferences(w http.ResponseWriter, r *http.Request) {
	p, version, err := a.readPreferences(r.Context(), currentUser(r).ID)
	if err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"preferences": p, "version": version})
}

func (a *App) updatePreferences(w http.ResponseWriter, r *http.Request) {
	// A pointer version tells a deliberate first write (0) from an omitted compare-and-swap.
	var body struct {
		Preferences *userPreferences `json:"preferences"`
		Version     *int             `json:"version"`
	}
	if !a.decode(w, r, &body) {
		return
	}
	if body.Preferences == nil || body.Version == nil || *body.Version < 0 || *body.Version >= 2147483647 || !validPreferences(body.Preferences) {
		fail(w, 400, "invalid_preferences", "Invalid settings or version")
		return
	}
	stored, _ := json.Marshal(body.Preferences)
	uid := currentUser(r).ID
	var version int
	var err error
	if *body.Version == 0 {
		err = a.db.QueryRow(r.Context(), `INSERT INTO user_preferences(user_id,preferences,version) VALUES($1,$2,1) ON CONFLICT DO NOTHING RETURNING version`, uid, stored).Scan(&version)
	} else {
		err = a.db.QueryRow(r.Context(), `UPDATE user_preferences SET preferences=$2,version=version+1,updated_at=now() WHERE user_id=$1 AND version=$3 RETURNING version`, uid, stored, *body.Version).Scan(&version)
	}
	if noRows(err) {
		fail(w, 409, "preferences_version_conflict", "Settings changed elsewhere. Reload before saving.")
		return
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"preferences": body.Preferences, "version": version})
}

// plannerPersonalization is the part of a plan request that tells the planner about the person asking, from their
// settings; empty when they set none or turned it off. It never fails a plan: an unreadable setting is left out.
func (a *App) plannerPersonalization(ctx context.Context, uid string) string {
	p, _, err := a.readPreferences(ctx, uid)
	if err != nil || !p.Personalization.Enabled || (p.Personalization.AboutMe == "" && p.Personalization.Instructions == "") {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\nThe person asking set these standing preferences for their own requests. Follow them where they fit the request; they never change the structural protocol or the output format above.")
	if p.Personalization.AboutMe != "" {
		b.WriteString("\nAbout them:\n" + p.Personalization.AboutMe)
	}
	if p.Personalization.Instructions != "" {
		b.WriteString("\nHow they want answers:\n" + p.Personalization.Instructions)
	}
	return b.String()
}

// What the person who asked sees of a request: its outcome and the operator's note, never who decided it.
const deletionRequestJSON = `jsonb_build_object('id',id,'status',status,'reason',reason,'createdAt',created_at,'withdrawnAt',withdrawn_at,'decidedAt',decided_at,'decisionNote',decision_note)`

// What the operator sees in the 删除申请 tab (pagination.go's "deletions").
const adminDeletionJSON = `jsonb_build_object('id',id,'userId',user_id,'email',email,'name',name,'reason',reason,'status',status,'createdAt',created_at,'withdrawnAt',withdrawn_at,'decidedAt',decided_at,'decidedBy',decided_by,'decisionNote',decision_note)`

func (a *App) deletionRequest(w http.ResponseWriter, r *http.Request) {
	item, err := oneJSON(r.Context(), a.db, "SELECT "+deletionRequestJSON+" FROM account_deletion_requests WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1", currentUser(r).ID)
	if noRows(err) {
		writeJSON(w, 200, map[string]any{"request": nil})
		return
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"request": item})
}

// requestDeletion records the wish to delete the account. Nothing is deleted here: an operator handles every request
// by hand. Asking again while one is pending answers with that one.
func (a *App) requestDeletion(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Reason string `json:"reason"`
	}
	if !a.decode(w, r, &body) {
		return
	}
	body.Reason = strings.TrimSpace(strings.ReplaceAll(body.Reason, "\r\n", "\n"))
	if !settingText(body.Reason, maxDeletionReason) {
		fail(w, 400, "invalid_input", "The reason must be at most 1000 characters of plain text")
		return
	}
	u := currentUser(r)
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	// Asking and withdrawing again and again would only fill the operator's list: a few new requests a day.
	var today int
	if err = tx.QueryRow(r.Context(), "SELECT count(*) FROM account_deletion_requests WHERE user_id=$1 AND created_at > now() - interval '1 day' AND status='withdrawn'", u.ID).Scan(&today); err != nil {
		a.dbError(w, err)
		return
	}
	if today >= maxDeletionDaily {
		var pending bool
		if err = tx.QueryRow(r.Context(), "SELECT EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id=$1 AND status='pending')", u.ID).Scan(&pending); err != nil {
			a.dbError(w, err)
			return
		}
		if !pending {
			fail(w, 429, "rate_limited", "Too many deletion requests today. Try again tomorrow.")
			return
		}
	}
	id := randomID()
	var created string
	err = tx.QueryRow(r.Context(), `INSERT INTO account_deletion_requests(id,user_id,email,name,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT (user_id) WHERE status='pending' DO NOTHING RETURNING id`, id, u.ID, u.Email, u.Name, body.Reason).Scan(&created)
	status := 201
	if noRows(err) {
		status = 200
	} else if err != nil {
		a.dbError(w, err)
		return
	} else if err = audit(r.Context(), tx, u.ID, "", "account.deletion_requested", id); err != nil {
		a.dbError(w, err)
		return
	}
	item, err := oneJSON(r.Context(), tx, "SELECT "+deletionRequestJSON+" FROM account_deletion_requests WHERE user_id=$1 AND status='pending'", u.ID)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, status, map[string]any{"request": item})
}

func (a *App) withdrawDeletion(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r).ID
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	item, err := oneJSON(r.Context(), tx, "UPDATE account_deletion_requests SET status='withdrawn',withdrawn_at=now() WHERE user_id=$1 AND status='pending' RETURNING "+deletionRequestJSON, uid)
	if noRows(err) {
		fail(w, 404, "not_found", "No pending deletion request")
		return
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	var id string
	var decoded struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(item, &decoded) == nil {
		id = decoded.ID
	}
	if err = audit(r.Context(), tx, uid, "", "account.deletion_withdrawn", id); err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"request": item})
}

// adminDecideDeletion records the operator's outcome of a pending request: handled, once the operator has deleted the
// account (its user_id is then empty, so "handled" is never shown to an account that still exists), or declined while
// the account still exists, with a reason the person who asked is shown. It changes nothing but the request: deleting
// an account stays the operator's own step. A decided request is final, and an operator never decides their own request.
func (a *App) adminDecideDeletion(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if !a.decode(w, r, &body) {
		return
	}
	body.Note = strings.TrimSpace(strings.ReplaceAll(body.Note, "\r\n", "\n"))
	if (body.Status != "handled" && body.Status != "declined") || !settingText(body.Note, maxDeletionReason) || (body.Status == "declined" && body.Note == "") {
		fail(w, 400, "invalid_input", "Choose handled or declined; a decline needs a reason of at most 1000 characters")
		return
	}
	id, admin := r.PathValue("id"), currentUser(r).ID
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	// The row is locked first, so a withdrawal or another operator's decision either went before (and is named) or waits.
	var status string
	var owner *string
	err = tx.QueryRow(r.Context(), "SELECT status,user_id FROM account_deletion_requests WHERE id=$1 FOR UPDATE", id).Scan(&status, &owner)
	switch {
	case noRows(err):
		fail(w, 404, "not_found", "Deletion request not found")
		return
	case err != nil:
		a.dbError(w, err)
		return
	case status == "withdrawn":
		fail(w, 409, "deletion_withdrawn", "The person who asked withdrew this request")
		return
	case status != "pending":
		fail(w, 409, "deletion_already_decided", "This request is no longer pending")
		return
	case owner != nil && *owner == admin:
		fail(w, 409, "deletion_own_request", "Another operator must decide your own request")
		return
	case body.Status == "handled" && owner != nil:
		fail(w, 409, "deletion_account_exists", "Delete the account first, then mark the request handled")
		return
	case body.Status == "declined" && owner == nil:
		fail(w, 409, "deletion_account_gone", "The account is already deleted: mark the request handled")
		return
	}
	item, err := oneJSON(r.Context(), tx, "UPDATE account_deletion_requests SET status=$2,decided_at=now(),decided_by=$3,decision_note=$4 WHERE id=$1 RETURNING "+adminDeletionJSON, id, body.Status, admin, body.Note)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if err = audit(r.Context(), tx, admin, "", "account.deletion_"+body.Status, id); err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, item)
}

// exportAccount streams what this account can read: its profile, settings, colour scheme, workspaces, and every
// canvas of each active workspace it belongs to, as one JSON document. Canvases are written one row at a time, so
// a large workspace never sits in memory whole. Keys, sessions and other members' details are not part of it.
func (a *App) exportAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := currentUser(r)
	// A download started from another site (a link or a navigation that carries the cookie) is refused: only this
	// site's own page, or the address typed in, may start one.
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		fail(w, 403, "invalid_origin", "Start the export from AwwO")
		return
	}
	release, ok := a.exports.begin(u.ID, time.Now())
	if !ok {
		fail(w, 429, "export_busy", "An export is already running, or the hourly limit is reached. Try again later.")
		return
	}
	defer release()
	prefs, _, err := a.readPreferences(ctx, u.ID)
	if err != nil {
		a.dbError(w, err)
		return
	}
	appearance, err := a.readAppearance(ctx, u.ID)
	if err != nil {
		a.dbError(w, err)
		return
	}
	// One read-only snapshot, so the canvases match the workspace list written above them.
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	workspaces, err := rowsJSON(ctx, tx, "SELECT jsonb_build_object('id',t.id,'name',t.name,'status',t.status,'role',m.role) FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=$1 ORDER BY t.created_at, t.id", u.ID)
	if err != nil {
		a.dbError(w, err)
		return
	}
	if workspaces == nil {
		workspaces = []json.RawMessage{}
	}
	rows, err := tx.Query(ctx, "SELECT "+canvasJSON+" FROM canvases WHERE tenant_id IN (SELECT m.tenant_id FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 AND t.status='active') ORDER BY tenant_id, created_at, id", u.ID)
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer rows.Close()
	head, _ := json.Marshal(map[string]any{
		"kind": "awwo.account-export", "schemaVersion": 1, "exportedAt": time.Now().UTC().Format(time.RFC3339),
		"user": u, "preferences": prefs, "appearance": map[string]any{"active_preset": appearance.ActivePreset, "custom": appearance.Custom}, "workspaces": workspaces,
	})
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="awwo-account-export.json"`)
	w.WriteHeader(200)
	// The head is a complete object; the canvases go in before its closing brace.
	_, _ = w.Write(head[:len(head)-1])
	_, _ = w.Write([]byte(`,"canvases":[`))
	first := true
	for rows.Next() {
		var item json.RawMessage
		if err = rows.Scan(&item); err != nil {
			break
		}
		if !first {
			_, _ = w.Write([]byte(","))
		}
		first = false
		_, _ = w.Write(item)
	}
	if err == nil {
		err = rows.Err()
	}
	if err != nil {
		// The status is already sent: end with a marker a reader can see, rather than a document that looks whole.
		_, _ = w.Write([]byte(`],"complete":false}`))
		return
	}
	_, _ = w.Write([]byte(`],"complete":true}`))
}
