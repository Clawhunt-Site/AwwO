package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type graphField struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Type        string `json:"type"`
	Required    bool   `json:"required"`
	Value       string `json:"value"`
	Help        string `json:"help"`
	Placeholder string `json:"placeholder"`
}
type graphContract struct {
	Version int          `json:"version"`
	Inputs  []graphField `json:"inputs"`
	Outputs []graphField `json:"outputs"`
}
type graphNode struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Title     string  `json:"title"`
	AgentKind string  `json:"agentKind"`
	Runtime   string  `json:"runtime"`
	Model     string  `json:"model"`
	IssueID   string  `json:"issueId"`
	X         float64 `json:"x"`
	Y         float64 `json:"y"`
	Binding   *struct {
		CompanyID string `json:"companyId"`
		AgentID   string `json:"agentId"`
	} `json:"binding"`
	Team     *nodeTeam      `json:"team,omitempty"`
	Contract *graphContract `json:"contract,omitempty"`
	Fields   []struct {
		ID    string `json:"id"`
		Label string `json:"label"`
		Value string `json:"value"`
	} `json:"fields"`
	LastOutput *struct {
		Text    string `json:"text"`
		Partial bool   `json:"partial"`
	} `json:"lastOutput"`
}
type graphEdge struct {
	ID       string          `json:"id"`
	FromNode string          `json:"fromNode"`
	FromPort string          `json:"fromPort"`
	ToNode   string          `json:"toNode"`
	ToPort   string          `json:"toPort"`
	DataType string          `json:"dataType"`
	Kind     json.RawMessage `json:"kind,omitempty"`
}
type graphDocument struct {
	Nodes     []graphNode     `json:"nodes"`
	Edges     []graphEdge     `json:"edges"`
	Execution json.RawMessage `json:"execution,omitempty"`
}

