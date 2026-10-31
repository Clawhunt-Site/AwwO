package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Canvas RSI, loop 3: lessons (owner 2026-10-31: 每次画布跑出来之后都要沉淀……沉淀出来的内容需要能够自我进化迭代原本的画布内容).
//
// When a canvas run ends (executeGraph, and the sweeper for a run whose end this process did not see), distillGraphLessons
// reads how each of its failed nodes ended and writes what that teaches as a lesson of that node (canvas_lessons, scoped
// to the canvas and the node): one per node and kind of failure, written by a rule and counted again (seen) each time the
// same failure happens. The next runs of the node are given its active lessons (freezeNodeLessons, at admission, beside
// its skills and memory, and left out of a run they would not let fit), and each settled run that was given one counts
// it (setGraphNode, finishOnce): as succeeded when it ended done, as failed when it failed the way the lesson exists to
// prevent; an end no lesson could change (an interruption, an outage) counts nothing. A lesson that failed
// lessonRetireAfter runs and helped none is retired: it is not helping. A person can retire or restore any lesson (a
// restored one starts its count of failures again). A lesson may carry a suggestion for the canvas itself
// (proposal): what to change about the node so it stops failing (its reasoning effort, its model), which the canvas
// assistant carries out when a person asks it to (the web's 接下来 card) — the server never edits a canvas.
//
// The rules only ever write fixed sentences AwwO authored, with nothing from a run's output in them: what a lesson tells
// a model is AwwO's own instruction, never text a model or a web page could have planted. Lessons are written from
// failures the node itself could avoid (its output limit, its tool steps, its time, a delivery its contract refused);
// a failure no instruction can fix (a context too large for the model, an unavailable provider) writes a lesson that is
// never given to a model and only carries its suggestion.

const (
	// maxNodeLessons and maxNodeLessonBytes bound what one run is given; maxNodeLessonCandidates what is read for it.
	maxNodeLessons          = 6
	maxNodeLessonBytes      = 3072
	maxNodeLessonCandidates = 24
	// A lesson that has failed every one of this many runs it was given, and never helped one, is retired.
	lessonRetireAfter = 3
	// A lesson keeps the last few failures it was written from as evidence (graph, run, code, time).
	maxLessonEvidence = 10
	// The sweeper writes the lessons of canvas runs that ended at least lessonSweepSettle ago and within
	// lessonSweepWindow (so the first sweep also learns from the last two weeks), lessonSweepBatch at a time.
	lessonSweepEvery  = 5 * time.Minute
	lessonSweepSettle = time.Minute
	lessonSweepWindow = 14 * 24 * time.Hour
	lessonSweepBatch  = 50
	lessonsHeading    = "Lessons from earlier runs of this node in this workspace. AwwO wrote them from how those runs ended; follow them unless this task or its inputs say otherwise:"
)

// lessonKinds are what a rule learns from, each with the sentence a model is given (empty: none is, the lesson only
// carries its suggestion) and the suggestion for the canvas.
var lessonKinds = map[string]struct{ rule, proposal string }{
	"output_limit":      {"An earlier run of this node stopped at the model's output limit before it finished. Keep this answer well inside that limit: think only as much as the task needs, deliver only what the declared outputs ask for, write it once without drafts, and do not restate the inputs.", "lower_effort"},
	"step_limit":        {"An earlier run of this node used up its tool steps before it published its deliverable. Use fewer, larger steps: write each file whole in one step, check the result once, and publish as soon as the deliverable is complete.", ""},
	"run_timeout":       {"An earlier run of this node ran out of time before it finished. Aim for the smallest deliverable that meets the task, finish it first, and leave out optional extras.", ""},
	"workspace_context": {"An earlier run of this node filled its context with tool output before it finished. Read files in bounded pages, keep command output short (send long logs to a file and read only what you need), and write each file once.", ""},
	"delivery":          {"An earlier run of this node delivered output its declared outputs refused: %s. Deliver exactly the declared output fields, each in its declared type, with nothing before or after them.", ""},
	// Nothing a model is told fixes these: they only carry their suggestion.
	"context_limit": {"", "larger_context"},
	"provider":      {"", "other_model"},
}

