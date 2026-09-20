package app

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"strings"
	"time"
)

func (a *App) listAuthSessions(w http.ResponseWriter, r *http.Request) {
	cookie, _ := r.Cookie("awwo_session")
	items, e := rowsJSON(r.Context(), a.db, `SELECT jsonb_build_object('id',id,'createdAt',created_at,'expiresAt',expires_at,'current',token_hash=$2) FROM auth_sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 100`, currentUser(r).ID, tokenHash(cookie.Value))
	a.replyList(w, items, e)
}
func (a *App) revokeAuthSession(w http.ResponseWriter, r *http.Request) {
	var hash string
	e := a.db.QueryRow(r.Context(), "DELETE FROM auth_sessions WHERE user_id=$1 AND id=$2 RETURNING token_hash", currentUser(r).ID, r.PathValue("id")).Scan(&hash)
	if noRows(e) {
		fail(w, 404, "not_found", "Session not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	c, _ := r.Cookie("awwo_session")
	if tokenHash(c.Value) == hash {
		a.sessionCookie(w, "", -1)
	}
	w.WriteHeader(204)
}
func (a *App) changePassword(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Current string `json:"currentPassword"`
		Next    string `json:"newPassword"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if len(b.Next) < 12 || len(b.Next) > 1024 || len(b.Current) > 1024 {
		fail(w, 400, "invalid_input", "Password must contain 12–1024 bytes")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	uid := currentUser(r).ID
	var old string
	if e = tx.QueryRow(r.Context(), "SELECT password_hash FROM users WHERE id=$1 FOR UPDATE", uid).Scan(&old); e != nil {
		a.dbError(w, e)
		return
	}
	if !checkPassword(b.Current, old) {
		fail(w, 401, "invalid_credentials", "Current password is incorrect")
		return
	}
	if _, e = tx.Exec(r.Context(), "UPDATE users SET password_hash=$2 WHERE id=$1", uid, hashPassword(b.Next)); e != nil {
		a.dbError(w, e)
		return
	}
	if _, e = tx.Exec(r.Context(), "DELETE FROM auth_sessions WHERE user_id=$1", uid); e != nil {
		a.dbError(w, e)
		return
	}
	if _, e = tx.Exec(r.Context(), "DELETE FROM password_resets WHERE user_id=$1", uid); e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, uid, "", "auth.password_changed", uid); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	a.sessionCookie(w, "", -1)
	w.WriteHeader(204)
}
func (a *App) forgotPassword(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Email string `json:"email"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if a.cfg.SMTPHost == "" && a.sendReset == nil {
		fail(w, 503, "email_unavailable", "Password recovery email is not configured. Contact the service administrator.")
		return
	}
	// Never reveal whether the address exists. At most one email per user/minute.
	accepted := func() {
		writeJSON(w, 200, map[string]string{"message": "If the account exists, a reset link will be emailed."})
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	if !validEmail(email) {
		accepted()
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	var uid string
	e = tx.QueryRow(r.Context(), "SELECT id FROM users WHERE email=$1 FOR UPDATE", email).Scan(&uid)
	if noRows(e) {
		accepted()
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	var recent bool
	if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM password_resets WHERE user_id=$1 AND created_at>now()-interval '1 minute')", uid).Scan(&recent); e != nil {
		a.dbError(w, e)
		return
	}
	if recent {
		accepted()
		return
	}
	token := randomID() + randomID()
	if _, e = tx.Exec(r.Context(), "DELETE FROM password_resets WHERE user_id=$1", uid); e != nil {
		a.dbError(w, e)
		return
	}
	if _, e = tx.Exec(r.Context(), "INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,$3)", tokenHash(token), uid, time.Now().Add(30*time.Minute)); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	link := a.cfg.PublicOrigin + "/?reset=" + url.QueryEscape(token)
	send := a.sendReset
	if send == nil {
		send = a.sendResetEmail
	}
	// Delivery latency must not disclose whether an email is registered. Bound
	// concurrent deliveries and join them during shutdown; never log the link.
	a.mu.Lock()
	if !a.closed {
		select {
		case a.mailSlots <- struct{}{}:
			a.tasks.Add(1)
			go func() {
				defer a.tasks.Done()
				defer func() { <-a.mailSlots }()
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				if send(ctx, email, link) != nil {
					a.log.Warn("password recovery delivery failed")
				}
			}()
		default:
			a.log.Warn("password recovery delivery capacity reached")
		}
	}
	a.mu.Unlock()
	accepted()
}
func (a *App) resetPassword(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if len(b.Token) > 256 || len(b.Token) < 32 || len(b.Password) < 12 || len(b.Password) > 1024 {
		fail(w, 400, "invalid_input", "Invalid reset request")
		return
	}
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	var uid string
	// Lock the user first, matching changePassword/forgotPassword lock order.
	e = tx.QueryRow(r.Context(), `SELECT u.id FROM users u JOIN password_resets p ON p.user_id=u.id WHERE p.token_hash=$1 AND p.expires_at>now() FOR UPDATE OF u`, tokenHash(b.Token)).Scan(&uid)
	if noRows(e) {
		fail(w, 400, "reset_invalid", "The reset link is invalid or expired")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	result, e := tx.Exec(r.Context(), "DELETE FROM password_resets WHERE user_id=$1 AND token_hash=$2 AND expires_at>now()", uid, tokenHash(b.Token))
	if e != nil {
		a.dbError(w, e)
		return
	}
	if result.RowsAffected() != 1 {
		fail(w, 400, "reset_invalid", "The reset link has already been used")
		return
	}
	if _, e = tx.Exec(r.Context(), "UPDATE users SET password_hash=$2 WHERE id=$1", uid, hashPassword(b.Password)); e != nil {
		a.dbError(w, e)
		return
	}
	if _, e = tx.Exec(r.Context(), "DELETE FROM auth_sessions WHERE user_id=$1", uid); e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, uid, "", "auth.password_reset", uid); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	a.sessionCookie(w, "", -1)
	w.WriteHeader(204)
}
func (a *App) sendResetEmail(ctx context.Context, email, link string) error {
	cfg := a.cfg
	address := net.JoinHostPort(cfg.SMTPHost, cfg.SMTPPort)
	dialer := &net.Dialer{Timeout: 8 * time.Second}
	var conn net.Conn
	var err error
	tlsConfig := &tls.Config{ServerName: cfg.SMTPHost, MinVersion: tls.VersionTLS12}
	if cfg.SMTPPort == "465" {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: tlsConfig}).DialContext(ctx, "tcp", address)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return errors.New("mail unavailable")
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(12 * time.Second))
	client, err := smtp.NewClient(conn, cfg.SMTPHost)
	if err != nil {
		return errors.New("mail unavailable")
	}
	defer client.Close()
	if cfg.SMTPPort != "465" {
		if err = client.StartTLS(tlsConfig); err != nil {
			return errors.New("mail requires TLS")
		}
	}
	if cfg.SMTPUsername != "" {
		if err = client.Auth(smtp.PlainAuth("", cfg.SMTPUsername, cfg.SMTPPassword, cfg.SMTPHost)); err != nil {
			return errors.New("mail authentication failed")
		}
	}
	if err = client.Mail(cfg.SMTPFrom); err != nil {
		return errors.New("mail sender rejected")
	}
	if err = client.Rcpt(email); err != nil {
		return errors.New("mail recipient rejected")
	}
	out, err := client.Data()
	if err != nil {
		return errors.New("mail unavailable")
	}
	_, err = out.Write([]byte("From: " + cfg.SMTPFrom + "\r\nTo: " + email + "\r\nSubject: Reset your AwwO password\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nUse this link within 30 minutes to reset your AwwO password:\r\n" + link + "\r\n\r\nIf you did not request this, ignore this email.\r\n"))
	if err != nil {
		return errors.New("mail delivery failed")
	}
	if err = out.Close(); err != nil {
		return errors.New("mail delivery failed")
	}
	return client.Quit()
}