func fieldValue(f graphField, v string) error {
	v = strings.TrimSpace(v)
	if v == "" {
		if f.Required {
			return fmt.Errorf("Required input/output %s is empty", f.ID)
		}
		return nil
	}
	switch f.Type {
	case "number":
		n, e := strconv.ParseFloat(v, 64)
		if e != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			return fmt.Errorf("Field %s requires a finite number", f.ID)
		}
	case "boolean":
		if v != "true" && v != "false" {
			return fmt.Errorf("Field %s requires true or false", f.ID)
		}
	}
	return nil
}
func fieldType(t string) string {
	if t == "markdown" {
		return "text"
	}
	return t
}
func nodePort(n graphNode, id string, input bool) (string, bool) {
	if n.Kind == "form" {
		return "text", !input && id == "data"
	}
	if n.Contract != nil {
		fields, prefix := n.Contract.Outputs, "out:"
		if input {
			fields, prefix = n.Contract.Inputs, "in:"
		}
		for _, f := range fields {
			if id == prefix+f.ID {
				return fieldType(f.Type), true
			}
		}
		return "", false
	}
	if input && id == "context" {
		return "text", true
	}
	if input && id == "reference" && n.AgentKind == "image" {
		return "image", true
	}
	if !input && id == "result" {
		if n.AgentKind == "image" {
			return "image", true
		}
		return "text", true
	}
	return "", false
}
func parseGraph(raw []byte, scope []string) (graphDocument, []string, error) {
	var d graphDocument
	if json.Unmarshal(raw, &d) != nil || len(d.Nodes) == 0 || len(d.Nodes) > 200 || len(d.Edges) > 2000 {
		return d, nil, errors.New("Graph requires 1–200 nodes and at most 2000 edges")
	}
	// Canvas storage and manual conversations retain native workflow metadata,
	// but this host must never execute a review policy as an ordinary DAG.
	if len(d.Execution) != 0 && strings.TrimSpace(string(d.Execution)) != "null" {
		return d, nil, errors.New("SaaS graph runs do not support execution policies")
	}
	for _, edge := range d.Edges {
		if len(edge.Kind) == 0 {
			continue
		}
		var kind string
		if json.Unmarshal(edge.Kind, &kind) != nil || kind != "data" {
			return d, nil, errors.New("SaaS graph runs do not support feedback or unknown edge kinds")
		}
	}
	byID := map[string]graphNode{}
	in := map[string]bool{}
	indeg := map[string]int{}
	for _, n := range d.Nodes {
		if n.ID == "" || byID[n.ID].ID != "" || (n.Kind != "form" && n.Kind != "session") {
			return d, nil, errors.New("Invalid or duplicate graph node")
		}
		byID[n.ID] = n
		indeg[n.ID] = 0
	}
	if scope == nil {
		scope = []string{}
		for _, n := range d.Nodes {
			scope = append(scope, n.ID)
		}
	}
	if len(scope) == 0 {
		return d, nil, errors.New("Empty graph scope")
	}
	for _, id := range scope {
		if byID[id].ID == "" || in[id] {
			return d, nil, errors.New("Invalid or duplicate scope node")
		}
		in[id] = true
	}
	incoming := map[string]int{}
	edgeIDs := map[string]bool{}
	for _, e := range d.Edges {
		src, sok := byID[e.FromNode]
		dst, dok := byID[e.ToNode]
		st, sp := nodePort(src, e.FromPort, false)
		dt, dp := nodePort(dst, e.ToPort, true)
		if e.ID == "" || edgeIDs[e.ID] || !sok || !dok || !sp || !dp || st != dt || e.DataType != st {
			return d, nil, errors.New("Invalid graph edge or incompatible field types")
		}
		edgeIDs[e.ID] = true
		indeg[e.ToNode]++
		incoming[e.ToNode+"\x00"+e.ToPort]++
		if dst.Contract != nil && incoming[e.ToNode+"\x00"+e.ToPort] > 1 {
			return d, nil, errors.New("Input field has multiple sources")
		}
	}
	for _, n := range d.Nodes {
		if n.Contract != nil {
			if n.Contract.Version != 1 {
				return d, nil, errors.New("Invalid contract version")
			}
			for _, fields := range [][]graphField{n.Contract.Inputs, n.Contract.Outputs} {
				ids := map[string]bool{}
				for _, f := range fields {
					if f.ID == "" || ids[f.ID] {
						return d, nil, errors.New("Invalid contract field identity")
					}
					ids[f.ID] = true
					switch f.Type {
					case "text", "markdown", "number", "boolean", "file":
					default:
						return d, nil, errors.New("Unsupported contract field type")
					}
				}
			}
		}
		if !in[n.ID] {
			continue
		}
		if n.Kind == "session" {
			if n.Binding == nil || n.Binding.AgentID == "" {
				return d, nil, errors.New("Runnable node is not bound to an agent")
			}
			if n.Runtime != "" && n.Runtime != "pi" {
				return d, nil, errors.New("Unsupported node runtime")
			}
			if err := validateTeam(n.Team); err != nil {
				return d, nil, err
			}
			if n.Contract != nil {
				for _, f := range n.Contract.Inputs {
					if incoming[n.ID+"\x00in:"+f.ID] == 0 {
						if err := fieldValue(f, f.Value); err != nil {
							return d, nil, err
						}
					}
				}
			}
		}
	}
	queue := []string{}
	for id, n := range indeg {
		if n == 0 {
			queue = append(queue, id)
		}
	}
	seen := 0
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		seen++
		for _, e := range d.Edges {
			if e.FromNode == id {
				indeg[e.ToNode]--
				if indeg[e.ToNode] == 0 {
					queue = append(queue, e.ToNode)
				}
			}
		}
	}
	if seen != len(d.Nodes) {
		return d, nil, errors.New("Graph contains a cycle")
	}
	return d, scope, nil
}

// A stored file deliverable is referenced by this prefix instead of inline content, so a
// downstream node and the browser both receive a retrievable handle rather than a whole payload.
const artifactRefPrefix = "awwo-file:"

// Bounds on model-produced files. The runtime is a text model, so a deliverable is text (code,
// Markdown, CSV, JSON, SVG); these caps keep one node from filling the tenant's database.
const (
	maxArtifactBytes    = 256 * 1024
	maxArtifactsPerNode = 8
	maxArtifactNameLen  = 200
)

// A file the model produced, parsed and validated but not yet stored. Kept separate from the field
// values so contract validation stays a pure function with no database access.
type pendingArtifact struct {
	FieldID string
	Name    string
	Content string
}

