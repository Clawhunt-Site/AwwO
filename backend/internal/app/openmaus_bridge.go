package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// OpenMaus does not offer AwwO tenant isolation. An operator therefore binds an
// exclusive server origin to one tenant; neither URLs nor credentials are set by
// browser requests. No endpoint for changing approvals or execution policy exists.
type openMausConnection struct {
	TenantID string `json:"tenantId"`
	URL      string `json:"url"`
	Token    string `json:"token"`
}

var openMausID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$`)

func (c *Config) openMausFromEnv() error {
	raw := os.Getenv("AWWO_OPENMAUS_CONNECTIONS_JSON")
	if raw == "" {
		return nil
	}
	if len(raw) > 1<<20 {
		return errors.New("AWWO_OPENMAUS_CONNECTIONS_JSON is too large")
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&c.OpenMausConnections) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("Invalid AWWO_OPENMAUS_CONNECTIONS_JSON")
	}
	return validateOpenMausConnections(c.OpenMausConnections)
}
func openMausOrigin(raw string) (string, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || u.RawPath != "" {
		return "", errors.New("OpenMaus URL must be an exact HTTP(S) origin without credentials")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")) {
		return "", errors.New("OpenMaus requires HTTPS or loopback HTTP")
	}
	u.Host = strings.ToLower(u.Host)
	u.Path = ""
	if u.Port() == "443" && u.Scheme == "https" {
		u.Host = strings.TrimSuffix(u.Host, ":443")
	}
	if u.Port() == "80" && u.Scheme == "http" {
		u.Host = strings.TrimSuffix(u.Host, ":80")
	}
	return u.String(), nil
}
func validateOpenMausConnections(connections []openMausConnection) error {
	if len(connections) > 256 {
		return errors.New("Too many OpenMaus connections")
	}
	seenTenants, seenOrigins := map[string]bool{}, map[string]bool{}
	for _, connection := range connections {
		origin, err := openMausOrigin(connection.URL)
		if err != nil {
			return err
		}
		if !typeSafeTenantID.MatchString(connection.TenantID) || seenTenants[connection.TenantID] {
			return errors.New("OpenMaus tenant identities must be unique and explicit")
		}
		if seenOrigins[origin] {
			return errors.New("An OpenMaus server origin must belong exclusively to one AwwO tenant")
		}
		if len(connection.Token) < 16 || len(connection.Token) > 4096 {
			return errors.New("OpenMaus requires a paired service token of 16–4096 characters")
		}
		for _, ch := range connection.Token {
			if ch < 33 || ch > 126 {
				return errors.New("Invalid OpenMaus token")
			}
		}
		seenTenants[connection.TenantID], seenOrigins[origin] = true, true
	}
	return nil
}
func (a *App) openMausConnection(tid string) (openMausConnection, bool) {
	for _, connection := range a.cfg.OpenMausConnections {
		if connection.TenantID == tid {
			return connection, true
		}
	}
	return openMausConnection{}, false
}

type openMausUpstreamError struct{ status int }

func (e openMausUpstreamError) Error() string { return "OpenMaus request failed" }
func (a *App) openMausRequest(ctx context.Context, connection openMausConnection, method, path string, body any, result any) error {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	var input io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		input = bytes.NewReader(raw)
	}
	origin, err := openMausOrigin(connection.URL)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, origin+path, input)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+connection.Token)
	req.Header.Set("Content-Type", "application/json")
	// No Idempotency-Key and no redirect: neither transport nor app retries a POST.
	response, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return openMausUpstreamError{response.StatusCode}
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil {
		return err
	}
	if len(raw) > 2<<20 || !json.Valid(raw) {
		return errors.New("Invalid or oversized OpenMaus response")
	}
	if result != nil {
		return json.Unmarshal(raw, result)
	}
	return nil
}

type openMausTask struct {
	ID    string `json:"threadId"`
	Title string `json:"title"`
	Busy  bool   `json:"busy"`
}
type openMausBot struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Busy        bool           `json:"busy"`
	Activity    string         `json:"activity"`
	ThreadID    string         `json:"threadId"`
	Tasks       []openMausTask `json:"tasks"`
}
type openMausFleet struct {
	Bots   []openMausBot `json:"bots"`
	Groups []struct {
		BusyBotID string `json:"busyBotId"`
	} `json:"groups"`
}

func (a *App) openMausFleet(ctx context.Context, connection openMausConnection) (openMausFleet, error) {
	var health struct {
		App string `json:"app"`
	}
	var fleet openMausFleet
	if e := a.openMausRequest(ctx, connection, "GET", "/api/health", nil, &health); e != nil {
		return fleet, e
	}
	if health.App != "openmausbot" {
		return fleet, errors.New("Configured service is not OpenMausBot")
	}
	if e := a.openMausRequest(ctx, connection, "GET", "/api/bots?messages=0", nil, &fleet); e != nil {
		return fleet, e
	}
	if fleet.Bots == nil || len(fleet.Bots) > 500 || len(fleet.Groups) > 500 {
		return fleet, errors.New("Invalid OpenMaus fleet")
	}
	return fleet, nil
}
func openMausOwnedTask(fleet openMausFleet, botID, taskID string) (openMausBot, string, error) {
	if !openMausID.MatchString(botID) || (taskID != "" && !openMausID.MatchString(taskID)) {
		return openMausBot{}, "", knowledgeInvalid("Invalid bot or task identity")
	}
	for _, bot := range fleet.Bots {
		if bot.ID != botID {
			continue
		}
		if taskID == "" {
			taskID = bot.ThreadID
		}
		if !openMausID.MatchString(taskID) {
			return openMausBot{}, "", knowledgeMissing()
		}
		if taskID == bot.ThreadID {
			return bot, taskID, nil
		}
		for _, task := range bot.Tasks {
			if task.ID == taskID {
				return bot, taskID, nil
			}
		}
	}
	return openMausBot{}, "", knowledgeMissing()
}
func openMausBotProjection(bot openMausBot) map[string]any {
	tasks := []map[string]any{}
	for _, task := range bot.Tasks {
		if openMausID.MatchString(task.ID) {
			tasks = append(tasks, map[string]any{"id": task.ID, "title": task.Title, "busy": task.Busy, "active": task.ID == bot.ThreadID})
		}
	}
	return map[string]any{"id": bot.ID, "name": bot.Name, "title": bot.Title, "description": bot.Description, "busy": bot.Busy, "activity": bot.Activity, "activeTaskId": bot.ThreadID, "tasks": tasks}
}
func (a *App) openMausConfigured(w http.ResponseWriter, r *http.Request) (openMausConnection, bool) {
	connection, ok := a.openMausConnection(r.PathValue("tenantId"))
	if !ok {
		fail(w, 503, "openmaus_disabled", "OpenMaus is not configured for this workspace")
	}
	return connection, ok
}
func openMausFailure(w http.ResponseWriter, err error) {
	var input knowledgeError
	if errors.As(err, &input) {
		fail(w, input.status, input.code, input.message)
		return
	}
	fail(w, 502, "openmaus_unavailable", "Could not read the configured OpenMaus service")
}
func (a *App) openMausStatus(w http.ResponseWriter, r *http.Request) {
	connection, ok := a.openMausConnection(r.PathValue("tenantId"))
	if !ok {
		writeJSON(w, 200, map[string]any{"configured": false, "available": false, "status": "disabled", "message": "An administrator can configure an exclusive OpenMaus instance for this workspace."})
		return
	}
	var health struct {
		App string `json:"app"`
	}
	err := a.openMausRequest(r.Context(), connection, "GET", "/api/health", nil, &health)
	if err != nil || health.App != "openmausbot" {
		writeJSON(w, 200, map[string]any{"configured": true, "available": false, "status": "unavailable", "message": "The configured OpenMaus service could not be verified."})
		return
	}
	writeJSON(w, 200, map[string]any{"configured": true, "available": true, "status": "connected", "message": "Connected. Sending a task may cause the selected bot to use its tools."})
}
func (a *App) listOpenMausBots(w http.ResponseWriter, r *http.Request) {
	connection, ok := a.openMausConfigured(w, r)
	if !ok {
		return
	}
	fleet, e := a.openMausFleet(r.Context(), connection)
	if e != nil {
		openMausFailure(w, e)
		return
	}
	bots := []map[string]any{}
	for _, bot := range fleet.Bots {
		if openMausID.MatchString(bot.ID) {
			bots = append(bots, openMausBotProjection(bot))
		}
	}
	writeJSON(w, 200, map[string]any{"bots": bots})
}

type openMausMessage struct {
	ID       string          `json:"id"`
	Role     string          `json:"role"`
	Kind     string          `json:"kind"`
	Text     string          `json:"text"`
	At       json.RawMessage `json:"at"`
	Queued   bool            `json:"queued"`
	HasImage bool            `json:"hasImage"`
	Card     *struct {
		Answered  json.RawMessage `json:"answered"`
		Dismissed bool            `json:"dismissed"`
		Expired   bool            `json:"expired"`
	} `json:"card"`
	Secret    json.RawMessage `json:"secret"`
	Connector json.RawMessage `json:"connector"`
}
type openMausMessagePage struct {
	Messages []openMausMessage `json:"messages"`
	HasMore  bool              `json:"hasMore"`
}

func openMausNeedsInput(message openMausMessage) bool {
	answered := false
	if message.Card != nil {
		// The upstream wire format uses an answer string (e.g. allow/deny).
		// Retain compatibility with older boolean clients without rejecting a page.
		var answer string
		if json.Unmarshal(message.Card.Answered, &answer) == nil {
			answered = answer != ""
		} else {
			_ = json.Unmarshal(message.Card.Answered, &answered)
		}
	}
	return (message.Card != nil && !answered && !message.Card.Dismissed && !message.Card.Expired) || (len(message.Secret) > 0 && string(message.Secret) != "null") || (len(message.Connector) > 0 && string(message.Connector) != "null")
}
func (a *App) openMausMessages(ctx context.Context, connection openMausConnection, botID, taskID string, limit string) (string, openMausMessagePage, error) {
	var page openMausMessagePage
	fleet, err := a.openMausFleet(ctx, connection)
	if err != nil {
		return "", page, err
	}
	_, taskID, err = openMausOwnedTask(fleet, botID, taskID)
	if err != nil {
		return "", page, err
	}
	err = a.openMausRequest(ctx, connection, "GET", "/api/threads/"+url.PathEscape(taskID)+"/messages?limit="+limit, nil, &page)
	if err == nil && (page.Messages == nil || len(page.Messages) > 200) {
		err = errors.New("Invalid OpenMaus messages")
	}
	return taskID, page, err
}
func (a *App) getOpenMausMessages(w http.ResponseWriter, r *http.Request) {
	connection, ok := a.openMausConfigured(w, r)
	if !ok {
		return
	}
	botID := r.PathValue("id")
	taskID, page, err := a.openMausMessages(r.Context(), connection, botID, r.URL.Query().Get("taskId"), "30")
	if err != nil {
		openMausFailure(w, err)
		return
	}
	messages := []map[string]any{}
	for _, message := range page.Messages {
		text := message.Text
		truncated := len(text) > 64<<10
		if truncated {
			text = text[:64<<10]
			for !utf8.ValidString(text) {
				text = text[:len(text)-1]
			}
		}
		// Cards, secrets, connector payloads, tool arguments, screenshots and service
		// configuration never cross this projection, including on approval requests.
		messages = append(messages, map[string]any{"id": message.ID, "role": message.Role, "kind": message.Kind, "text": text, "at": message.At, "queued": message.Queued, "needsInput": openMausNeedsInput(message), "hasImage": message.HasImage || message.Kind == "screen", "truncated": truncated})
	}
	writeJSON(w, 200, map[string]any{"botId": botID, "taskId": taskID, "messages": messages, "hasMore": page.HasMore})
}

const openMausDispatchJSON = `jsonb_build_object('operationId',operation_id,'botId',bot_id,'taskId',task_id,'status',CASE WHEN status='sending' AND updated_at<now()-interval '15 seconds' THEN 'unknown' ELSE status END,'message',message)`

func (a *App) getOpenMausTask(w http.ResponseWriter, r *http.Request) {
	value, err := oneJSON(r.Context(), a.db, "SELECT "+openMausDispatchJSON+" FROM openmaus_dispatches WHERE tenant_id=$1 AND operation_id=$2", r.PathValue("tenantId"), r.PathValue("id"))
	a.replyOne(w, value, err, 200)
}
func (a *App) sendOpenMausTask(w http.ResponseWriter, r *http.Request) {
	var b struct {
		BotID       string `json:"botId"`
		TaskID      string `json:"taskId"`
		Text        string `json:"text"`
		OperationID string `json:"operationId"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if !openMausID.MatchString(b.BotID) || (b.TaskID != "" && !openMausID.MatchString(b.TaskID)) || len(b.OperationID) < 8 || len(b.OperationID) > 200 || strings.TrimSpace(b.Text) == "" || len(b.Text) > 32768 || !utf8.ValidString(b.Text) || strings.IndexByte(b.Text, 0) >= 0 {
		a.knowledgeFailure(w, knowledgeInvalid("Provide a bot, task, nonempty text up to 32 KiB and stable operationId"))
		return
	}
	connection, ok := a.openMausConfigured(w, r)
	if !ok {
		return
	}
	tid := r.PathValue("tenantId")
	raw, _ := json.Marshal(b)
	hash := tokenHash(string(raw))
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		a.dbError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, ok = a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	var oldHash string
	err = tx.QueryRow(r.Context(), "SELECT request_hash FROM openmaus_dispatches WHERE tenant_id=$1 AND operation_id=$2", tid, b.OperationID).Scan(&oldHash)
	if err == nil {
		if oldHash != hash {
			fail(w, 409, "idempotency_conflict", "operationId was used for a different task")
			return
		}
		value, e := oneJSON(r.Context(), tx, "SELECT "+openMausDispatchJSON+" FROM openmaus_dispatches WHERE tenant_id=$1 AND operation_id=$2", tid, b.OperationID)
		a.replyOne(w, value, e, 202)
		return
	}
	if !noRows(err) {
		a.dbError(w, err)
		return
	}
	fleet, err := a.openMausFleet(r.Context(), connection)
	if err != nil {
		openMausFailure(w, err)
		return
	}
	_, taskID, err := openMausOwnedTask(fleet, b.BotID, b.TaskID)
	if err != nil {
		openMausFailure(w, err)
		return
	}
	for _, group := range fleet.Groups {
		if group.BusyBotID == b.BotID {
			fail(w, 409, "openmaus_bot_busy", "The bot is working in a channel; wait before sending another task")
			return
		}
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO openmaus_dispatches(tenant_id,operation_id,request_hash,actor_id,bot_id,task_id,status,message) VALUES($1,$2,$3,$4,$5,$6,'sending','Dispatch started; no automatic retry will occur.')", tid, b.OperationID, hash, currentUser(r).ID, b.BotID, taskID); err != nil {
		a.dbError(w, err)
		return
	}
	if err = audit(r.Context(), tx, currentUser(r).ID, tid, "openmaus.task.requested", b.OperationID); err != nil {
		a.dbError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		a.dbError(w, err)
		return
	}
	// The record is durable BEFORE the only external mutation. Losing the process
	// here is intentionally recoverable as an uncertain receipt, never a resend.
	err = a.openMausRequest(r.Context(), connection, "POST", "/api/bots/"+url.PathEscape(b.BotID)+"/messages", map[string]string{"text": b.Text, "threadId": taskID}, nil)
	status, message := "sent", "The task was sent. Read the bot's messages to verify progress and results."
	if err != nil {
		status, message = "unknown", "The delivery result is unknown. Inspect the bot's messages before deciding whether to send a new task."
		var upstream openMausUpstreamError
		if errors.As(err, &upstream) && upstream.status >= 400 && upstream.status < 500 {
			status, message = "rejected", "OpenMaus rejected the task. Check the service and permissions before sending a new task."
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, saveErr := a.db.Exec(ctx, "UPDATE openmaus_dispatches SET status=$3,message=$4,updated_at=now() WHERE tenant_id=$1 AND operation_id=$2 AND status='sending'", tid, b.OperationID, status, message); saveErr != nil {
		status, message = "unknown", "Delivery may have occurred, but its receipt could not be saved. Inspect the bot's messages; do not automatically retry."
	}
	writeJSON(w, 202, map[string]any{"operationId": b.OperationID, "botId": b.BotID, "taskId": taskID, "status": status, "message": message})
}

func (a *App) importOpenMausMessage(w http.ResponseWriter, r *http.Request) {
	var b struct {
		BotID       string `json:"botId"`
		TaskID      string `json:"taskId"`
		MessageID   string `json:"messageId"`
		Title       string `json:"title"`
		OperationID string `json:"operationId"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	connection, ok := a.openMausConfigured(w, r)
	if !ok {
		return
	}
	a.knowledgeMutation(w, r, b.OperationID, "knowledge.openmaus.imported", b, func(tx pgx.Tx) (json.RawMessage, int, error) {
		tid := r.PathValue("tenantId")
		if b.MessageID == "" || len(b.MessageID) > 200 {
			return nil, 0, knowledgeInvalid("A message identity is required")
		}
		taskID, page, err := a.openMausMessages(r.Context(), connection, b.BotID, b.TaskID, "200")
		if err != nil {
			return nil, 0, knowledgeError{502, "openmaus_unavailable", "Could not read the selected OpenMaus message"}
		}
		var message *openMausMessage
		for i := range page.Messages {
			if page.Messages[i].ID == b.MessageID {
				message = &page.Messages[i]
				break
			}
		}
		if message == nil {
			return nil, 0, knowledgeMissing()
		}
		if openMausNeedsInput(*message) {
			return nil, 0, knowledgeInvalid("Approval and credential requests are not task results")
		}
		uri := "openmaus:" + b.BotID + "/" + taskID + "/" + b.MessageID
		if err = validKnowledgeText(b.Title, message.Text, uri); err != nil {
			return nil, 0, err
		}
		hash := tokenHash(message.Text)
		provenance := map[string]any{"origin": "openmaus", "botId": b.BotID, "taskId": taskID, "messageId": b.MessageID, "messageAt": message.At, "observational": true}
		var old string
		err = tx.QueryRow(r.Context(), "SELECT id FROM knowledge_documents WHERE tenant_id=$1 AND source_hash=$2", tid, hash).Scan(&old)
		if err == nil {
			if err = recordKnowledgeOrigin(r.Context(), tx, tid, old, b.Title, uri, provenance, currentUser(r).ID); err != nil {
				return nil, 0, err
			}
			value, e := knowledgeDocument(r.Context(), tx, tid, old)
			return value, 200, e
		}
		if !noRows(err) {
			return nil, 0, err
		}
		id := randomID()
		if _, err = tx.Exec(r.Context(), "INSERT INTO knowledge_documents(id,tenant_id,kind,title,source_hash) VALUES($1,$2,'source',$3,$4)", id, tid, b.Title, hash); err != nil {
			return nil, 0, err
		}
		if _, err = publishKnowledgeRevision(r.Context(), tx, tid, id, 1, "", b.Title, message.Text, uri, provenance, []knowledgeLinkInput{}, currentUser(r).ID); err != nil {
			return nil, 0, err
		}
		if err = recordKnowledgeOrigin(r.Context(), tx, tid, id, b.Title, uri, provenance, currentUser(r).ID); err != nil {
			return nil, 0, err
		}
		value, err := knowledgeDocument(r.Context(), tx, tid, id)
		return value, 201, err
	})
}
func (a *App) registerOpenMausRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/openmaus/status", a.tenant(a.openMausStatus, 1))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/openmaus/bots", a.tenant(a.listOpenMausBots, 1))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/openmaus/bots/{id}/messages", a.tenant(a.getOpenMausMessages, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/openmaus/tasks", a.tenant(a.sendOpenMausTask, 2))
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/openmaus/tasks/{id}", a.tenant(a.getOpenMausTask, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/openmaus/imports", a.tenant(a.importOpenMausMessage, 2))
}
