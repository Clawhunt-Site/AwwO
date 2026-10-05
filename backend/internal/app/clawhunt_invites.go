package app

import (
	"crypto/subtle"
	"net/http"
	"regexp"
	"sync"
	"time"
)

// clawHuntInviteCodePattern is the printed form of a ClawHunt AwwO invite code.
var clawHuntInviteCodePattern = regexp.MustCompile(`^AWWO(-[0-9A-Z]{4}){3}$`)

type clawHuntInvite struct {
	Code   string `json:"code"`
	Status string `json:"status"`
}

// inviteReadLimiter bounds each account's invite-code reads: one at a time and perMinute a minute
// (10 when unset). It is separate from the sign-in limiter on purpose: an optional page that waits
// on the issuer must never hold a sign-in slot or spend an address's sign-in budget.
type inviteReadLimiter struct {
	mu        sync.Mutex
	users     map[string]*inviteReadWindow
	perMinute int
}
type inviteReadWindow struct {
	start time.Time
	count int
	busy  bool
}

func (l *inviteReadLimiter) begin(user string, now time.Time) (func(), bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.users == nil {
		l.users = map[string]*inviteReadWindow{}
	}
	limit := l.perMinute
	if limit <= 0 {
		limit = 10
	}
	w := l.users[user]
	if w == nil {
		w = &inviteReadWindow{start: now}
		l.users[user] = w
	}
	if now.Sub(w.start) >= time.Minute {
		w.start, w.count = now, 0
	}
	if w.busy || w.count >= limit {
		return nil, false
	}
	w.busy = true
	w.count++
	if len(l.users) > 10000 {
		for k, v := range l.users {
			if !v.busy && now.Sub(v.start) >= time.Minute {
				delete(l.users, k)
			}
		}
	}
	return func() {
		l.mu.Lock()
		w.busy = false
		l.mu.Unlock()
	}, true
}

// clawHuntInvites shows the signed-in account its own AwwO invite codes: every account with
// AwwO access has three to pass on. The issuer keeps them; AwwO asks with this session's grant
// over the backchannel, so the codes reach no one but their member. They are live invitations,
// so they are never logged, and every API response is no-store.
func (a *App) clawHuntInvites(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	done, ok := a.inviteReads.begin(u.ID, time.Now())
	if !ok {
		fail(w, 429, "rate_limited", "Too many requests for your invite codes; try again in a minute")
		return
	}
	defer done()
	c, err := r.Cookie("awwo_session")
	if err != nil {
		fail(w, 401, "unauthorized", "Sign in required")
		return
	}
	hash := tokenHash(c.Value)
	var issuer, subject string
	var sealed []byte
	if err = a.db.QueryRow(r.Context(), "SELECT COALESCE(sso_issuer,''),COALESCE(sso_subject,''),sso_grant FROM auth_sessions WHERE token_hash=$1 AND user_id=$2", hash, u.ID).Scan(&issuer, &subject, &sealed); err != nil {
		if noRows(err) {
			fail(w, 401, "unauthorized", "Session expired")
			return
		}
		a.dbError(w, err)
		return
	}
	if !a.clawHuntEnabled() || len(sealed) == 0 || issuer != a.cfg.ClawHuntURL || subject == "" {
		fail(w, 404, "not_found", "Invite codes come with a ClawHunt account")
		return
	}
	grant, err := a.openCredential(u.ID, "clawhunt-session:"+hash, sealed)
	if err != nil {
		fail(w, 503, "invites_unavailable", "Your invite codes are unavailable right now")
		return
	}
	var out struct {
		Active bool             `json:"active"`
		Sub    string           `json:"sub"`
		Member bool             `json:"member"`
		Limit  int              `json:"limit"`
		Codes  []clawHuntInvite `json:"codes"`
	}
	// Silence and a refusal read the same here: an issuer that predates the endpoint answers 404.
	if err = a.clawHuntRequest(r.Context(), "invites", map[string]string{"grant_token": grant}, &out); err != nil {
		fail(w, 503, "invites_unavailable", "Your invite codes are unavailable right now")
		return
	}
	if !out.Active {
		// The grant ended (main-site sign-out, a new password, withdrawn access), and so has this session.
		a.clawHuntSessions.forget(hash)
		a.sessionCookie(w, "", -1)
		fail(w, 401, "unauthorized", "Continue with ClawHunt again")
		return
	}
	// Live invitations go only to their own member: the answer must name this session's subject.
	if subtle.ConstantTimeCompare([]byte(out.Sub), []byte(subject)) != 1 || !validClawHuntInvites(out.Member, out.Limit, out.Codes) {
		fail(w, 503, "invites_unavailable", "Your invite codes are unavailable right now")
		return
	}
	codes := out.Codes
	if codes == nil {
		codes = []clawHuntInvite{}
	}
	writeJSON(w, 200, map[string]any{"member": out.Member, "limit": out.Limit, "codes": codes})
}

// validClawHuntInvites accepts only the issuer's documented shape, so the page never renders
// anything but printed codes with a known status.
func validClawHuntInvites(member bool, limit int, codes []clawHuntInvite) bool {
	if limit < 0 || limit > 10 || len(codes) > limit || (!member && len(codes) > 0) {
		return false
	}
	for _, c := range codes {
		if !clawHuntInviteCodePattern.MatchString(c.Code) || (c.Status != "unused" && c.Status != "used" && c.Status != "revoked") {
			return false
		}
	}
	return true
}