// lessonDescriptions are what a lesson that gives a model nothing says in its rule column, for the people who read it.
var lessonDescriptions = map[string]string{
	"context_limit": "The node's inputs and instructions were too large for its model's context window.",
	"provider":      "The node's model provider could not answer, after its automatic retries.",
}

// deliveryRefusals are the platform's refusals of a node's delivery (graphOutputFiles, fieldValue, artifactName,
// decodeArtifactContent), each with the reason a lesson keeps and the words its rule names it with: AwwO's own, never
// the refusal's text, which names a field as the canvas does (and a planner, a model, may have named it). A refusal not
// listed teaches nothing.
var deliveryRefusals = []struct {
	pattern       *regexp.Regexp
	reason, words string
}{
	{regexp.MustCompile(`^Output must be a JSON object keyed by output field IDs$`), "not_an_object", "it was not one JSON object keyed by the output field ids"},
	{regexp.MustCompile(`^Missing output .`), "missing_output", "a required output was missing"},
	{regexp.MustCompile(`^Required input/output .+ is empty$`), "empty_output", "a required output was empty"},
	{regexp.MustCompile(`^Field .+ requires a complete HTML document with html, head and body$`), "incomplete_html", "an HTML output was not a complete document with html, head and body"},
	{regexp.MustCompile(`^(Output .+ requires (number|boolean|string)|Field .+ requires (a finite number|true or false))$`), "wrong_type", "an output was not of its declared type"},
	{regexp.MustCompile(`^Output .+ (requires a string or \{name, content\}|allows only name, content and encoding|requires string name and content)$`), "file_shape", "a file output was not an object of name and content (and an optional encoding)"},
	{regexp.MustCompile(`^Output .+: File name must `), "file_name", "a file's name was empty, too long, a path or held control characters"},
	{regexp.MustCompile(`^Output .+(: text file exceeds size limit|: invalid binary file encoding or size| must be valid UTF-8 text)$`), "file_content", "a file's content was too large or not validly encoded"},
	{regexp.MustCompile(`^A node may deliver at most [0-9]+ files$`), "too_many_files", "it delivered more files than a node may"},
	{regexp.MustCompile(`^Combined file output exceeds size limit$`), "files_too_large", "its files together were larger than a node may deliver"},
}

// deliveryWords are the words a delivery lesson's rule names each reason with.
var deliveryWords = func() map[string]string {
	words := map[string]string{"contract": "it did not match the output contract"}
	for _, refusal := range deliveryRefusals {
		words[refusal.reason] = refusal.words
	}
	return words
}()

// deliveryReason is the reason deliveryRefusals keeps for a refusal's text, or "" for one it does not list.
func deliveryReason(detail string) string {
	for _, refusal := range deliveryRefusals {
		if refusal.pattern.MatchString(detail) {
			return refusal.reason
		}
	}
	return ""
}

type lessonNote struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Rule string `json:"rule"`
}

// lessonContext is what a run was given, frozen in its snapshot; settling the run counts each by its id.
type lessonContext struct {
	Items []lessonNote `json:"items"`
}

// lessonsSystemPrompt adds a run's lessons after its other guidance. A run given none is byte-identical to one made
// before lessons existed.
func lessonsSystemPrompt(instructions string, value *lessonContext) string {
	if value == nil || len(value.Items) == 0 {
		return instructions
	}
	var b strings.Builder
	b.WriteString(instructions)
	b.WriteString("\n\n")
	b.WriteString(lessonsHeading)
	for _, item := range value.Items {
		b.WriteString("\n- ")
		b.WriteString(item.Rule)
	}
	return b.String()
}

// lessonFailure is how one node of an ended canvas run failed, as distillGraphLessons reads it.
type lessonFailure struct {
	nodeID, state, detail, runStatus, runError, runID string
	attempts                                          int
	snapshot                                          []byte
}

// lessonKindOf names what a failed node's end teaches, and for a refused delivery the reason deliveryRefusals keeps, or
// "" for an end no lesson is written for: a refusal at admission (an allowance, a plan, credits), a cancellation, an
// interruption, content or parameters a provider refused, a refusal not listed, and every code not listed.
func lessonKindOf(f lessonFailure) (kind, reason string) {
	if f.state != "failed" {
		return "", ""
	}
	// A node refused at admission never ran: of its refusals, only a context too large for its model (admitGraphChild)
	// is the node's own.
	if f.runID == "" {
		if f.detail == "context_limit" {
			return "context_limit", ""
		}
		return "", ""
	}
	// A run that completed but whose delivery its node refused (graphOutputFiles). Storage failures are the platform's,
	// not the node's, and are not listed.
	if f.runStatus == "completed" {
		if reason = deliveryReason(f.detail); reason == "" {
			return "", ""
		}
		return "delivery", reason
	}
	code := f.runError
	if code == "" {
		code = f.detail
	}
	if kind = codeLessonKind(code); kind == "delivery" {
		reason = "contract"
	}
	return kind, reason
}

