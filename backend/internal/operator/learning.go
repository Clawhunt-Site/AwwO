package operator

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"awwo/backend/internal/redact"
)

// The learning export (the owner's option A for learning data, 2026-10-31): a file of one JSON object a line, made by an
// operator on the host and nowhere else, for evaluating and training models.
//
//   - Outcomes, from every workspace: each node a canvas run ran (node_outcomes, the API's node_outcomes.go), with no
//     word of a prompt or an output: its kind, model, settings, end, attempts and usage. Every id is a keyed hash whose
//     key is made for the export and kept nowhere, so the lines of one export join each other and no id elsewhere; a
//     model of a person's own connection (byok_…) is named by such a hash too, and the lines come in an order of that
//     key, not of time. Their counts stay exact.
//   - Runs, only with --content, only where the deployment offers Help improve AwwO (AWWO_LEARNING_CONSENT=on), only
//     from active workspaces whose consent holds (workspace_learning, the API's learning.go: given by the workspace's
//     owner as it is now), and only runs admitted after it was given: their instructions, prompt, messages and output
//     with secrets and personal contact details redacted (redact, and the deployment's own secrets), and the model and
//     provider that produced them. Runs of a market Agent (its author's instructions) and media runs are left out.
//
// Every run is for evaluation only (trainable: false). Which may train other models depends on who wrote every word in
// it: a node's instructions and inputs may be the planner's (a model), its input upstream nodes' deliveries, its
// history earlier runs', and a catalog id need not name the model that answered. AwwO records none of that per run
// yet, so no run is marked trainable until it does.
//
// The export writes a new file only (it never overwrites one), readable by its owner alone, through a .partial file it
// links to its name when done, and answers its counts and its digest. It changes nothing in the database. Its consents
// are read again, holding their rows, as the file is published: a consent withdrawn, given anew or handed over while
// it ran, or its workspace suspended, makes it fail and take its file away, and one changed while it is published waits
// for it.

// consentHolds is whether workspace_learning row l's consent holds: given, by the workspace's owner as it is now (the
// API's consentHoldsSQL, learning.go). A workspace handed to another owner gives nothing on its old owner's word.
const consentHolds = `(l.consent_at IS NOT NULL AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id=l.tenant_id AND m.user_id=l.consent_by AND m.role='owner'))`

// exportable is whether workspace_learning row l's workspace gives content to this export: its consent holds and the
// workspace is active (a suspended one, whose owner cannot change the setting, gives nothing).
const exportable = consentHolds + ` AND EXISTS (SELECT 1 FROM tenants t WHERE t.id=l.tenant_id AND t.status='active')`

// ErrExportRefused is an export that cannot be made as asked, with its reason.
var ErrExportRefused = errors.New("learning export refused")

// LearningExport is what an operator asks the export for.
type LearningExport struct {
	Out     string
	Since   time.Time
	Until   time.Time
	Content bool
	// ConsentOffered is whether the deployment offers Help improve AwwO (AWWO_LEARNING_CONSENT=on): content is exported
	// only while it does.
	ConsentOffered bool
	// Secrets are the deployment's own values to redact wherever they appear (its tokens, keys and passwords).
	Secrets []string
}

// LearningExportResult is what the export wrote.
type LearningExportResult struct {
	File              string    `json:"file"`
	Since             time.Time `json:"since"`
	Until             time.Time `json:"until"`
	Outcomes          int       `json:"outcomes"`
	Runs              int       `json:"runs"`
	Consenting        int       `json:"consentingWorkspaces"`
	DeploymentSecrets int       `json:"deploymentSecrets"`
	Bytes             int64     `json:"bytes"`
	SHA256            string    `json:"sha256"`
}

// learningExportMaxRuns and learningExportMaxBytes are the most runs and bytes one export carries: a window holding
// more is refused, to be asked again narrower, never cut short.
var (
	learningExportMaxRuns        = 20000
	learningExportMaxBytes int64 = 8 << 30
)

const (
	// The longest window one export reads.
	learningExportWindow = 92 * 24 * time.Hour
	// Each text is kept to learningTextBytes, redacted over a little more of it (learningReadAhead beyond, or the
	// longest named secret's length if more) so that a secret the cut runs through is still found whole.
	learningTextBytes = 256 << 10
	learningReadAhead = 64 << 10
	// A deployment secret this long or longer is redacted wherever it appears.
	learningSecretBytes = 4
)

