package app

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Presence posts (POST …/live/presence) come up to eight times a second from every page on a canvas while someone else
// is there, and each would read the session and the membership again (a.auth, a.tenant). A person's session admitted
// to a workspace is trusted for presence posts, and for nothing else, for livePresenceTrust after it was checked: the
// window the live stream already allows itself (reauthEvery). Sessions are forgotten at once where this process ends or
// changes them (a sign-out, a session ended from another device, a password changed or reset, leaving or being removed
// from the workspace, a role changed, a workspace suspended); anything else ends within that window, when the stream's
// own check ends the stream too. Every write still checks everything inside its transaction (AWWO-LAW-003).

const (
	livePresenceTrust = 15 * time.Second
	// livePresenceTrusted bounds how many sessions are trusted at once; past it, posts are checked in full.
	livePresenceTrusted = 4096
	// livePresenceBodyBytes bounds a presence post: a full selection, a preview of 50 nodes and the rest fit.
	livePresenceBodyBytes = 128 << 10
)

// presenceTrust is what a full check of a presence post found: the person, their role in the workspace, and whether the
// session is ClawHunt's.
type presenceTrust struct {
	user     User
	role     string
	clawHunt bool
	checked  time.Time
}

type presenceSessions struct {
	mu sync.Mutex
	// entries are keyed by presenceKey: a session's hash and the workspace.
	entries map[string]presenceTrust
	// generation moves on at every forget: a check that began before one may not be remembered after it (it may have
	// read a session or a membership that is gone since).
	generation uint64
	// now is the clock (tests set it); nil is time.Now.
	now func() time.Time
}

type presenceGenerationKey struct{}

// liveMembersKey holds the count of membership changes (memberCount) a presence post's role was found after.
type liveMembersKey struct{}

// begin gives the generation a full check starts in.
func (s *presenceSessions) begin() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.generation
}

func presenceKey(sessionHash, tenantID string) string { return sessionHash + "\x00" + tenantID }

func (s *presenceSessions) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// lookup gives a session's trust in a workspace while it holds.
func (s *presenceSessions) lookup(key string) (presenceTrust, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[key]
	if !ok {
		return presenceTrust{}, false
	}
	if s.clock().Sub(e.checked) >= livePresenceTrust {
		delete(s.entries, key)
		return presenceTrust{}, false
	}
	return e, true
}

// remember trusts a session in a workspace from now, unless too many are trusted already or something was forgotten
// since its check began (`since`, begin's).
func (s *presenceSessions) remember(key string, e presenceTrust, since uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if since != s.generation {
		return
	}
	if s.entries == nil {
		s.entries = map[string]presenceTrust{}
	}
	now := s.clock()
	if _, ok := s.entries[key]; !ok && len(s.entries) >= livePresenceTrusted {
		for k, old := range s.entries {
			if now.Sub(old.checked) >= livePresenceTrust {
				delete(s.entries, k)
			}
		}
		if len(s.entries) >= livePresenceTrusted {
			return
		}
	}
	e.checked = now
	s.entries[key] = e
}

// forget ends a session's trust in every workspace (it signed out).
func (s *presenceSessions) forget(sessionHash string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.generation++
	prefix := sessionHash + "\x00"
	for key := range s.entries {
		if strings.HasPrefix(key, prefix) {
			delete(s.entries, key)
		}
	}
}

// forgetUser ends the trust of every session of a person (their sessions were ended: a password changed or reset).
func (s *presenceSessions) forgetUser(userID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.generation++
	for key, e := range s.entries {
		if e.user.ID == userID {
			delete(s.entries, key)
		}
	}
}

// forgetTenant ends every trust in a workspace (it was suspended, or its limits changed).
func (s *presenceSessions) forgetTenant(tenantID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.generation++
	suffix := "\x00" + tenantID
	for key := range s.entries {
		if strings.HasSuffix(key, suffix) {
			delete(s.entries, key)
		}
	}
}

// forgetMember ends the trust of a person's sessions in a workspace (they left it, were removed, or their role changed).
func (s *presenceSessions) forgetMember(tenantID, userID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.generation++
	suffix := "\x00" + tenantID
	for key, e := range s.entries {
		if e.user.ID == userID && strings.HasSuffix(key, suffix) {
			delete(s.entries, key)
		}
	}
}

// livePresenceAccess admits a presence post as canvasAccess(next, 1) does, but takes a person's session as checked when
// a full check admitted it to this workspace within livePresenceTrust. An agent's token is checked every time. The
// count of membership changes is taken first: a role found trusted or checked is stale if one of the person's came
// after (setState).
func (a *App) livePresenceAccess(next http.HandlerFunc) http.HandlerFunc {
	checked := a.canvasAccess(func(w http.ResponseWriter, r *http.Request) {
		if agentOf(r) == nil {
			if c, err := r.Cookie("awwo_session"); err == nil {
				clawHunt, _ := r.Context().Value(clawHuntSessionKey{}).(bool)
				since, _ := r.Context().Value(presenceGenerationKey{}).(uint64)
				a.livePresence.remember(presenceKey(tokenHash(c.Value), r.PathValue("tenantId")),
					presenceTrust{user: currentUser(r), role: tenantRoleOf(r), clawHunt: clawHunt}, since)
			}
		}
		next(w, r)
	}, 1)
	return func(w http.ResponseWriter, r *http.Request) {
		r = r.WithContext(context.WithValue(r.Context(), liveMembersKey{}, a.multiplayer.memberCount()))
		if _, token := bearerCanvasToken(r); !token {
			if c, err := r.Cookie("awwo_session"); err == nil && len(c.Value) <= 256 {
				if e, ok := a.livePresence.lookup(presenceKey(tokenHash(c.Value), r.PathValue("tenantId"))); ok {
					ctx := context.WithValue(r.Context(), userKey{}, e.user)
					ctx = context.WithValue(ctx, clawHuntSessionKey{}, e.clawHunt)
					ctx = context.WithValue(ctx, tenantRoleKey{}, e.role)
					next(w, r.WithContext(ctx))
					return
				}
			}
		}
		// What the full check finds is remembered only if nothing was forgotten while it ran.
		checked(w, r.WithContext(context.WithValue(r.Context(), presenceGenerationKey{}, a.livePresence.begin())))
	}
}
