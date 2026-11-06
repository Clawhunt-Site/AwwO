package app

import (
	"context"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Who reaches a canvas's multiplayer routes (docs/awwo-canvas-live-collaboration.md): a person's page with its session
// cookie, or an agent with a canvas agent token as a bearer. A token acts for the person who made it and never beyond
// what they may do now (AWWO-LAW-029): the request carries that person as its user, so every check written for people
// (mutationRole, audit actors) holds for agents too, and canvasAgentKey says it is an agent's.

// canvasAgentTokenPattern is a canvas agent token: awwo_ct_<its row id>_<32 random bytes, base64url>.
var canvasAgentTokenPattern = regexp.MustCompile(`^awwo_ct_([0-9a-f]{16})_[A-Za-z0-9_-]{43}$`)

// canvasAgent is the agent behind a request made with a canvas agent token.
type canvasAgent struct {
	TokenID  string
	TenantID string
	CanvasID string
	Name     string
	// Scope is the token's own: "edit" or "read".
	Scope string
	// Port is how it came: "mcp" for the MCP endpoint, otherwise "api".
	Port string
}

type canvasAgentKey struct{}

// agentOf gives the agent behind a request, or nil for a person's.
func agentOf(r *http.Request) *canvasAgent {
	agent, _ := r.Context().Value(canvasAgentKey{}).(*canvasAgent)
	return agent
}

// bearerCanvasToken reads a canvas agent token from the Authorization header.
func bearerCanvasToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	return token, strings.HasPrefix(token, "awwo_ct_")
}

// canvasTokenScopeLevel is the most a token's scope allows, as a role level.
func canvasTokenScopeLevel(scope string) int {
	if scope == "edit" {
		return roleLevel("member")
	}
	return roleLevel("reader")
}

// canvasAccess admits a person by their session (a.tenant) or an agent by a canvas agent token for this canvas. The
// canvas is the path's {id} or {canvasId}.
func (a *App) canvasAccess(next http.HandlerFunc, minRole int) http.HandlerFunc {
	byPerson := a.tenant(next, minRole)
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerCanvasToken(r)
		if !ok {
			byPerson(w, r)
			return
		}
		ctx, ok := a.admitCanvasToken(w, r, token, minRole, "api")
		if !ok {
			return
		}
		canvasID := r.PathValue("id")
		if canvasID == "" {
			canvasID = r.PathValue("canvasId")
		}
		agent := ctx.Value(canvasAgentKey{}).(*canvasAgent)
		// Another workspace's or canvas's: not found, as for a person who is no member (AWWO-LAW-001).
		if agent.TenantID != r.PathValue("tenantId") || agent.CanvasID != canvasID {
			fail(w, 404, "not_found", "Canvas not found")
			return
		}
		next(w, r.WithContext(ctx))
	}
}