// Validate checks an export's request: a new file's absolute path, a window of at most learningExportWindow.
func (e LearningExport) Validate() error {
	if e.Out == "" || !filepath.IsAbs(e.Out) || e.Since.IsZero() || !e.Until.After(e.Since) || e.Until.Sub(e.Since) > learningExportWindow {
		return ErrInput
	}
	return nil
}

// personalModel is a model of a person's own connection (the API's connectionModelID), whose id names the connection.
func personalModel(model string) bool { return strings.HasPrefix(model, "byok_") }

func clipText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n]
}

// counted counts what passes through it into w, and refuses to pass more than limit.
type counted struct {
	w     io.Writer
	n     int64
	limit int64
}

func (c *counted) Write(p []byte) (int, error) {
	if c.n+int64(len(p)) > c.limit {
		return 0, fmt.Errorf("%w: the export would pass %d bytes: ask for a narrower window", ErrExportRefused, c.limit)
	}
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// queryer is the export's transaction, or the pool for a read outside it.
type queryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// consentsNow is the consents that give content to an export (exportable), each as the moment and person it holds by.
func consentsNow(ctx context.Context, q queryer) (map[string]string, error) {
	rows, err := q.Query(ctx, "SELECT l.tenant_id,l.consent_at::text||'/'||l.consent_by FROM workspace_learning l WHERE "+exportable)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var tid, given string
		if err = rows.Scan(&tid, &given); err != nil {
			return nil, err
		}
		out[tid] = given
	}
	return out, rows.Err()
}

// publishExport links the written file to its name. With content, it first reads the consents again, outside the
// export's snapshot and holding their rows (each consenting workspace, its learning settings and its owner's
// membership): one withdrawn, given anew or handed over, or its workspace suspended, while the export ran refuses it;
// one being changed now waits until the file is published. A link refuses a name that exists, as the file's own
// creation did: the export never replaces a file. The directory is synced, so the name outlasts a crash.
func (s *Store) publishExport(ctx context.Context, partial, name string, consents map[string]string, content bool) error {
	tx, err := s.beginWith(ctx, true, "30s")
	if err != nil {
		return ErrDatabase
	}
	defer tx.Rollback(ctx)
	if content {
		ids := make([]string, 0, len(consents))
		for tid := range consents {
			ids = append(ids, tid)
		}
		slices.Sort(ids)
		// The workspaces' rows first, in order, as the API takes a workspace's row before its settings: a withdrawal
		// under way waits for the export, or the export for it, never both for each other.
		if _, err := tx.Exec(ctx, "SELECT 1 FROM (SELECT id FROM tenants WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE) locked", ids); err != nil {
			return ErrDatabase
		}
		rows, err := tx.Query(ctx, `SELECT l.tenant_id,l.consent_at::text||'/'||l.consent_by FROM workspace_learning l
			JOIN tenants t ON t.id=l.tenant_id AND t.status='active'
			JOIN memberships m ON m.tenant_id=l.tenant_id AND m.user_id=l.consent_by AND m.role='owner'
			WHERE l.consent_at IS NOT NULL AND l.tenant_id=ANY($1::text[]) ORDER BY l.tenant_id FOR SHARE OF l,m`, ids)
		if err != nil {
			return ErrDatabase
		}
		now := map[string]string{}
		for rows.Next() {
			var tid, given string
			if err = rows.Scan(&tid, &given); err != nil {
				rows.Close()
				return ErrDatabase
			}
			now[tid] = given
		}
		rows.Close()
		if rows.Err() != nil {
			return ErrDatabase
		}
		for tid, given := range consents {
			if now[tid] != given {
				return fmt.Errorf("%w: a workspace's consent changed while the export ran, so its file was removed: run it again", ErrExportRefused)
			}
		}
	}
	if err = os.Link(partial, name); err != nil {
		return ErrInput
	}
	_ = os.Remove(partial)
	syncDirectory(name)
	// The file is published under consents that held while their rows were read, whatever the commit answers.
	_ = tx.Commit(ctx)
	return nil
}

// syncDirectory syncs the directory holding path, so that a name linked or removed there outlasts a crash. Where a
// directory cannot be synced (Windows), nothing is done.
func syncDirectory(path string) {
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		dir.Close()
	}
}

// learningExportCheck, when set (tests), runs once the file is written and before the consents are read again.
var learningExportCheck func()

