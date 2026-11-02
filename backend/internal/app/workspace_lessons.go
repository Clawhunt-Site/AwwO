package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
)

// Canvas RSI, the workspace's lessons (the 2026-10-31 plan's 1.2: 技能库 — what proved itself on one node, for every node
// like it). A node's lesson that helped its node's runs (lessonPromoteAfter of them, and failed at most
// lessonPromoteFailures) can be made the whole workspace's by a person, from the 经验 panel: one lesson of the workspace
// (no canvas, no node) for every node of the same template, in AwwO's sentence for nodes like it (workspaceLessonKinds)
// — never the node's words, nor anything a model wrote. Nodes of that template are given it at admission after their
// own lessons (freezeNodeLessons; a node given its own lesson of the kind is not given the workspace's too), and each
// run counts it as it counts any lesson: one that never helps retires itself, and a person can retire or restore it.

const (
	// A node's lesson goes to the workspace once it helped this many runs and failed at most lessonPromoteFailures.
	lessonPromoteAfter    = 3
	lessonPromoteFailures = 1
)

// workspaceLessonKinds are the sentences the workspace's lessons give a model, by kind, as lessonKinds' for one node.
var workspaceLessonKinds = map[string]string{
	"output_limit":      "Earlier runs of nodes like this one in this workspace stopped at the model's output limit before they finished. Keep this answer well inside that limit: think only as much as the task needs, deliver only what the declared outputs ask for, write it once without drafts, and do not restate the inputs.",
	"step_limit":        "Earlier runs of nodes like this one in this workspace used up their tool steps before they published their deliverable. Use fewer, larger steps: write each file whole in one step, check the result once, and publish as soon as the deliverable is complete.",
	"run_timeout":       "Earlier runs of nodes like this one in this workspace ran out of time before they finished. Aim for the smallest deliverable that meets the task, finish it first, and leave out optional extras.",
	"workspace_context": "Earlier runs of nodes like this one in this workspace filled their context with tool output before they finished. Read files in bounded pages, keep command output short (send long logs to a file and read only what you need), and write each file once.",
	"delivery":          "Earlier runs of nodes like this one in this workspace delivered output their declared outputs refused: %s. Deliver exactly the declared output fields, each in its declared type, with nothing before or after them.",
}

// workspaceLessonRule is the sentence a workspace lesson of kind gives a model, a refused delivery's naming its reason,
// or "" for a kind (or a delivery reason) that has none.
func workspaceLessonRule(kind, reason string) string {
	rule := workspaceLessonKinds[kind]
	if !strings.Contains(rule, "%s") {
		return rule
	}
	words, ok := deliveryWords[reason]
	if !ok {
		return ""
	}
	return strings.Replace(rule, "%s", words, 1)
}

// workspaceLessonFingerprint names the one workspace lesson of a template, kind and (for a delivery) reason.
func workspaceLessonFingerprint(template, kind, reason string) string {
	sum := sha256.Sum256([]byte("workspace\x00" + template + "\x00" + kind + "\x00" + reason))
	return hex.EncodeToString(sum[:16])
}

// savedNodeTemplate is the template of node nodeID in a canvas document, "" for a node without one or not there.
func savedNodeTemplate(raw []byte, nodeID string) string {
	var document struct {
		Nodes []struct {
			ID         string `json:"id"`
			TemplateID string `json:"templateId"`
		} `json:"nodes"`
	}
	if nodeID == "" || json.Unmarshal(raw, &document) != nil {
		return ""
	}
	for _, node := range document.Nodes {
		if node.ID == nodeID {
			return node.TemplateID
		}
	}
	return ""
}

// lessonReason is the reason a delivery lesson was written for, as its newest evidence names it.
func lessonReason(evidence []byte) string {
	var items []struct {
		Reason string `json:"reason"`
	}
	if json.Unmarshal(evidence, &items) != nil || len(items) == 0 {
		return ""
	}
	return items[0].Reason
}

// promoteCanvasLesson makes a node's lesson that proved itself the workspace's, for every node of its node's template
// (the 经验 panel's 推广到工作区). The workspace's lesson is written once per template, kind and reason; promoting another
// node's lesson of the same adds that node to its evidence. One a person retired stays retired: it is returned as it is,
// for them to restore.
func (a *App) promoteCanvasLesson(w http.ResponseWriter, r *http.Request) {
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.dbError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	// The person's role as it stands now (the workspace row is locked first, as every lesson write locks it first).
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	var canvasID, nodeID, kind, status string
	var succeeded, failed int
	var evidence, document []byte
	e = tx.QueryRow(r.Context(), `SELECT l.canvas_id,l.node_id,l.kind,l.status,l.succeeded,l.failed,l.evidence,c.document FROM canvas_lessons l
		JOIN canvases c ON c.tenant_id=l.tenant_id AND c.id=l.canvas_id WHERE l.tenant_id=$1 AND l.id=$2 AND l.node_id IS NOT NULL FOR SHARE OF l`, tid, id).
		Scan(&canvasID, &nodeID, &kind, &status, &succeeded, &failed, &evidence, &document)
	if noRows(e) {
		fail(w, 404, "not_found", "Lesson not found")
		return
	}
	if e != nil {
		a.dbError(w, e)
		return
	}
	template, reason := savedNodeTemplate(document, nodeID), lessonReason(evidence)
	rule := workspaceLessonRule(kind, reason)
	if status != "active" || rule == "" || succeeded < lessonPromoteAfter || failed > lessonPromoteFailures || !slices.Contains(planAgentTemplateIDs, template) {
		fail(w, 409, "lesson_not_promotable", "Only an active lesson its node was given, which helped at least 3 of its runs and failed at most 1, of a node still on its canvas with a template, can go to the whole workspace")
		return
	}
	scope, _ := json.Marshal(map[string]string{"templateId": template})
	cited, _ := json.Marshal([]map[string]string{{"lessonId": id, "canvasId": canvasID}})
	v, e := oneJSON(r.Context(), tx, `INSERT INTO canvas_lessons AS l(id,tenant_id,kind,source,fingerprint,rule,scope,evidence,status)
		VALUES($1,$2,$3,'person',$4,$5,$6,$7,'active')
		ON CONFLICT (tenant_id,fingerprint) WHERE fingerprint IS NOT NULL DO UPDATE SET
			evidence=CASE WHEN l.evidence @> EXCLUDED.evidence THEN l.evidence ELSE (SELECT COALESCE(jsonb_agg(e ORDER BY o),'[]'::jsonb) FROM
				(SELECT e,o FROM jsonb_array_elements(EXCLUDED.evidence||l.evidence) WITH ORDINALITY AS x(e,o) ORDER BY o LIMIT $8) kept) END,
			updated_at=clock_timestamp()
		RETURNING `+lessonJSON, randomID(), tid, kind, workspaceLessonFingerprint(template, kind, reason), rule, scope, cited,
		maxLessonEvidence, silentLessonKinds())
	if e != nil {
		a.dbError(w, e)
		return
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, tid, "canvas_lesson.promoted", id); e != nil {
		a.dbError(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.dbError(w, e)
		return
	}
	writeJSON(w, 200, v)
}