// admitCanvasToken checks a canvas agent token (a page may never use one: a request with an Origin is refused) and gives
// the request's context with the token's maker as its user and the agent beside them. minRole is checked against the
// lower of the maker's role now and the token's scope.
func (a *App) admitCanvasToken(w http.ResponseWriter, r *http.Request, token string, minRole int, port string) (context.Context, bool) {
	if r.Header.Get("Origin") != "" {
		fail(w, 403, "invalid_origin", "A canvas agent token is not accepted from a web page")
		return nil, false
	}
	if !a.canvasTokenLookupAllowed(r) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "rate_limited", "Too many failed token checks; try again in a minute")
		return nil, false
	}
	if !canvasAgentTokenPattern.MatchString(token) {
		a.canvasTokenLookupFailed(r)
		fail(w, 401, "invalid_token", "Canvas agent token not recognised")
		return nil, false
	}
	var agent canvasAgent
	var u User
	var role, status string
	e := a.db.QueryRow(r.Context(), `SELECT t.id,t.tenant_id,t.canvas_id,t.name,t.scope,u.id,u.email,u.name,m.role,tn.status
		FROM canvas_agent_tokens t JOIN users u ON u.id=t.created_by
		JOIN memberships m ON m.tenant_id=t.tenant_id AND m.user_id=t.created_by JOIN tenants tn ON tn.id=t.tenant_id
		WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp()`, tokenHash(token)).
		Scan(&agent.TokenID, &agent.TenantID, &agent.CanvasID, &agent.Name, &agent.Scope, &u.ID, &u.Email, &u.Name, &role, &status)
	if noRows(e) {
		a.canvasTokenLookupFailed(r)
		fail(w, 401, "invalid_token", "Canvas agent token not recognised, expired or revoked")
		return nil, false
	}
	if e != nil {
		a.dbError(w, e)
		return nil, false
	}
	if !a.canvasTokenRequestAllowed(agent.TokenID) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "rate_limited", "This token made too many requests; try again in a minute")
		return nil, false
	}
	if min(roleLevel(role), canvasTokenScopeLevel(agent.Scope)) < minRole {
		fail(w, 403, "forbidden", "This token may not do that")
		return nil, false
	}
	if r.Method != "GET" && status != "active" {
		fail(w, 403, "tenant_suspended", "Workspace is suspended")
		return nil, false
	}
	agent.Port = port
	// The token's maker, never with platform powers: a token is no administrator.
	u.PlatformRole = "user"
	_, _ = a.db.Exec(r.Context(), "UPDATE canvas_agent_tokens SET last_used_at=clock_timestamp() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<clock_timestamp()-interval '1 minute')", agent.TokenID)
	ctx := context.WithValue(r.Context(), userKey{}, u)
	ctx = context.WithValue(ctx, canvasAgentKey{}, &agent)
	return ctx, true
}

// canvasWriteRole is mutationRole for the multiplayer routes: the workspace row first, then the person's role, and for an
// agent the token still live and its scope enough, inside the write's own transaction (AWWO-LAW-003).
func (a *App) canvasWriteRole(w http.ResponseWriter, r *http.Request, tx pgx.Tx, tid string, minRole int) (string, bool) {
	role, ok := a.mutationRole(w, r, tx, tid, minRole)
	if !ok {
		return "", false
	}
	agent := agentOf(r)
	if agent == nil {
		return role, true
	}
	var scope string
	e := tx.QueryRow(r.Context(), "SELECT scope FROM canvas_agent_tokens WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()", tid, agent.TokenID).Scan(&scope)
	if noRows(e) {
		fail(w, 401, "invalid_token", "Canvas agent token expired or revoked")
		return "", false
	}
	if e != nil {
		a.dbError(w, e)
		return "", false
	}
	if canvasTokenScopeLevel(scope) < minRole {
		fail(w, 403, "forbidden", "This token may not do that")
		return "", false
	}
	return role, true
}

// canvasActorOf is who a request writes as: a person's page (its client id) or an agent (its token).
func canvasActorOf(r *http.Request, clientID string) canvasActor {
	u := currentUser(r)
	if agent := agentOf(r); agent != nil {
		return canvasActor{Kind: "agent", UserID: u.ID, TokenID: agent.TokenID, ClientID: "t_" + agent.TokenID, Name: agent.Name, Port: agent.Port}
	}
	return canvasActor{Kind: "human", UserID: u.ID, ClientID: clientID, Name: u.Name, Port: "web"}
}

// canvasActor is who made a change of a canvas.
type canvasActor struct {
	// Kind is "human" (a person's page), "agent" (a canvas agent token) or "awwo" (the server itself).
	Kind     string `json:"kind"`
	UserID   string `json:"userId,omitempty"`
	TokenID  string `json:"tokenId,omitempty"`
	ClientID string `json:"clientId"`
	Name     string `json:"name"`
	Port     string `json:"-"`
}

// participantID is how the live stream names an actor: a page by its client id, an agent by its token.
func (c canvasActor) participantID() string {
	if c.Kind == "agent" {
		return "t_" + c.TokenID
	}
	return c.ClientID
}