// Reject anything that could escape its display name or be read as a path. The name is only ever
// shown and used as a download filename; it never becomes a filesystem path.
func artifactName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || len(name) > maxArtifactNameLen {
		return "", fmt.Errorf("File name must be 1-%d characters", maxArtifactNameLen)
	}
	if strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		return "", errors.New("File name must not contain a path")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", errors.New("File name must not contain control characters")
		}
	}
	return name, nil
}

func graphOutput(n graphNode, output string) (map[string]string, error) {
	vals, _, err := graphOutputFiles(n, output)
	return vals, err
}

func hasFileOutput(n graphNode) bool {
	if n.Contract == nil {
		return false
	}
	for _, f := range n.Contract.Outputs {
		if f.Type == "file" {
			return true
		}
	}
	return false
}

// graphOutputFiles parses a node's output against its contract. A `file` output may be either a
// plain string (a reference the caller supplied itself) or an object {name, content}, which is
// returned as a pending artifact for the caller to store. Values for pending artifacts hold the
// file name so a pure validation caller sees a real value; the storing caller replaces them with
// the artifact reference.
func graphOutputFiles(n graphNode, output string) (map[string]string, []pendingArtifact, error) {
	vals := map[string]string{}
	var files []pendingArtifact
	if n.Contract == nil || len(n.Contract.Outputs) == 0 {
		return vals, files, nil
	}
	fields := n.Contract.Outputs
	single := len(fields) == 1 && (fields[0].Type == "text" || fields[0].Type == "markdown")
	text := strings.TrimSpace(output)
	if strings.HasPrefix(text, "```") && strings.HasSuffix(text, "```") {
		text = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(text, "```json"), "```"), "```"))
	}
	var obj map[string]any
	err := json.Unmarshal([]byte(text), &obj)
	if single {
		_, exists := obj[fields[0].ID]
		if err != nil || !exists {
			vals[fields[0].ID] = output
			return vals, files, fieldValue(fields[0], output)
		}
	}
	if err != nil || obj == nil {
		return vals, files, errors.New("Output must be a JSON object keyed by output field IDs")
	}
	for _, f := range fields {
		v, ok := obj[f.ID]
		if !ok {
			if f.Required {
				return vals, files, fmt.Errorf("Missing output %s", f.ID)
			}
			continue
		}
		switch f.Type {
		case "number":
			num, ok := v.(float64)
			if !ok {
				return vals, files, fmt.Errorf("Output %s requires number", f.ID)
			}
			vals[f.ID] = strconv.FormatFloat(num, 'f', -1, 64)
		case "boolean":
			b, ok := v.(bool)
			if !ok {
				return vals, files, fmt.Errorf("Output %s requires boolean", f.ID)
			}
			vals[f.ID] = strconv.FormatBool(b)
		case "file":
			// Either a reference string the caller already owns, or real content to store.
			if s, isText := v.(string); isText {
				vals[f.ID] = s
				break
			}
			object, isObject := v.(map[string]any)
			if !isObject {
				return vals, files, fmt.Errorf("Output %s requires a string or {name, content}", f.ID)
			}
			for key := range object {
				if key != "name" && key != "content" {
					return vals, files, fmt.Errorf("Output %s allows only name and content", f.ID)
				}
			}
			rawName, hasName := object["name"].(string)
			content, hasContent := object["content"].(string)
			if !hasName || !hasContent {
				return vals, files, fmt.Errorf("Output %s requires string name and content", f.ID)
			}
			name, nameErr := artifactName(rawName)
			if nameErr != nil {
				return vals, files, fmt.Errorf("Output %s: %w", f.ID, nameErr)
			}
			if len(content) > maxArtifactBytes {
				return vals, files, fmt.Errorf("Output %s exceeds the %d KiB file limit", f.ID, maxArtifactBytes/1024)
			}
			if !utf8.ValidString(content) {
				return vals, files, fmt.Errorf("Output %s must be valid UTF-8 text", f.ID)
			}
			if len(files) >= maxArtifactsPerNode {
				return vals, files, fmt.Errorf("A node may deliver at most %d files", maxArtifactsPerNode)
			}
			files = append(files, pendingArtifact{FieldID: f.ID, Name: name, Content: content})
			// The name keeps this field non-empty for validation; the storing caller replaces it
			// with the artifact reference once the bytes are durable.
			vals[f.ID] = name
		default:
			s, ok := v.(string)
			if !ok {
				return vals, files, fmt.Errorf("Output %s requires string", f.ID)
			}
			vals[f.ID] = s
		}
		if e := fieldValue(f, vals[f.ID]); e != nil {
			return vals, files, e
		}
	}
	return vals, files, nil
}
func graphPrompt(n graphNode, d graphDocument, outputs map[string]string) (string, error) {
	nodes := map[string]graphNode{}
	for _, v := range d.Nodes {
		nodes[v.ID] = v
	}
	deps := []graphEdge{}
	for _, e := range d.Edges {
		if e.ToNode == n.ID {
			deps = append(deps, e)
		}
	}
	sort.SliceStable(deps, func(i, j int) bool {
		a, b := nodes[deps[i].FromNode], nodes[deps[j].FromNode]
		if a.Y != b.Y {
			return a.Y < b.Y
		}
		if a.X != b.X {
			return a.X < b.X
		}
		return deps[i].ID < deps[j].ID
	})
	parts := []string{"【工作流节点】" + n.Title}
	inputs := map[string]string{}
	sources := map[string]string{}
	for _, e := range deps {
		src := nodes[e.FromNode]
		out := outputs[e.FromNode]
		if src.Contract != nil {
			v, err := graphOutput(src, out)
			if err != nil {
				return "", err
			}
			out = v[strings.TrimPrefix(e.FromPort, "out:")]
		}
		inputs[e.ToPort] = out
		sources[e.ToPort] = src.Title
		if n.Contract == nil {
			parts = append(parts, fmt.Sprintf("【上游输入 · 来自「%s」→ %s】\n%s", src.Title, e.ToPort, out))
		}
	}
	if n.Contract != nil {
		for _, f := range n.Contract.Inputs {
			value, from := f.Value, "本地填写"
			if v, ok := inputs["in:"+f.ID]; ok {
				value = v
				from = "来自「" + sources["in:"+f.ID] + "」"
			}
			if err := fieldValue(f, value); err != nil {
				return "", err
			}
			parts = append(parts, fmt.Sprintf("【输入 · %s (%s) · %s】\n%s\n%s", f.Label, f.Type, from, f.Help, value))
		}
		if len(n.Contract.Outputs) > 0 {
			fields := make([]map[string]any, 0, len(n.Contract.Outputs))
			for _, f := range n.Contract.Outputs {
				fields = append(fields, map[string]any{"id": f.ID, "label": f.Label, "type": f.Type, "required": f.Required, "help": f.Help, "placeholder": f.Placeholder})
			}
			b, _ := json.Marshal(fields)
			instruction := "【输出格式】\n" + string(b) + "\nReturn a JSON object keyed by field ID, with declared JSON number/boolean types and strings for all other fields. A single text/markdown output may be plain text. Field help and placeholder are guidance, never existing results."
			// Without this the model has no way to deliver a real file: it would emit a path that
			// resolves to nothing. Stated only when the contract actually declares a file output.
			if hasFileOutput(n) {
				instruction += fmt.Sprintf("\nFor a `file` output, return {\"name\":\"<filename>\",\"content\":\"<the complete file text>\"}"+
					" — content is the actual file body, which is stored and becomes downloadable. Keep it under %d KiB,"+
					" at most %d files, and never claim a file exists without supplying its content. Do not return a path.",
					maxArtifactBytes/1024, maxArtifactsPerNode)
			}
			parts = append(parts, instruction)
		}
	}
	parts = append(parts, "请按本节点职责完成任务，并按声明的格式给出最终输出。")
	return strings.Join(parts, "\n\n"), nil
}
func formOutput(n graphNode) string {
	if len(n.Fields) == 0 {
		return "（空表单）"
	}
	parts := []string{}
	for _, f := range n.Fields {
		label, value := f.Label, strings.TrimSpace(f.Value)
		if label == "" {
			label = "字段"
		}
		if value == "" {
			value = "（未填写）"
		}
		parts = append(parts, label+": "+value)
	}
	return strings.Join(parts, "\n")
}
