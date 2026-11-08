package app

import (
	"fmt"
	"strconv"
	"strings"
)

// Why an op of a change was refused (docs/awwo-canvas-live-collaboration.md, The API): beside its code in results, each
// refused op is answered with one sentence in reasons that names what it would have changed, the rule that refused it
// and what to do instead. Only the sender of the change is told (in the change's answer); nothing else keeps them.

// reasonBit is a part of a reason taken from the change or the canvas (an id, a port, a kind, a type), cut at 80
// characters. It reads no further than that, so a string a document holds at any length costs a refusal nothing more.
func reasonBit(s string) string {
	if len(s) <= 80 {
		return s
	}
	runes := 0
	for i := range s {
		if runes == 80 {
			return s[:i] + "…"
		}
		runes++
	}
	return s
}

// canvasOpTarget names what an op would change: "node n1", "node n1's title", "field q of node f1", "wire <id>".
func canvasOpTarget(op canvasOp) string {
	p := make([]string, len(op.Path))
	for i, part := range op.Path {
		p[i] = reasonBit(part)
	}
	switch {
	case len(p) == 0:
		return "this op"
	case (p[0] == "nodes" || p[0] == "edges") && len(p) == 1:
		list := map[string]string{"nodes": "the nodes", "edges": "the wires"}[p[0]]
		if op.Op == canvasOpOrder {
			return "the order of " + list
		}
		return list
	case p[0] == "nodes" && len(p) == 2:
		return "node " + p[1]
	case p[0] == "nodes" && len(p) == 3:
		return "node " + p[1] + "'s " + p[2]
	case p[0] == "nodes" && len(p) <= 5 && (op.Path[2] == "fields" || op.Path[2] == "threads"):
		target := "field " + p[3] + " of node " + p[1]
		if op.Path[2] == "threads" {
			target = "conversation " + p[3] + " of node " + p[1]
		}
		if len(p) == 5 {
			target = "the " + p[4] + " of " + target
		}
		return target
	case p[0] == "edges" && len(p) == 2:
		return "wire " + p[1]
	case p[0] == "doc" && len(p) == 2:
		return "the canvas's " + p[1]
	}
	return strings.Join(p, "/")
}

// kindPhrase names a kind of node in a reason.
func kindPhrase(kind string) string {
	switch kind {
	case "session":
		return "a session"
	case "form":
		return "a form"
	case "assemble":
		return "an assemble node"
	case "edit":
		return "an edit node"
	case "analyze":
		return "a video breakdown node"
	case "":
		return "a node without a kind"
	}
	return "a " + reasonBit(kind) + " node"
}

// agentFieldsRule says which fields of a node an agent sets (agentNodeFields; a test keeps the two together).
const agentFieldsRule = "an agent sets a node's title, x, y, w, h, deliverablesOpen and lastOutput (its result), a session's persona, " +
	"a form's fields, an assemble node's template and fileName, and an edit node's timeline; a person chooses the rest " +
	"(runtimes, models, bindings and settings)"

// agentNewNodeRule says what a new node an agent adds may carry, by its kind (agentNodeFields; a test keeps them together).
func agentNewNodeRule(kind string) string {
	if kind == "form" {
		return "a new form carries title, fields, x, y, w, h, deliverablesOpen and lastOutput (its result) only"
	}
	return "a new session carries title, persona, x, y, w, h, deliverablesOpen and lastOutput (its result) only: a person chooses its runtime and model"
}

// nodePortNames lists a node's inputs or outputs as the port rules know them (nodePort), each whole, as a wire names
// it: at most 12, in one pass over the side asked for (a contract can hold many fields). more says whether it has others
// besides, or ones too long for any wire's id (a path part is at most 200 bytes), which are left out.
func nodePortNames(n graphNode, input bool) (names []string, more bool) {
	var candidates []string
	switch {
	case n.Kind == "form":
		candidates = []string{"data"}
	case n.Kind == "edit":
		candidates = []string{"result", "timeline", "clips", "sounds", "pictures"}
	case n.Kind == "analyze":
		candidates = []string{"result", "video"}
	case n.Contract != nil:
		fields, prefix := n.Contract.Outputs, "out:"
		if input {
			fields, prefix = n.Contract.Inputs, "in:"
		}
		seen := map[string]bool{}
		for _, f := range fields {
			port := prefix + f.ID
			switch {
			case seen[port]:
			case len(names) == 12:
				return names, true
			case len(port) > 190:
				more = true
			default:
				names = append(names, port)
			}
			seen[port] = true
		}
		return names, more
	default:
		candidates = []string{"result", "context", "reference", "audio"}
	}
	for _, port := range candidates {
		if _, ok := nodePort(n, port, input); ok {
			names = append(names, port)
		}
	}
	return names, false
}