// codeLessonKind is the kind of lesson a failed run's code teaches, or "" for a code that teaches none.
func codeLessonKind(code string) string {
	switch code {
	case "output_limit":
		return "output_limit"
	case "workspace_step_limit":
		return "step_limit"
	case "run_timeout":
		return "run_timeout"
	case "workspace_context_limit":
		return "workspace_context"
	case "output_contract_invalid":
		return "delivery"
	case "context_limit":
		return "context_limit"
	case "provider_unavailable", "provider_rate_limited", "runtime_stream_ended":
		return "provider"
	}
	return ""
}

// givenLessonKind is the kind of failure a run given lessons ended in, as it settled (a canvas node with the code or
// the delivery refusal it was settled with, a node's own message with its run's code), where a lesson a model is given
// could have prevented it; "" for any other end (an interruption, an outage, credits, a refusal), which no lesson is
// judged by.
func givenLessonKind(state, detail string) string {
	if state != "failed" {
		return ""
	}
	kind := codeLessonKind(detail)
	if deliveryReason(detail) != "" {
		kind = "delivery"
	}
	if lessonKinds[kind].rule == "" {
		return ""
	}
	return kind
}

// lessonFingerprint is a lesson's identity within its workspace: one per node of a canvas and kind.
func lessonFingerprint(canvasID, nodeID, kind string) string {
	sum := sha256.Sum256([]byte("node\x00" + canvasID + "\x00" + nodeID + "\x00" + kind))
	return hex.EncodeToString(sum[:16])
}

// lessonRule is the sentence a lesson of kind gives a model, a refused delivery's naming its reason in deliveryWords,
// or "" for a kind that gives none (and a delivery whose reason has no words).
func lessonRule(kind, reason string) string {
	spec, ok := lessonKinds[kind]
	if !ok || spec.rule == "" {
		return ""
	}
	if strings.Contains(spec.rule, "%s") {
		words, ok := deliveryWords[reason]
		if !ok {
			return ""
		}
		return strings.Replace(spec.rule, "%s", words, 1)
	}
	return spec.rule
}

// lessonProposal is what a lesson of kind suggests for its node, from what the node ran with: a lower reasoning effort
// only where the model takes one and the node did not already run at low.
func lessonProposal(kind string, snap executionSnapshot) string {
	proposal := lessonKinds[kind].proposal
	if proposal == "lower_effort" && (snap.Effort == "low" || !snap.Health.supportsEffort(snap.Model, "low")) {
		return ""
	}
	return proposal
}

// scheduleGraphLessons writes an ended canvas run's lessons in the background; the sweeper writes any it misses.
func (a *App) scheduleGraphLessons(tid, gid string) {
	a.tasks.Add(1)
	go func() {
		defer a.tasks.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := a.distillGraphLessons(ctx, tid, gid); err != nil {
			a.log.Warn("a canvas run's lessons were not written; the sweeper tries again", "error_type", errorType(err))
		}
	}()
}

