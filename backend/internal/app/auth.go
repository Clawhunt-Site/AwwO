package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/argon2"
)

type User struct {
	ID           string `json:"id"`
	Email        string `json:"email"`
	Name         string `json:"name"`
	PlatformRole string `json:"platformRole"`
}
type userKey struct{}

func currentUser(r *http.Request) User { return r.Context().Value(userKey{}).(User) }
func randomID() string {
	b := make([]byte, 24)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return "a" + base64.RawURLEncoding.EncodeToString(b)
}
func tokenHash(s string) string { x := sha256.Sum256([]byte(s)); return hex.EncodeToString(x[:]) }
func hashPassword(s string) string {
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		panic(e)
	}
	key := argon2.IDKey([]byte(s), salt, 3, 64*1024, 2, 32)
	return "$argon2id$v=19$m=65536,t=3,p=2$" + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(key)
}
func checkPassword(s, h string) bool {
	parts := strings.Split(h, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" || parts[3] != "m=65536,t=3,p=2" {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(parts[4])
	if e != nil || len(salt) != 16 {
		return false
	}
	want, e := base64.RawStdEncoding.DecodeString(parts[5])
	if e != nil || len(want) != 32 {
		return false
	}
	got := argon2.IDKey([]byte(s), salt, 3, 64*1024, 2, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}
func validEmail(s string) bool {
	a, e := mail.ParseAddress(s)
	return e == nil && a.Address == s && len(s) <= 254
}
func (a *App) BootstrapAdmin(ctx context.Context) error {
	if a.cfg.AdminEmail == "" {
		return nil
	}
	email := strings.ToLower(strings.TrimSpace(a.cfg.AdminEmail))
	if !validEmail(email) {
		return errors.New("invalid bootstrap admin email")
	}
	var role string
	e := a.db.QueryRow(ctx, "SELECT platform_role FROM users WHERE email=$1", email).Scan(&role)
	if e == nil {
		if role != "admin" {
			return errors.New("bootstrap email belongs to non-admin account; refusing privilege escalation")
		}
		return nil
	}
	if !noRows(e) {
		return e
	}
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	id := randomID()
	if _, e = tx.Exec(ctx, "INSERT INTO users(id,email,name,password_hash,platform_role) VALUES($1,$2,'Platform administrator',$3,'admin')", id, email, hashPassword(a.cfg.AdminPassword)); e != nil {
		return e
	}
	if e = audit(ctx, tx, id, "", "admin.bootstrap", id); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (a *App) sessionCookie(w http.ResponseWriter, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: "awwo_session", Value: token, Path: "/", HttpOnly: true, Secure: a.cfg.Env != "development", SameSite: http.SameSiteLaxMode, MaxAge: maxAge})
}
func (a *App) createLogin(ctx context.Context, tx pgx.Tx, userID string) (string, error) {
	token := randomID() + randomID()
	_, e := tx.Exec(ctx, "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)", tokenHash(token), userID, time.Now().Add(a.cfg.SessionTTL))
	return token, e
}
func (a *App) register(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Email      string `json:"email"`
		Password   string `json:"password"`
		Name       string `json:"name"`
		TenantName string `json:"tenantName"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	b.Email = strings.ToLower(strings.TrimSpace(b.Email))
	b.Name = strings.TrimSpace(b.Name)
	b.TenantName = strings.TrimSpace(b.TenantName)
	if !validEmail(b.Email) || len(b.Password) < 12 || len(b.Password) > 1024 || b.Name == "" || len(b.Name) > 200 || b.TenantName == "" || len(b.TenantName) > 200 {
		fail(w, 400, "invalid_input", "Valid email, name, workspace name, and a password of 12–1024 bytes are required")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	u := User{randomID(), b.Email, b.Name, "user"}
	tid := randomID()
	if _, e = tx.Exec(r.Context(), "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)", u.ID, u.Email, u.Name, hashPassword(b.Password)); e != nil {
		var pe *pgconn.PgError
		if errors.As(e, &pe) && pe.Code == "23505" {
			fail(w, 409, "email_exists", "Email already registered")
		} else {
			a.dbError(w, e)
		}
		return
	}
	if _, e = tx.Exec(r.Context(), "INSERT INTO tenants(id,name) VALUES($1,$2)", tid, b.TenantName); e != nil {
		a.dbError(w, e)
		return
	}
	if _, e = tx.Exec(r.Context(), "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')", tid, u.ID); e != nil {
		a.dbError(w, e)
		return
	}
	token, e := a.createLogin(r.Context(), tx, u.ID)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, u.ID, tid, "tenant.created", tid); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	a.sessionCookie(w, token, int(a.cfg.SessionTTL.Seconds()))
	a.meResponse(w, r, u, 201)
}
func (a *App) login(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if len(b.Password) > 1024 {
		fail(w, 401, "invalid_credentials", "Invalid email or password")
		return
	}
	var u User
	var h string
	e := a.db.QueryRow(r.Context(), "SELECT id,email,name,platform_role,password_hash FROM users WHERE email=$1", strings.ToLower(strings.TrimSpace(b.Email))).Scan(&u.ID, &u.Email, &u.Name, &u.PlatformRole, &h)
	if noRows(e) {
		checkPassword(b.Password, a.dummyHash)
		fail(w, 401, "invalid_credentials", "Invalid email or password")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if !checkPassword(b.Password, h) {
		fail(w, 401, "invalid_credentials", "Invalid email or password")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	var currentHash string
	if e = tx.QueryRow(r.Context(), "SELECT password_hash FROM users WHERE id=$1 FOR SHARE", u.ID).Scan(&currentHash); e != nil {
		a.dbError(w, e)
		return
	}
	if currentHash != h {
		fail(w, 401, "invalid_credentials", "Password changed; sign in again")
		return
	}
	token, e := a.createLogin(r.Context(), tx, u.ID)
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, u.ID, "", "auth.login", u.ID); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	a.sessionCookie(w, token, int(a.cfg.SessionTTL.Seconds()))
	a.meResponse(w, r, u, 200)
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	c, e := r.Cookie("awwo_session")
	if e == nil {
		if _, e = a.db.Exec(r.Context(), "DELETE FROM auth_sessions WHERE token_hash=$1", tokenHash(c.Value)); e != nil {
			a.dbError(w, e)
			return
		}
	}
	a.sessionCookie(w, "", -1)
	w.WriteHeader(204)
}
func (a *App) meResponse(w http.ResponseWriter, r *http.Request, u User, status int) {
	items, e := rowsJSON(r.Context(), a.db, "SELECT "+tenantJSON+" || jsonb_build_object('role',m.role) FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=$1 ORDER BY t.created_at", u.ID)
	if e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, status, map[string]any{"user": u, "tenants": items, "personalCredentialsRequired": a.cfg.UserCredentials})
}
func (a *App) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, e := r.Cookie("awwo_session")
		if e != nil || len(c.Value) > 256 {
			fail(w, 401, "unauthorized", "Sign in required")
			return
		}
		var u User
		e = a.db.QueryRow(r.Context(), "SELECT u.id,u.email,u.name,u.platform_role FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()", tokenHash(c.Value)).Scan(&u.ID, &u.Email, &u.Name, &u.PlatformRole)
		if noRows(e) {
			fail(w, 401, "unauthorized", "Session expired")
			return
		}
		if e != nil {
			a.dbError(w, e)
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userKey{}, u)))
	}
}
func (a *App) tenant(next http.HandlerFunc, minRole int) http.HandlerFunc {
	return a.auth(func(w http.ResponseWriter, r *http.Request) {
		var role, status string
		e := a.db.QueryRow(r.Context(), "SELECT m.role,t.status FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1 AND m.user_id=$2", r.PathValue("tenantId"), currentUser(r).ID).Scan(&role, &status)
		if noRows(e) {
			fail(w, 404, "not_found", "Workspace not found")
			return
		}
		if e != nil {
			a.dbError(w, e)
			return
		}
		if roleLevel(role) < minRole {
			fail(w, 403, "forbidden", "Insufficient workspace permissions")
			return
		}
		if r.Method != "GET" && status != "active" {
			fail(w, 403, "tenant_suspended", "Workspace is suspended")
			return
		}
		next(w, r)
	})
}
func roleLevel(role string) int {
	return map[string]int{"reader": 1, "member": 2, "admin": 3, "owner": 4}[role]
}
func (a *App) admin(next http.HandlerFunc) http.HandlerFunc {
	return a.auth(func(w http.ResponseWriter, r *http.Request) {
		if currentUser(r).PlatformRole != "admin" {
			fail(w, 403, "forbidden", "Platform administrator required")
			return
		}
		next(w, r)
	})
}