// portReason says that a node has no such port, and which it has.
func portReason(n graphNode, port string, input bool) string {
	side, sides := "output", "outputs"
	if input {
		side, sides = "input", "inputs"
	}
	names, more := nodePortNames(n, input)
	has := fmt.Sprintf("%s has no %s", kindPhrase(n.Kind), sides)
	switch {
	case n.Contract != nil && n.Kind != "form" && n.Kind != "edit" && len(names) == 0 && !more:
		has = "its contract has no " + sides
	case len(names) == 0 && more:
		has = "read the node to see its " + sides
	case more:
		has = "its " + sides + ": " + strings.Join(names, ", ") + " and more (read the node to see them all); name one of them"
	case len(names) > 0:
		has = "its " + sides + ": " + strings.Join(names, ", ") + "; name one of them"
	}
	if port == "" {
		return fmt.Sprintf("the wire names no %s port of node %s (%s)", side, reasonBit(n.ID), has)
	}
	return fmt.Sprintf("node %s has no %s %s (%s)", reasonBit(n.ID), side, reasonBit(port), has)
}

// goneReason says that an op found nothing to act on: what it names went (in an earlier change, or earlier in its own).
func goneReason(op canvasOp, doc map[string]any) string {
	target := canvasOpTarget(op)
	p := op.Path
	if len(p) >= 2 && p[0] == "nodes" {
		if findRecord(collectionOf(doc, "nodes"), "id", p[1]) < 0 {
			if len(p) == 2 {
				return target + ": it is not on the canvas, so there is nothing to delete"
			}
			return target + ": node " + reasonBit(p[1]) + " is not on the canvas (deleted meanwhile, or never there); read the canvas again"
		}
		if len(p) >= 4 {
			what := "field"
			if p[2] == "threads" {
				what = "conversation"
			}
			return fmt.Sprintf("%s: node %s has no %s %s (any more); read the node again", target, reasonBit(p[1]), what, reasonBit(p[3]))
		}
	}
	if len(p) == 2 && p[0] == "edges" {
		return target + ": it is not on the canvas, so there is nothing to remove"
	}
	return target + ": there is nothing there to change any more; read the canvas again"
}

// runningReason says that an op would change a node AwwO is running (the fence of running nodes).
func runningReason(op canvasOp, node string) string {
	target := canvasOpTarget(op)
	if len(op.Path) > 0 && op.Path[0] == "edges" {
		return fmt.Sprintf("%s: it leads into node %s, which is in a run of AwwO (running or queued); its wires can change once the run has ended, so try again then", target, reasonBit(node))
	}
	return fmt.Sprintf("%s: node %s is in a run of AwwO (running or queued), and until the run ends only its place, size, drawer and "+
		"results may change (x, y, w, h, deliverablesOpen, lastOutput and what the run writes; the person who started the run may "+
		"change more); try again once it has ended", target, reasonBit(node))
}

// claimedReason says that an op would change a node someone else holds, naming them as the claims do.
func claimedReason(op canvasOp, node string, claims []liveClaim) string {
	holder, until := "someone else", ""
	for _, c := range claims {
		if c.NodeID != node {
			continue
		}
		name, kind := strings.TrimSpace(c.Name), "a person"
		if name == "" {
			name = "someone"
		}
		if c.HolderKind == "agent" {
			kind = "an agent"
		}
		holder, until = reasonBit(name)+" ("+kind+")", " until "+c.ExpiresAt.UTC().Format("15:04:05")+" UTC"
		break
	}
	return fmt.Sprintf("%s: %s holds node %s%s; pick another node, or ask them in a message", canvasOpTarget(op), holder, reasonBit(node), until)
}

// canvasChangeRefused says whether any op of a change was refused (its answer then carries reasons).
func canvasChangeRefused(results []string) bool {
	for _, result := range results {
		if result != "ok" {
			return true
		}
	}
	return false
}

// canvasResultReasons gives the reasons of a change answered again (sent again with its id, its first answer lost), from
// its ops and the results first given: the particular rule is not kept, so each says what its code means.
func canvasResultReasons(ops []canvasOp, results []string) []string {
	out := make([]string, len(results))
	for i, code := range results {
		if code == "ok" {
			continue
		}
		target := "op " + strconv.Itoa(i)
		if i < len(ops) {
			target = canvasOpTarget(ops[i])
		}
		why := map[string]string{
			"forbidden":    "a rule of what an agent may change refused it",
			"claimed":      "someone else held its node",
			"node_running": "AwwO was running its node",
			"gone":         "what it names was no longer on the canvas",
		}[code]
		if why == "" {
			why = "it was refused (" + reasonBit(code) + ")"
		}
		out[i] = target + ": when this change was first sent, " + why
	}
	return out
}