// LearningExport writes the export (see above). Content needs an OS root operator, as any change does.
func (s *Store) LearningExport(ctx context.Context, e LearningExport, actor Actor) (LearningExportResult, error) {
	out := LearningExportResult{File: e.Out, Since: e.Since, Until: e.Until}
	if err := e.Validate(); err != nil {
		return out, err
	}
	if e.Content && actor.EffectiveUID != 0 {
		return out, ErrOperator
	}
	if e.Content && !e.ConsentOffered {
		return out, fmt.Errorf("%w: this deployment does not offer Help improve AwwO (AWWO_LEARNING_CONSENT is not on), so no content is exported", ErrExportRefused)
	}
	if _, err := os.Lstat(e.Out); !errors.Is(err, os.ErrNotExist) {
		return out, ErrInput
	}
	secrets := []string{}
	for _, secret := range e.Secrets {
		if len(secret) >= learningSecretBytes && !slices.Contains(secrets, secret) {
			secrets = append(secrets, secret)
		}
	}
	out.DeploymentSecrets = len(secrets)
	readChars := learningTextBytes + learningReadAhead
	for _, secret := range secrets {
		readChars = max(readChars, learningTextBytes+len(secret)+1)
	}
	// Each text is redacted over what was read of it, its secrets and its contact details, then cut.
	clean := func(text string) string {
		spans := append(redact.SpansAtLeast(text, secrets, learningSecretBytes), redact.PersonalSpans(text)...)
		return redact.Segment(clipText(text, learningTextBytes), 0, redact.Merge(spans))
	}
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		return out, ErrDatabase
	}
	pseudonym := func(kind, id string) string {
		mac := hmac.New(sha256.New, key[:])
		mac.Write([]byte(kind + "\x00" + id))
		return hex.EncodeToString(mac.Sum(nil))[:24]
	}
	model := func(tid, id string) string {
		if personalModel(id) {
			return "byok:" + pseudonym("model", tid+"/"+id)
		}
		return id
	}
	partial := e.Out + ".partial"
	file, err := os.OpenFile(partial, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return out, ErrInput
	}
	digest := sha256.New()
	size := &counted{w: io.MultiWriter(file, digest), limit: learningExportMaxBytes}
	w := bufio.NewWriter(size)
	encoder := json.NewEncoder(w)
	fail := func(err error) (LearningExportResult, error) {
		file.Close()
		_ = os.Remove(partial)
		if errors.Is(err, ErrInput) || errors.Is(err, ErrOperator) || errors.Is(err, ErrExportRefused) {
			return out, err
		}
		return out, ErrDatabase
	}
	tx, err := s.beginWith(ctx, false, "300s")
	if err != nil {
		return fail(err)
	}
	defer tx.Rollback(ctx)
	// The consents this export reads content under, as they stand at its start.
	consents := map[string]string{}
	if e.Content {
		if consents, err = consentsNow(ctx, tx); err != nil {
			return fail(err)
		}
		out.Consenting = len(consents)
	}
	order := hex.EncodeToString(key[16:])
	rows, err := tx.Query(ctx, `SELECT tenant_id,canvas_id,graph_id,node_id,COALESCE(run_id,''),template,output_type,runtime,model,effort,state,code,attempts,
		lessons,skills,input_tokens,output_tokens,cached_input_tokens,cache_write_tokens,reasoning_tokens,cost_microusd,credits,worker_ms,ran_at
		FROM node_outcomes WHERE ran_at>=$1 AND ran_at<$2 ORDER BY md5($3||tenant_id||'/'||graph_id||'/'||node_id)`, e.Since, e.Until, order)
	if err != nil {
		return fail(err)
	}
	for rows.Next() {
		var tid, cid, gid, nid, rid, template, outputType, runtime, modelID, effort, state, code string
		var attempts, lessons, skills int
		var in, outTokens, cached, written, reasoning, cost, credits, ms *int64
		var ranAt time.Time
		if err = rows.Scan(&tid, &cid, &gid, &nid, &rid, &template, &outputType, &runtime, &modelID, &effort, &state, &code, &attempts, &lessons, &skills,
			&in, &outTokens, &cached, &written, &reasoning, &cost, &credits, &ms, &ranAt); err != nil {
			rows.Close()
			return fail(err)
		}
		run := ""
		if rid != "" {
			run = pseudonym("run", tid+"/"+rid)
		}
		if err = encoder.Encode(map[string]any{"type": "outcome", "workspace": pseudonym("workspace", tid), "canvas": pseudonym("canvas", tid+"/"+cid),
			"graph": pseudonym("graph", tid+"/"+gid), "node": pseudonym("node", tid+"/"+cid+"/"+nid), "run": run,
			"template": template, "outputType": outputType, "runtime": runtime, "model": model(tid, modelID), "effort": effort, "state": state, "code": code,
			"attempts": attempts, "lessons": lessons, "skills": skills, "inputTokens": in, "outputTokens": outTokens, "cachedInputTokens": cached,
			"cacheWriteTokens": written, "reasoningTokens": reasoning, "costMicrousd": cost, "credits": credits, "workerMs": ms,
			"day": ranAt.UTC().Format("2006-01-02")}); err != nil {
			rows.Close()
			return fail(err)
		}
		out.Outcomes++
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return fail(err)
	}
	if e.Content {
		// A run of an exportable workspace, admitted after its consent was given and within the window, not a market
		// Agent's nor a media run: its content, read in bounded parts, with what produced it.
		const eligible = `FROM runs r JOIN workspace_learning l ON l.tenant_id=r.tenant_id AND ` + exportable + `
			WHERE r.created_at>=GREATEST(l.consent_at,$1) AND r.created_at<$2 AND r.status IN ('completed','failed') AND r.media_task IS NULL
			AND NOT (r.execution_snapshot ?| array['market','media'])`
		var eligibleRuns int
		if err = tx.QueryRow(ctx, "SELECT count(*) "+eligible, e.Since, e.Until).Scan(&eligibleRuns); err != nil {
			return fail(err)
		}
		if eligibleRuns > learningExportMaxRuns {
			return fail(fmt.Errorf("%w: the window holds %d runs, more than the %d one export carries: ask for a narrower one", ErrExportRefused, eligibleRuns, learningExportMaxRuns))
		}
		rows, err = tx.Query(ctx, `SELECT r.tenant_id,r.id,r.status,left(r.prompt,$3),left(r.output,$3),COALESCE(left(r.execution_snapshot->>'instructions',$3),''),
			COALESCE(r.execution_snapshot->>'model',''),COALESCE(r.execution_snapshot->>'effort',''),COALESCE(r.execution_snapshot->>'runtime',''),
			r.execution_snapshot ? 'team' OR r.team_snapshot IS NOT NULL,
			COALESCE((SELECT x->>'provider' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.execution_snapshot->'health'->'models')='array'
				THEN r.execution_snapshot->'health'->'models' ELSE '[]'::jsonb END) x WHERE x->>'id'=r.execution_snapshot->>'model' LIMIT 1),''),
			r.created_at,
			COALESCE((SELECT jsonb_agg(jsonb_build_object('role',m.role,'content',left(m.content,$3)) ORDER BY m.created_at,m.id) FROM messages m
				WHERE m.tenant_id=r.tenant_id AND m.session_id=r.session_id AND m.run_id=r.id),'[]'::jsonb),
			COALESCE((SELECT sum(g.rating) FROM run_ratings g WHERE g.tenant_id=r.tenant_id AND g.run_id=r.id),0)
			`+eligible+` ORDER BY r.created_at,r.id`, e.Since, e.Until, readChars)
		if err != nil {
			return fail(err)
		}
		for rows.Next() {
			var tid, rid, status, prompt, output, instructions, modelID, effort, runtime, provider string
			var team bool
			var created time.Time
			var messages []byte
			var rating int
			if err = rows.Scan(&tid, &rid, &status, &prompt, &output, &instructions, &modelID, &effort, &runtime, &team, &provider, &created, &messages, &rating); err != nil {
				rows.Close()
				return fail(err)
			}
			var said []map[string]string
			_ = json.Unmarshal(messages, &said)
			for _, m := range said {
				m["content"] = clean(m["content"])
			}
			if err = encoder.Encode(map[string]any{"type": "run", "workspace": pseudonym("workspace", tid), "run": pseudonym("run", tid+"/"+rid),
				"status": status, "model": model(tid, modelID), "provider": provider, "runtime": runtime, "effort": effort, "team": team,
				"trainable": false, "system": clean(instructions), "prompt": clean(prompt), "output": clean(output), "messages": said,
				"rating": rating, "day": created.UTC().Format("2006-01-02")}); err != nil {
				rows.Close()
				return fail(err)
			}
			out.Runs++
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			return fail(err)
		}
	}
	if err = w.Flush(); err != nil {
		return fail(err)
	}
	if err = file.Sync(); err != nil {
		return fail(err)
	}
	if err = file.Close(); err != nil {
		_ = os.Remove(partial)
		return out, ErrDatabase
	}
	if learningExportCheck != nil {
		learningExportCheck()
	}
	if err = s.publishExport(ctx, partial, e.Out, consents, e.Content); err != nil {
		_ = os.Remove(partial)
		syncDirectory(e.Out)
		return out, err
	}
	out.Bytes = size.n
	out.SHA256 = hex.EncodeToString(digest.Sum(nil))
	return out, nil
}