// distillGraphLessons writes the lessons canvas run gid's failed nodes teach, once: the run is marked (lessons_at) in
// the same transaction, so a second call, a sweep or a restart writes nothing more. A run that is not over, or was
// cancelled, teaches nothing and is marked only once it has ended. A collaboration teaches nothing: it ends every one
// of its nodes as one (finishCollaboration), and its turns are given no lessons.
func (a *App) distillGraphLessons(ctx context.Context, tid, gid string) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	// A new lesson's insert takes the workspace row's key share: taken first, before any lesson row, as a person's update
	// of a lesson locks the workspace row first.
	if _, err = tx.Exec(ctx, "SELECT 1 FROM tenants WHERE id=$1 FOR KEY SHARE", tid); err != nil {
		return err
	}
	var canvasID string
	var collaboration bool
	err = tx.QueryRow(ctx, `UPDATE graph_runs SET lessons_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND lessons_at IS NULL
		AND status IN ('completed','failed','interrupted') RETURNING canvas_id,collaboration IS NOT NULL`, tid, gid).Scan(&canvasID, &collaboration)
	if noRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if collaboration {
		return tx.Commit(ctx)
	}
	rows, err := tx.Query(ctx, `SELECT n.node_id,n.state,n.detail,n.attempts,n.execution_snapshot,COALESCE(r.status,''),COALESCE(r.error,''),COALESCE(r.id,'')
		FROM graph_run_nodes n LEFT JOIN runs r ON r.tenant_id=n.tenant_id AND r.id=n.run_id
		WHERE n.tenant_id=$1 AND n.graph_id=$2 AND n.state='failed' ORDER BY n.ordinal`, tid, gid)
	if err != nil {
		return err
	}
	failures := []lessonFailure{}
	for rows.Next() {
		var f lessonFailure
		if err = rows.Scan(&f.nodeID, &f.state, &f.detail, &f.attempts, &f.snapshot, &f.runStatus, &f.runError, &f.runID); err != nil {
			rows.Close()
			return err
		}
		failures = append(failures, f)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for _, f := range failures {
		kind, reason := lessonKindOf(f)
		if kind == "" {
			continue
		}
		var snap executionSnapshot
		if len(f.snapshot) > 0 {
			_ = json.Unmarshal(f.snapshot, &snap)
		}
		if snap.Media != nil || snap.Team != nil {
			// An image, video, 3D or audio node's prompt is not a model's instructions (graph_media.go), and a team's
			// members are framed by their own turns: neither is ever given a lesson.
			continue
		}
		rule := lessonRule(kind, reason)
		if rule == "" {
			if rule = lessonDescriptions[kind]; rule == "" {
				continue
			}
		}
		scope, _ := json.Marshal(map[string]string{"runtime": snapshotRuntime(snap), "model": snap.Model, "effort": snap.Effort})
		// The evidence names the run and how it ended in the platform's codes, never a word of its output or refusal.
		evidence, _ := json.Marshal([]map[string]any{{"graphId": gid, "runId": f.runID, "code": f.runError, "reason": reason, "attempts": f.attempts}})
		// A lesson a person retired stays retired, and a suggestion they dismissed or asked for stays as they left it;
		// the rule's words and the evidence follow the failure that wrote it again.
		if _, err = tx.Exec(ctx, `INSERT INTO canvas_lessons(id,tenant_id,canvas_id,node_id,kind,source,fingerprint,rule,scope,evidence,status,proposal)
			VALUES($1,$2,$3,$4,$5,'rule',$6,$7,$8,$9,'active',$10)
			ON CONFLICT (tenant_id,fingerprint) WHERE fingerprint IS NOT NULL DO UPDATE SET seen=canvas_lessons.seen+1,last_seen_at=clock_timestamp(),
			rule=EXCLUDED.rule,scope=EXCLUDED.scope,
			evidence=(SELECT COALESCE(jsonb_agg(e ORDER BY o),'[]'::jsonb) FROM (SELECT e,o FROM jsonb_array_elements(EXCLUDED.evidence||canvas_lessons.evidence) WITH ORDINALITY AS x(e,o) ORDER BY o LIMIT $11) kept),
			proposal=CASE WHEN canvas_lessons.proposal_state='open' THEN EXCLUDED.proposal ELSE canvas_lessons.proposal END,
			updated_at=clock_timestamp()`,
			randomID(), tid, canvasID, f.nodeID, kind, lessonFingerprint(canvasID, f.nodeID, kind), rule, scope, evidence, lessonProposal(kind, snap), maxLessonEvidence); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// freezeNodeLessons is what node nodeID of canvas canvasID is given at admission: its active lessons that give a model
// something, then the canvas's and the workspace's, newest first, whole lessons only within maxNodeLessons and
// maxNodeLessonBytes. A node without any freezes nothing.
func freezeNodeLessons(ctx context.Context, tx pgx.Tx, tid, canvasID, nodeID string) (*lessonContext, error) {
	if canvasID == "" || nodeID == "" {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `SELECT id,kind,rule FROM canvas_lessons WHERE tenant_id=$1 AND status='active' AND kind<>ALL($4::text[])
		AND (canvas_id IS NULL OR (canvas_id=$2 AND (node_id IS NULL OR node_id=$3)))
		ORDER BY node_id IS NOT NULL DESC,canvas_id IS NOT NULL DESC,last_seen_at DESC,id LIMIT $5`, tid, canvasID, nodeID, silentLessonKinds(), maxNodeLessonCandidates)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items, used := []lessonNote{}, len(lessonsHeading)
	for rows.Next() {
		var note lessonNote
		if err = rows.Scan(&note.ID, &note.Kind, &note.Rule); err != nil {
			return nil, err
		}
		size := len(note.Rule) + 3
		if len(items) == maxNodeLessons || used+size > maxNodeLessonBytes {
			continue
		}
		items, used = append(items, note), used+size
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	// Listed in a fixed order, not the order they were chosen in (the newest first): a node given the same lessons is
	// given the same words, whichever came back last, so its instructions stay cached.
	slices.SortFunc(items, func(a, b lessonNote) int {
		if c := strings.Compare(a.Kind, b.Kind); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	return &lessonContext{Items: items}, nil
}

// lessonCountSQL is how a settled run counts a lesson it was given, its end in state and the kind of failure it ended
// in (givenLessonKind) placeholders: a run that ended done, or failed in a way a lesson could have prevented, applied
// it; done, it succeeded; failed the way the lesson exists to prevent, the lesson failed. Any other end counts nothing
// (the statement's WHERE leaves it out). A lesson that has now failed lessonRetireAfter runs and never helped one is
// retired.
func lessonCountSQL(state, kind string) string {
	failed := state + `='failed' AND l.kind=` + kind
	retire := `l.status='active' AND ` + failed + ` AND l.succeeded=0 AND l.failed+1>=` + strconv.Itoa(lessonRetireAfter)
	return `applied=l.applied+1,succeeded=l.succeeded+CASE WHEN ` + state + `='done' THEN 1 ELSE 0 END,
	failed=l.failed+CASE WHEN ` + failed + ` THEN 1 ELSE 0 END,status=CASE WHEN ` + retire + ` THEN 'retired' ELSE l.status END,
	retired_reason=CASE WHEN ` + retire + ` THEN 'ineffective' ELSE l.retired_reason END,last_applied_at=clock_timestamp(),updated_at=clock_timestamp()`
}

// lessonCountedSQL is which ends a lesson is counted by, with lessonCountSQL's placeholders.
func lessonCountedSQL(state, kind string) string {
	return `(` + state + `='done' OR (` + state + `='failed' AND ` + kind + `<>''))`
}

// settleNodeLessonsSQL counts, for a settled canvas node (the setGraphNode statement's settled row, its new state $4,
// the kind of its failure $7), each lesson its run was given: the ones its run's own snapshot names. A node that never
// ran (refused at admission), or whose run went without its lessons because they did not fit, counts none. The node's
// settle never waits for a lesson: one another transaction holds at that moment goes uncounted (SKIP LOCKED).
var settleNodeLessonsSQL = `given AS (SELECT l.id FROM canvas_lessons l WHERE l.tenant_id=$1 AND ` + lessonCountedSQL("$4", "$7::text") + `
		AND l.id IN (SELECT item->>'id' FROM settled s JOIN runs r ON r.tenant_id=$1 AND r.id=s.run_id,
			jsonb_array_elements(CASE WHEN jsonb_typeof(r.execution_snapshot->'lessons'->'items')='array' THEN r.execution_snapshot->'lessons'->'items' ELSE '[]'::jsonb END) item)
		FOR UPDATE SKIP LOCKED),
	lessons AS (UPDATE canvas_lessons l SET ` + lessonCountSQL("$4", "$7::text") + ` FROM given WHERE l.tenant_id=$1 AND l.id=given.id)`

// runLessonIDsSQL is the ids of the lessons run $2 of workspace $1 was given, as its own snapshot names them.
const runLessonIDsSQL = `SELECT item->>'id' FROM runs r, jsonb_array_elements(CASE WHEN jsonb_typeof(r.execution_snapshot->'lessons'->'items')='array'
	THEN r.execution_snapshot->'lessons'->'items' ELSE '[]'::jsonb END) item WHERE r.tenant_id=$1 AND r.id=$2`

// countRunLessons counts, in transaction tx, the lessons run runID was given, the run (or its canvas node) having ended
// as state ('done' or 'failed') with detail: a node's own message as finishOnce ends it, a canvas node as a canvas
// run's cancellation settles it (reconcileCancelledGraph). Other canvas nodes are counted by setGraphNode
// (settleNodeLessonsSQL). It is a side write: a count that cannot be made at once is left out.
func countRunLessons(ctx context.Context, tx pgx.Tx, tid, runID, state, detail string) error {
	kind := givenLessonKind(state, detail)
	if runID == "" || (state != "done" && kind == "") {
		return nil
	}
	return sideWrite(ctx, tx, `UPDATE canvas_lessons l SET `+lessonCountSQL("$3::text", "$4::text")+` WHERE l.tenant_id=$1 AND l.id IN (`+runLessonIDsSQL+`)`,
		tid, runID, state, kind)
}

// sideWriteWait bounds how long a side write waits for a lock.
const sideWriteWait = "250ms"

// sideWrite makes an optional write (a record, a count) in transaction tx, which settles something else, under a
// savepoint that waits at most sideWriteWait for a lock: a write that cannot be made at once is rolled back to the
// savepoint and returned, and tx goes on as it was, with its own lock wait.
func sideWrite(ctx context.Context, tx pgx.Tx, statement string, args ...any) error {
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	if err = boundedExec(ctx, savepoint, statement, args...); err != nil {
		_ = savepoint.Rollback(ctx)
		return err
	}
	return savepoint.Commit(ctx)
}

// boundedExec runs statement in savepoint with the lock wait at sideWriteWait, and sets it back as it was after (a
// savepoint rolled back sets it back by itself).
func boundedExec(ctx context.Context, savepoint pgx.Tx, statement string, args ...any) error {
	var wait string
	if err := savepoint.QueryRow(ctx, "SELECT current_setting('lock_timeout')").Scan(&wait); err != nil {
		return err
	}
	if _, err := savepoint.Exec(ctx, "SELECT set_config('lock_timeout',$1,true)", sideWriteWait); err != nil {
		return err
	}
	if _, err := savepoint.Exec(ctx, statement, args...); err != nil {
		return err
	}
	_, err := savepoint.Exec(ctx, "SELECT set_config('lock_timeout',$1,true)", wait)
	return err
}

// startLessonSweeper writes, every lessonSweepEvery, the lessons of canvas runs that ended without them being written
// (this process stopped first, or a write failed): those that ended within lessonSweepWindow, oldest first.
func (a *App) startLessonSweeper(watch context.Context) {
	a.tasks.Add(1)
	go func() {
		defer a.tasks.Done()
		tick := time.NewTicker(lessonSweepEvery)
		defer tick.Stop()
		for {
			if e := a.sweepGraphLessons(watch); e != nil && watch.Err() == nil {
				a.log.Warn("ended canvas runs' lessons could not be written", "error_type", errorType(e))
			}
			select {
			case <-watch.Done():
				return
			case <-tick.C:
			}
		}
	}()
}

func (a *App) sweepGraphLessons(ctx context.Context) error {
	rows, err := a.db.Query(ctx, `SELECT tenant_id,id FROM graph_runs WHERE lessons_at IS NULL AND status IN ('completed','failed','interrupted')
		AND updated_at<now()-$1::bigint*interval '1 millisecond' AND updated_at>now()-$2::bigint*interval '1 millisecond' ORDER BY updated_at LIMIT $3`,
		lessonSweepSettle.Milliseconds(), lessonSweepWindow.Milliseconds(), lessonSweepBatch)
	if err != nil {
		return err
	}
	type pair struct{ tid, id string }
	due := []pair{}
	for rows.Next() {
		var p pair
		if err = rows.Scan(&p.tid, &p.id); err != nil {
			rows.Close()
			return err
		}
		due = append(due, p)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for _, p := range due {
		if ctx.Err() != nil {
			return nil
		}
		if err = a.distillGraphLessons(ctx, p.tid, p.id); err != nil {
			return err
		}
	}
	return nil
}

// lessonJSON is a lesson as the canvas's RSI view and its updates return it.
const lessonJSON = `jsonb_build_object('id',l.id,'canvasId',l.canvas_id,'nodeId',l.node_id,'kind',l.kind,'source',l.source,'rule',l.rule,
	'given',l.kind<>ALL($9::text[]),'status',l.status,'retiredReason',l.retired_reason,'seen',l.seen,'applied',l.applied,'succeeded',l.succeeded,
	'failed',l.failed,'proposal',l.proposal,'proposalState',l.proposal_state,'evidence',l.evidence,'lastSeenAt',l.last_seen_at,
	'lastAppliedAt',l.last_applied_at,'createdAt',l.created_at,'updatedAt',l.updated_at)`

// silentLessonKinds are the kinds whose lessons give a model nothing, as SQL reads them ($9 of lessonJSON).
func silentLessonKinds() []string {
	kinds := []string{}
	for kind, spec := range lessonKinds {
		if spec.rule == "" {
			kinds = append(kinds, kind)
		}
	}
	return kinds
}

// canvasLessons is a canvas's RSI view: its lessons, and its last canvas runs counted the way the lessons are judged
// (how many nodes ran, finished on their first attempt, needed a retry, failed, and were given lessons).
func (a *App) canvasLessons(w http.ResponseWriter, r *http.Request) {
	tid, cid := r.PathValue("tenantId"), r.PathValue("canvasId")
	var exists bool
	if e := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM canvases WHERE tenant_id=$1 AND id=$2)", tid, cid).Scan(&exists); e != nil {
		a.dbError(w, e)
		return
	}
	if !exists {
		fail(w, 404, "not_found", "Canvas not found")
		return
	}
	// Each lesson names its node as the canvas titles it now ("" for a node no longer on the canvas): the canvas's
	// titles are read once, not once a lesson (a film's canvas is a megabyte).
	lessons, e := rowsJSON(r.Context(), a.db, `WITH titles AS MATERIALIZED (SELECT DISTINCT ON (n->>'id') n->>'id' AS id,n->>'title' AS title
		FROM canvases c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.document->'nodes')='array' THEN c.document->'nodes' ELSE '[]'::jsonb END) n
		WHERE c.tenant_id=$1 AND c.id=$2 AND jsonb_typeof(n)='object')
		SELECT `+strings.ReplaceAll(lessonJSON, "$9", "$3")+`||jsonb_build_object('nodeTitle',COALESCE(t.title,'')) FROM canvas_lessons l
		LEFT JOIN titles t ON t.id=l.node_id
		WHERE l.tenant_id=$1 AND l.canvas_id=$2 ORDER BY l.status='active' DESC,l.last_seen_at DESC,l.id LIMIT 200`, tid, cid, silentLessonKinds())
	if e != nil {
		a.dbError(w, e)
		return
	}
	runs, e := rowsJSON(r.Context(), a.db, `SELECT jsonb_build_object('id',g.id,'status',g.status,'createdAt',g.created_at,'endedAt',g.updated_at,
		'ran',count(*) FILTER (WHERE n.state IN ('done','failed') AND n.run_id IS NOT NULL),
		'firstPass',count(*) FILTER (WHERE n.state='done' AND n.run_id IS NOT NULL AND n.attempts=0),
		'retried',count(*) FILTER (WHERE n.attempts>0),
		'failed',count(*) FILTER (WHERE n.state='failed'),
		'givenLessons',count(*) FILTER (WHERE jsonb_typeof(r.execution_snapshot->'lessons'->'items')='array' AND jsonb_array_length(r.execution_snapshot->'lessons'->'items')>0))
		FROM (SELECT id,status,created_at,updated_at FROM graph_runs WHERE tenant_id=$1 AND canvas_id=$2 ORDER BY created_at DESC LIMIT 20) g
		LEFT JOIN graph_run_nodes n ON n.tenant_id=$1 AND n.graph_id=g.id
		-- A node was given lessons when its run was (its own snapshot names them): not one refused at admission, nor a
		-- run its lessons were left out of.
		LEFT JOIN runs r ON r.tenant_id=n.tenant_id AND r.id=n.run_id
		GROUP BY g.id,g.status,g.created_at,g.updated_at ORDER BY g.created_at`, tid, cid)
	if e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"lessons": lessons, "runs": runs})
}

// updateCanvasLesson is a person's word on a lesson: retire it (it is no longer given to the node) or restore it, and
// a suggestion asked for, dismissed or open again.
func (a *App) updateCanvasLesson(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Status        *string `json:"status"`
		ProposalState *string `json:"proposalState"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if (b.Status == nil && b.ProposalState == nil) || (b.Status != nil && *b.Status != "active" && *b.Status != "retired") ||
		(b.ProposalState != nil && *b.ProposalState != "open" && *b.ProposalState != "asked" && *b.ProposalState != "dismissed") {
		fail(w, 400, "invalid_input", "A lesson is active or retired, and its suggestion open, asked or dismissed")
		return
	}
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	// The person's role as it stands now, after their request's body came in, not as the request began.
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	// A lesson a person restores after it retired itself starts its count of failures again (it gets lessonRetireAfter
	// more chances): only the runs it helped finish stay counted. One a person retired keeps its counts.
	v, e := oneJSON(r.Context(), tx, `UPDATE canvas_lessons AS l SET status=COALESCE($3,l.status),
		retired_reason=CASE WHEN $3::text IS NULL THEN l.retired_reason WHEN $3='retired' THEN 'person' ELSE '' END,
		failed=CASE WHEN $3='active' AND l.status='retired' AND l.retired_reason='ineffective' THEN 0 ELSE l.failed END,
		applied=CASE WHEN $3='active' AND l.status='retired' AND l.retired_reason='ineffective' THEN l.succeeded ELSE l.applied END,
		proposal_state=COALESCE($4,l.proposal_state),updated_at=clock_timestamp() WHERE l.tenant_id=$1 AND l.id=$2 RETURNING `+strings.ReplaceAll(lessonJSON, "$9", "$5"),
		tid, id, b.Status, b.ProposalState, silentLessonKinds())
	if noRows(e) {
		fail(w, 404, "not_found", "Lesson not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, tid, "canvas_lesson.updated", id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, v)
}

// runRating is the thumbs the signed-in person gave a run's result (0 for none), for the result's view to show.
func (a *App) runRating(w http.ResponseWriter, r *http.Request) {
	tid, id, user := r.PathValue("tenantId"), r.PathValue("id"), currentUser(r).ID
	var rating int
	err := a.db.QueryRow(r.Context(), `SELECT COALESCE((SELECT g.rating FROM run_ratings g WHERE g.tenant_id=r.tenant_id AND g.run_id=r.id AND g.user_id=$3),0)
		FROM runs r WHERE r.tenant_id=$1 AND r.id=$2`, tid, id, user).Scan(&rating)
	if noRows(err) {
		fail(w, 404, "not_found", "Run not found")
		return
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"runId": id, "rating": rating})
}

// rateRun keeps a person's thumbs for a run's result in this workspace (1 up, -1 down, 0 takes it back): what the RSI
// view and, later, the lessons a model writes learn from.
func (a *App) rateRun(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Rating *int `json:"rating"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	if b.Rating == nil || (*b.Rating != 1 && *b.Rating != -1 && *b.Rating != 0) {
		fail(w, 400, "invalid_input", "A rating is 1, -1, or 0 to take it back")
		return
	}
	tid, id, user := r.PathValue("tenantId"), r.PathValue("id"), currentUser(r).ID
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	// The person's role as it stands now, after their request's body came in, not as the request began.
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	var status string
	if e = tx.QueryRow(r.Context(), "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2 FOR KEY SHARE", tid, id).Scan(&status); noRows(e) {
		fail(w, 404, "not_found", "Run not found")
		return
	} else if e != nil {
		a.dbError(w, e)
		return
	}
	if status != "completed" {
		fail(w, 409, "run_not_rateable", "Only a completed run's result can be rated")
		return
	}
	if *b.Rating == 0 {
		_, e = tx.Exec(r.Context(), "DELETE FROM run_ratings WHERE tenant_id=$1 AND run_id=$2 AND user_id=$3", tid, id, user)
	} else {
		_, e = tx.Exec(r.Context(), `INSERT INTO run_ratings(tenant_id,run_id,user_id,rating) VALUES($1,$2,$3,$4)
			ON CONFLICT (tenant_id,run_id,user_id) DO UPDATE SET rating=EXCLUDED.rating,updated_at=clock_timestamp()`, tid, id, user, *b.Rating)
	}
	if e == nil {
		e = tx.Commit(r.Context())
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"runId": id, "rating": *b.Rating})
}
