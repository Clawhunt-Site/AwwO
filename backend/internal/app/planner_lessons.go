package app

import (
	"context"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Canvas RSI for the canvas planner (owner 2026-10-31). In the 14 days to 2026-10-31, 69 of 708 plans ended as
// invalid_canvas_plan: the plan gate (validatePlan) refused what the planner answered, and the reader's request was
// lost. A refused plan now records why (planner_refusals): one word of a fixed list, never the plan's text, with the
// model that planned it and its workspace. The reasons refused at least plannerHintMinimum times, in plans of at least
// plannerHintWorkspaces workspaces, in the last plannerHintWindow are named
// to every planner in its instructions, each in one sentence AwwO wrote that says what the gate takes, at most
// plannerHintLimit of them (the most frequent); so the mistakes that keep happening are the ones a planner is warned
// of, and a reason that stops happening drops out by itself. No word of a plan reaches another planner: only which of
// AwwO's own sentences are named. They are read again at most every plannerHintRefresh and listed in a fixed order, so
// a planner's instructions change only when a mistake comes or goes (its prompt cache keeps them).

const (
	plannerHintWindow     = 7 * 24 * time.Hour
	plannerHintMinimum    = 3
	plannerHintWorkspaces = 2
	plannerHintLimit      = 6
	plannerHintRefresh    = 10 * time.Minute
	plannerHintHeading    = "Mistakes that recent plans made, which the plan gate refused (each plan is lost when it is refused). Avoid every one:"
)

// planGateOperations are the operations validatePlan takes, in the protocol's order (planOperationTypes, which progress
// names, leaves out set_edge_kind and set_execution).
var planGateOperations = []string{"add_node", "update_node", "set_task", "set_model", "set_team", "set_input", "add_field", "update_field",
	"remove_field", "remove_node", "connect", "set_edge_kind", "set_execution", "disconnect"}

// planWholeReasons are the refusal reasons of a plan as a whole, in the order planGateReason checks them; an
// operation's own reasons ("operation:" and its type) follow them, in the protocol's order.
var planWholeReasons = []string{"not_json", "too_long", "shape", "summary", "too_many_operations", "operation_shape", "unknown_operation", "references"}

// plannerHints are the sentences each refusal reason is named to a planner with: what validatePlan takes, nothing more.
var plannerHints = map[string]string{
	"not_json":                "Answer with the plan's JSON object alone: nothing before or after it, no comments, no trailing commas, and every double quote inside a string escaped.",
	"too_long":                "Keep the whole answer under 120,000 characters: plan the essential changes and leave long texts for the nodes to write.",
	"shape":                   "The answer is one object with exactly the keys version (the number 1), summary and operations (a list), and no other key.",
	"summary":                 "summary is one plain, non-empty sentence of at most 1,000 characters.",
	"too_many_operations":     "A plan has at most 100 operations: make the most important changes first and leave the rest for a later plan.",
	"operation_shape":         "Each item of operations is an object with a type.",
	"unknown_operation":       "Use only the operation types the protocol lists; never invent another.",
	"references":              "Give each node a plan adds a ref of its own, used by one add_node only.",
	"operation:add_node":      "add_node takes only type, ref, templateId (one the protocol lists), title, persona, inputValues, constraints and acceptanceCriteria: a node's inputs and outputs come from add_field after it, and its model from set_model.",
	"operation:update_node":   "update_node takes only type, nodeId, title and persona, with at least one of title and persona.",
	"operation:set_task":      "set_task takes only type, nodeId, constraints and acceptanceCriteria, at least one of the two lists, each a list of at most 20 strings.",
	"operation:set_model":     "set_model takes only type, nodeId, model (named as the context lists it) and effort (one of the levels that model offers, or left out).",
	"operation:set_team":      "set_team takes only type, nodeId and template (one the context lists), or type, nodeId, mode (sequential, parallel, debate or review), maxRounds (a whole number from 1 to 8, or left out) and members: 1 to 8 (a review at least 2), each only a name and a role, neither blank, and optional instructions, the names all different.",
	"operation:set_input":     "set_input takes only type, nodeId, fieldId and value, a string.",
	"operation:add_field":     "add_field takes only type, nodeId, side (input or output) and field, whose keys are only id, label, type (one of the listed field types), required (true or false), value (always \"\"), help and placeholder.",
	"operation:update_field":  "update_field takes only type, nodeId, side, fieldId and changes, an object of at least one of label, type, required, help and placeholder.",
	"operation:remove_field":  "remove_field takes only type, nodeId, side and fieldId.",
	"operation:remove_node":   "remove_node takes only type and nodeId.",
	"operation:connect":       "connect takes only type, fromNode, fromField, toNode, toField and kind (data or feedback, or left out).",
	"operation:set_edge_kind": "set_edge_kind takes only type, edgeId and kind (data or feedback).",
	"operation:set_execution": "set_execution is {type, mode: \"workflow\"} or {type, mode: \"review\", maxRounds (a whole number from 1 to 5), reviewerNodeId, verdictFieldId}, and nothing else.",
	"operation:disconnect":    "disconnect takes only type and edgeId.",
}

// planRefusalReason names why acceptPlanFor refused a planner's answer, in a word of plannerHints and nothing of its
// text: as the gate names the first check that the plan it read last fails (planGateReason), the answer with the
// slips it repairs, written out again (repairedPlan); "" for an answer the gate takes.
func planRefusalReason(raw, newNodeModel string) string {
	plan, ok := repairedPlan(raw, newNodeModel)
	if !ok {
		return "not_json"
	}
	return planGateReason(plan)
}

// recordPlanRefusal keeps why a plan of workspace tid was refused (planRefusalReason, one of plannerHints), with the
// model that planned it, in the transaction that refuses it (sideWrite: a record that cannot be written at once is
// left out and logged, never the refusal).
func (a *App) recordPlanRefusal(ctx context.Context, tx pgx.Tx, tid, reason, model string) {
	if plannerHints[reason] == "" {
		return // nothing it could be warned of
	}
	if len(model) > 200 || !utf8.ValidString(model) {
		model = ""
	}
	if err := sideWrite(ctx, tx, "INSERT INTO planner_refusals(tenant_id,reason,model) VALUES($1,$2,$3)", tid, reason, model); err != nil {
		a.log.Warn("a refused plan's reason was not recorded", "error_type", errorType(err))
	}
}

// plannerHintCache holds the planner's mistake sentences between reads (plannerHintRefresh).
type plannerHintCache struct {
	mu   sync.Mutex
	at   time.Time
	text string
}

// plannerInstructionsNow are the planner's instructions with the mistakes recent plans made: plannerInstructions alone
// while none comes back often enough. When they cannot be read, the ones read last stay until the next read (a plan is
// never held up by its warnings).
func (a *App) plannerInstructionsNow(ctx context.Context) string {
	a.plannerHints.mu.Lock()
	defer a.plannerHints.mu.Unlock()
	if !a.plannerHints.at.IsZero() && time.Since(a.plannerHints.at) < plannerHintRefresh {
		return plannerInstructions + a.plannerHints.text
	}
	a.plannerHints.at = time.Now()
	read, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	// A mistake one workspace's plans keep making is not named to every workspace's planners: it takes plans of
	// plannerHintWorkspaces.
	rows, err := a.db.Query(read, `SELECT reason,count(*) FROM planner_refusals WHERE created_at>now()-$1::bigint*interval '1 millisecond'
		GROUP BY reason HAVING count(*)>=$2 AND count(DISTINCT tenant_id)>=$3`, plannerHintWindow.Milliseconds(), plannerHintMinimum, plannerHintWorkspaces)
	if err != nil {
		a.log.Warn("the planner's recent mistakes were not read", "error_type", errorType(err))
		return plannerInstructions + a.plannerHints.text
	}
	reasons := []plannerReason{}
	for rows.Next() {
		var s plannerReason
		if rows.Scan(&s.reason, &s.count) == nil {
			if _, known := plannerHints[s.reason]; known {
				reasons = append(reasons, s)
			}
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		a.log.Warn("the planner's recent mistakes were not read", "error_type", errorType(err))
		return plannerInstructions + a.plannerHints.text
	}
	a.plannerHints.text = plannerHintText(reasons)
	return plannerInstructions + a.plannerHints.text
}

// plannerHintRank is where a reason is listed: the plan's whole reasons first, then each operation's, in the protocol's
// order; an unknown reason last.
func plannerHintRank(reason string) int {
	if i := slices.Index(planWholeReasons, reason); i >= 0 {
		return i
	}
	if typ, ok := strings.CutPrefix(reason, "operation:"); ok {
		if i := slices.Index(planGateOperations, typ); i >= 0 {
			return len(planWholeReasons) + i
		}
	}
	return len(planWholeReasons) + len(planGateOperations)
}

// plannerReason is a refusal reason and how often it came back within plannerHintWindow.
type plannerReason struct {
	reason string
	count  int
}

// plannerHintText names the plannerHintLimit most frequent reasons (of equal counts, the earlier in plannerHintRank),
// listed in plannerHintRank's order whatever their counts; nothing at all for none.
func plannerHintText(reasons []plannerReason) string {
	list := slices.Clone(reasons)
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].count != list[j].count {
			return list[i].count > list[j].count
		}
		return plannerHintRank(list[i].reason) < plannerHintRank(list[j].reason)
	})
	if len(list) > plannerHintLimit {
		list = list[:plannerHintLimit]
	}
	if len(list) == 0 {
		return ""
	}
	sort.SliceStable(list, func(i, j int) bool { return plannerHintRank(list[i].reason) < plannerHintRank(list[j].reason) })
	var b strings.Builder
	b.WriteString("\n\n")
	b.WriteString(plannerHintHeading)
	for _, r := range list {
		b.WriteString("\n- ")
		b.WriteString(plannerHints[r.reason])
	}
	return b.String()
}
