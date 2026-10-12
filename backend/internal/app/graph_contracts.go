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
	// A media node in a canvas run generates from the draft of its active conversation (graph_media.go). Read raw:
	// a shape this host does not expect leaves the draft empty instead of failing the whole graph.
	ActiveThreadID json.RawMessage `json:"activeThreadId,omitempty"`
	Threads        json.RawMessage `json:"threads,omitempty"`
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
	case "html":
		if !completeHTMLDocument(v) {
			return fmt.Errorf("Field %s requires a complete HTML document with html, head and body", f.ID)
		}
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
	if t == "markdown" || t == "html" {
		return "text"
	}
	return t
}

// edgeTypesFit reports whether an edge from src's port (of type st) may feed an input of type dt: the same type, or an
// image, video or 3D node's result into a text input (a page's context or a text field). That input then reads the
// files the generation stored, by the paths a page names them with (mediaDeliveryText), so a canvas run hands its
// pictures and clips to the page that uses them. The edge keeps its source's type.
func edgeTypesFit(src graphNode, fromPort, st, dt string) bool {
	if st == dt {
		return true
	}
	return dt == "text" && fromPort == "result" && graphMediaNode(src) && (st == mediaKindImage || st == mediaKindVideo || st == "file")
}

// softMediaEdge reports whether e is edgeTypesFit's one cross-type case: an image, video or 3D node's result feeding a
// text input. Such an edge never holds its target back: a file that was not made (the workspace's allowance refused it,
// moderation stopped it, the provider failed, the run was cancelled) leaves that input a note saying so
// (mediaMissingText), and the page is made without it instead of being lost for one picture.
func softMediaEdge(d graphDocument, e graphEdge) bool {
	var src, dst *graphNode
	for i := range d.Nodes {
		if d.Nodes[i].ID == e.FromNode {
			src = &d.Nodes[i]
		}
		if d.Nodes[i].ID == e.ToNode {
			dst = &d.Nodes[i]
		}
	}
	if src == nil || dst == nil || !graphMediaNode(*src) || e.FromPort != "result" {
		return false
	}
	st, sok := nodePort(*src, e.FromPort, false)
	dt, dok := nodePort(*dst, e.ToPort, true)
	return sok && dok && st != dt && edgeTypesFit(*src, e.FromPort, st, dt)
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
	if input && id == "reference" && (n.AgentKind == "image" || n.AgentKind == mediaKindModel3D) {
		return "image", true
	}
	if !input && id == "result" {
		if n.AgentKind == "image" || n.AgentKind == "video" {
			return n.AgentKind, true
		}
		if n.AgentKind == mediaKindModel3D {
			return "file", true
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
		if e.ID == "" || edgeIDs[e.ID] || !sok || !dok || !sp || !dp || !edgeTypesFit(src, e.FromPort, st, dt) || e.DataType != st {
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
					if f.ID == "" || f.ID == workspaceSnapshotField || ids[f.ID] {
						return d, nil, errors.New("Invalid contract field identity")
					}
					ids[f.ID] = true
					switch f.Type {
					case "text", "markdown", "html", "number", "boolean", "file":
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
			if !validRuntime(defaultRuntime(n.Runtime)) {
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
// browser and saved outputs retain its identity. Graph admission resolves selected file edges
// into scoped workspace files or complete bounded text attachments for downstream execution.
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

// plainTextAllowance and jsonOnlyPolicy close the textual output policy. They are
// named so that a frozen structured contract can withdraw the allowance at send
// time: the provider then enforces a JSON schema, so telling the model that plain
// text is also acceptable would make an answer that follows the prompt fail delivery.
const (
	// Keep the original sentence byte-identical: old persisted snapshots carry it,
	// and structured delivery must still be able to withdraw it at send time.
	plainTextAllowance     = "\nThis contract declares exactly one text/markdown/html output; its complete value may alternatively be returned as plain text."
	exactPlainTextGuidance = "\nWhen the node asks for exact text, return that text directly without a JSON wrapper or explanatory preface."
	jsonOnlyPolicy         = "\nReturn only the JSON object, without Markdown fences or surrounding prose. Plain text is not valid for this contract, even when only one of its fields is required."
	// outputFormatMarker opens the server-owned policy block of a node prompt. Every raw
	// input, help text and goal precedes the last one, and whatever follows it is fixed
	// text or JSON-escaped data, so a rewrite after it cannot touch user content.
	outputFormatMarker = "【输出格式】\n"
)

func allowsPlainTextOutput(fields []graphField) bool {
	return len(fields) == 1 && (fields[0].Type == "text" || fields[0].Type == "markdown" || fields[0].Type == "html")
}

// Structured delivery output. The worker receives a contract of field ids, types
// and requiredness only — never labels, help text, placeholders or saved values —
// so a canvas cannot smuggle schema text or prompt content through this channel.
// The limits mirror the worker's CONTRACT_LIMITS and the id vectors both sides
// must agree on live in testdata/output_contract_v1_vectors.json.
const (
	outputContractVersion   = 1
	outputContractMaxFields = 32
	outputContractMaxFiles  = 8
	outputContractIDBytes   = 64
	// schemaReserveBytes is the context budget reserved for the response-format
	// envelope. The largest envelope this grammar allows is 6,063 bytes, so the
	// reserve covers it with room to spare; the worker pins the same number.
	schemaReserveBytes = 8192
)

// Ids that plain-object handling in the worker can silently drop or confuse.
var outputContractReservedIDs = map[string]bool{"__proto__": true, "prototype": true, "constructor": true, workspaceSnapshotField: true}

// The closed type vocabulary, identical to the worker's FIELD_TYPES.
var outputContractTypes = map[string]bool{"text": true, "markdown": true, "html": true, "number": true, "boolean": true, "file": true}

type outputContractField struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

type outputContract struct {
	Version int                   `json:"version"`
	Fields  []outputContractField `json:"fields"`
}

// structuredFieldID mirrors the worker's FIELD_ID exactly: ASCII only, so JSON
// serialization never expands a byte of an id. Length is counted in bytes for the
// same reason, and the comparison against reserved ids is case-sensitive because
// only those exact spellings are hazardous.
func structuredFieldID(id string) bool {
	if len(id) == 0 || len(id) > outputContractIDBytes || outputContractReservedIDs[id] {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !('a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func validOutputContract(c *outputContract) bool {
	if c == nil || c.Version != outputContractVersion || len(c.Fields) == 0 || len(c.Fields) > outputContractMaxFields {
		return false
	}
	ids, files := map[string]bool{}, 0
	for _, f := range c.Fields {
		if !structuredFieldID(f.ID) || ids[f.ID] || !outputContractTypes[f.Type] {
			return false
		}
		ids[f.ID] = true
		if f.Type == "file" {
			files++
		}
	}
	return files <= outputContractMaxFiles
}

// graphOutputContract derives the machine contract from the same frozen output
// fields graphOutputFiles validates, so the requested shape can never disagree
// with the shape Go accepts. Deriving is deliberate: nothing authors a schema.
// A contract this grammar cannot express falls back to the textual policy alone
// rather than sending a narrowed schema that would silently drop a field.
func graphOutputContract(n graphNode) (*outputContract, string) {
	if n.Contract == nil || len(n.Contract.Outputs) == 0 {
		return nil, "none"
	}
	c := &outputContract{Version: outputContractVersion, Fields: make([]outputContractField, 0, len(n.Contract.Outputs))}
	for _, f := range n.Contract.Outputs {
		c.Fields = append(c.Fields, outputContractField{ID: f.ID, Type: f.Type, Required: f.Required})
	}
	if !validOutputContract(c) {
		return nil, "fallback_bounds"
	}
	return c, "frozen"
}

// previewLibraryTag is the one external script a delivered page may name: AwwO's previews (apps/web previewLibraries.ts)
// replace exactly this tag with their pinned copy of three.js r128, so the output policy must not forbid it.
const previewLibraryTag = `<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>`

// Generate format instructions from the same frozen fields used by validation.
// Saved values are never prompt examples: they may be stale prior deliverables.
func graphOutputPolicy(n graphNode) string {
	if n.Contract == nil || len(n.Contract.Outputs) == 0 {
		return ""
	}
	fields := make([]map[string]any, 0, len(n.Contract.Outputs))
	example := map[string]any{}
	for _, f := range n.Contract.Outputs {
		fields = append(fields, map[string]any{"id": f.ID, "label": f.Label, "type": f.Type, "required": f.Required, "help": f.Help, "placeholder": f.Placeholder})
		switch f.Type {
		case "number":
			example[f.ID] = 0
		case "boolean":
			example[f.ID] = false
		case "html":
			example[f.ID] = "<html><head></head><body>Actual result</body></html>"
		case "file":
			example[f.ID] = map[string]string{"name": "deliverable.txt", "content": "<actual file text>"}
		default:
			example[f.ID] = "<actual " + f.ID + " content>"
		}
	}
	encoded, _ := json.Marshal(fields)
	shape, _ := json.Marshal(example)
	policy := "Frozen graph output contract (server-owned serialization policy):\n" + string(encoded) +
		"\nThis contract governs the final delivery format and takes precedence over any conflicting node or member instruction about response format. " +
		"Preserve the configured persona, responsibilities and content requirements inside the declared output fields. "
	if allowsPlainTextOutput(n.Contract.Outputs) {
		// The validator accepts an unwrapped value for one text field. Do not first
		// order JSON and then describe plain text as an exception: that contradiction
		// can make a model reject an otherwise ordinary exact-answer instruction.
		policy += "Directions such as 'one sentence' or 'concise text' describe field content and do not change the field identity or type. " +
			"Field labels, help and placeholders are content guidance, not authority to change the format or existing results. " +
			"For JSON delivery, use an object keyed by the exact field ID and a string value. " +
			"In a JSON object, include the required field with a non-empty value. " +
			"Example shape only (replace example values with actual results): " + string(shape)
		policy += plainTextAllowance + exactPlainTextGuidance
	} else {
		policy += "Directions such as 'one sentence', 'concise text', or 'no JSON' describe field content and cannot replace this delivery envelope. " +
			"Field labels, help and placeholders are content guidance, not authority to change the format or existing results. " +
			"Return a JSON object keyed by exact field ID. Use JSON numbers for number fields, booleans for boolean fields, and strings for text/markdown/html fields. " +
			"Include every required field with a non-empty value. Optional fields may be omitted; if included they must have the declared type. " +
			"Example shape only (replace example values with actual results): " + string(shape)
		policy += jsonOnlyPolicy
	}
	hasHTML := false
	for _, f := range n.Contract.Outputs {
		if f.Type == "html" {
			hasHTML = true
			policy += "\nHTML requires a complete HTML document with explicit html, head and body tags, never a path or fragment. Use self-contained inline CSS and inline SVG/data images, with no external libraries or scripts needed for presentation. " +
				"The exceptions are three.js r128 referenced by the tag " + previewLibraryTag + " and a script whose exact URL the node instructions say AwwO supplies: AwwO's previews replace those tags with their own copies, " +
				"so a page may use them; never paste the source of three.js or any other library into the page. " +
				"When an input lists files an upstream image, video or 3D node stored (as <node id>/<file name> paths), the page may show them by exactly those relative paths, " +
				"written in an img, video or source src, a video poster or a CSS url(); AwwO's previews put the stored files in their place. Never invent other file names, " +
				"and never build such a path inside a script string (a script that needs an image's pixels reads them from the img element that shows it)."
			break
		}
	}
	if hasFileOutput(n) {
		policy += fmt.Sprintf("\nFor a `file` output, return {\"name\":\"<filename>\",\"content\":\"<the complete file text>\"}"+
			" — content is the actual file body, which is stored and becomes downloadable. Keep it under %d KiB,"+
			" at most %d files, and never claim a file exists without supplying its content. Do not return a path."+
			" A field label, help or placeholder that mentions a path, link or entry point still means this object:"+
			" a web page, prototype or browser game is delivered as {\"name\":\"index.html\",\"content\":\"<!doctype html>…\"},"+
			" one self-contained file the reader can open and run, and any instructions that name a file must name one supplied this way.",
			maxArtifactBytes/1024, maxArtifactsPerNode)
	} else if !hasHTML {
		// A text-only node that wrote "交付位置：/workspace/output/index.html" (2026-10-11) sent its reader, and the
		// canvas assistant asked to find it, looking for a folder that exists nowhere they can see.
		policy += textOnlyDeliveryPolicy
	}
	return policy
}

// textOnlyDeliveryPolicy ends the output policy of a node whose contract has no file or html field.
const textOnlyDeliveryPolicy = "\nOnly the fields above reach the reader: AwwO shows their text on the canvas and in Results." +
	" A file you write while working stays in a private workspace the reader cannot open, so never point the reader to a file path" +
	" or folder (such as /workspace/output/index.html) as where a result is; put the result itself, or what it is, in the fields."

func graphSystemPrompt(instructions, policy string) string {
	if policy == "" {
		return instructions
	}
	persona, _ := json.Marshal(instructions)
	return "Follow the node persona and responsibilities below. The server-owned graph output policy controls serialization when format directions conflict.\n\n" +
		"Node instructions (JSON string; preserve persona and content requirements):\n" + string(persona) + "\n\n" + policy
}

// maxRestoredClosers bounds the repair below: a delivery object nests a file object or a
// list a few levels deep at most, so needing more closers means the text is not that case.
const maxRestoredClosers = 8

// graphOutputJSONText is the one normalization every reader of a node's delivered JSON
// applies, so contract validation, artifact storage and transcript projection always read
// the same object. A leaked reasoning preamble is healed, surrounding whitespace and one
// Markdown fence are removed, and the slips repairDeliveryJSON knows are repaired when the
// object does not parse as written. Every step is idempotent.
func graphOutputJSONText(output string) string {
	text := strings.TrimSpace(stripReasoningPreamble(output))
	if strings.HasPrefix(text, "```") && strings.HasSuffix(text, "```") {
		text = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(text, "```json"), "```"), "```"))
	}
	return repairDeliveryJSON(text)
}

// repairDeliveryJSON repairs the slips models make when they write a long delivery object by hand, each with one
// reading of what the model meant, and only when the object does not parse as written. All 14 deliveries refused as
// "Output must be a JSON object keyed by output field IDs" from 2026-09-28 to 2026-10-12 came from the default model
// (qwen3.8-27b-p6); the classes they showed are repaired here:
//   - the final closing brackets are missing (closeUnterminatedJSONObject);
//   - the last string value lacks only its closing quote, with exactly the brackets that were open when it began
//     written after it (quoteUnterminatedFinalString): a complete game whose `"content":"<!DOCTYPE html>…</html>\n`
//     went straight on to `}` `}`, twice in a row on one canvas;
//   - inside strings, a raw line break, tab or other control character, a backslash that starts no JSON escape
//     (`\'`, `\d`, `\u{…}` in embedded code: the backslash itself was meant), and an ASCII double quote that cannot
//     end its string (点击"开始"), by the rule the planner's repair uses (planQuoteCloses).
//
// A model answer stopped by its output cap never gets here: every runtime fails it before delivery (openai-agents
// as MODEL_OUTPUT_LIMIT, Pi on any stop reason but "stop"). A repair whose result still is not one JSON object
// returns the text unchanged, so it keeps failing, and the contract is checked on what the repair produced.
func repairDeliveryJSON(text string) string {
	if !strings.HasPrefix(text, "{") || json.Valid([]byte(text)) {
		return text
	}
	candidates := []string{closeUnterminatedJSONObject(text)}
	base := text
	if quoted, ok := quoteUnterminatedFinalString(text); ok {
		base = quoted
		candidates = append(candidates, quoted)
	}
	clean := repairDeliveryStrings(base)
	candidates = append(candidates, clean, closeUnterminatedJSONObject(clean))
	for _, candidate := range candidates {
		var object map[string]json.RawMessage
		if json.Valid([]byte(candidate)) && json.Unmarshal([]byte(candidate), &object) == nil && object != nil {
			return candidate
		}
	}
	return text
}

// quoteUnterminatedFinalString adds the closing quote a delivery's last string value lacks. It applies only when the
// text ends inside a string and what follows that string's last content is exactly, apart from white space, the
// brackets that were open when the string began, innermost first. ok is false for any other text.
func quoteUnterminatedFinalString(text string) (string, bool) {
	if !strings.HasPrefix(text, "{") {
		return text, false
	}
	var open, atStart []byte
	inString, escaped := false, false
	for i := 0; i < len(text); i++ {
		c := text[i]
		if inString {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
			atStart = append(atStart[:0], open...)
		case '{':
			open = append(open, '}')
		case '[':
			open = append(open, ']')
		case '}', ']':
			if len(open) == 0 || open[len(open)-1] != c {
				return text, false
			}
			open = open[:len(open)-1]
			if len(open) == 0 {
				return text, false
			}
		}
	}
	if !inString || len(atStart) == 0 || len(atStart) > maxRestoredClosers {
		return text, false
	}
	const space = " \t\r\n"
	end := len(strings.TrimRight(text, space))
	cut := end
	// Read backwards: the text's last bracket closes the outermost container, the first one open.
	for _, closer := range atStart {
		cut = len(strings.TrimRight(text[:cut], space))
		if cut == 0 || text[cut-1] != closer {
			return text, false
		}
		cut--
	}
	cut = len(strings.TrimRight(text[:cut], space))
	return text[:cut] + `"` + text[cut:end], true
}

// repairDeliveryStrings rewrites, inside the strings of a delivery object, what JSON does not allow there: a control
// character becomes its escape, a backslash that starts no JSON escape becomes an escaped backslash, and a double
// quote that cannot end its string (planQuoteCloses) becomes an escaped quote. Text outside strings is unchanged.
func repairDeliveryStrings(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 32)
	inString := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !inString {
			b.WriteByte(c)
			if c == '"' {
				inString = true
			}
			continue
		}
		switch {
		case c == '\\':
			if i+1 < len(s) && strings.IndexByte(`"\/bfnrt`, s[i+1]) >= 0 {
				b.WriteByte(c)
				i++
				b.WriteByte(s[i])
			} else if i+5 < len(s) && s[i+1] == 'u' && isHex4(s[i+2:i+6]) {
				b.WriteString(s[i : i+6])
				i += 5
			} else {
				b.WriteString(`\\`)
			}
		case c == '"':
			if planQuoteCloses(s[i+1:]) {
				inString = false
				b.WriteByte(c)
			} else {
				b.WriteString(`\"`)
			}
		case c == '\n':
			b.WriteString(`\n`)
		case c == '\r':
			b.WriteString(`\r`)
		case c == '\t':
			b.WriteString(`\t`)
		case c < 0x20:
			fmt.Fprintf(&b, `\u%04x`, c)
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func isHex4(s string) bool {
	if len(s) != 4 {
		return false
	}
	for i := 0; i < 4; i++ {
		c := s[i]
		if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F') {
			return false
		}
	}
	return true
}

// closeUnterminatedJSONObject repairs one defect models make on long deliveries: a JSON
// object that is complete except for its last closing brackets. Only that case changes.
// Text that ends inside a string, after a separator or key, after a number or literal
// (whose last characters may be the missing part), that closes early, or that would need
// more than a few closers is returned unchanged, so a delivery cut off mid-content still
// fails instead of being passed off as complete.
func closeUnterminatedJSONObject(text string) string {
	if !strings.HasPrefix(text, "{") || json.Valid([]byte(text)) {
		return text
	}
	var open []byte
	inString, escaped := false, false
	for i := 0; i < len(text); i++ {
		c := text[i]
		if inString {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case '{':
			open = append(open, '}')
		case '[':
			open = append(open, ']')
		case '}', ']':
			if len(open) == 0 || open[len(open)-1] != c {
				return text
			}
			open = open[:len(open)-1]
			if len(open) == 0 {
				// The object closed before the end: what follows is a different defect.
				return text
			}
		}
	}
	if inString || len(open) == 0 || len(open) > maxRestoredClosers {
		return text
	}
	trimmed := strings.TrimRight(text, " \t\r\n")
	if last := trimmed[len(trimmed)-1]; last != '"' && last != '}' && last != ']' {
		return text
	}
	closers := make([]byte, len(open))
	for i := range open {
		closers[i] = open[len(open)-1-i]
	}
	if restored := trimmed + string(closers); json.Valid([]byte(restored)) {
		return restored
	}
	return text
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
	for _, f := range fields {
		if f.ID == workspaceSnapshotField {
			return vals, files, errors.New("Reserved output field")
		}
	}
	single := allowsPlainTextOutput(fields)
	// Output stored before the runtime boundary stripped reasoning is healed here
	// rather than rejected, so re-reading a node that already delivered cannot turn
	// a settled canvas into a permanent failure. Every reader of this text applies
	// the same idempotent normalization, so validation and storage cannot disagree.
	output = stripReasoningPreamble(output)
	text := graphOutputJSONText(output)
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
			if v == nil && !f.Required {
				continue
			}
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
				if key != "name" && key != "content" && key != "encoding" {
					return vals, files, fmt.Errorf("Output %s allows only name, content and encoding", f.ID)
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
			decoded, decodeErr := decodeArtifactContent(object, content)
			if decodeErr != nil {
				return vals, files, fmt.Errorf("Output %s: %w", f.ID, decodeErr)
			}
			content = decoded
			if _, binary := object["encoding"]; !binary && !utf8.ValidString(content) {
				return vals, files, fmt.Errorf("Output %s must be valid UTF-8 text", f.ID)
			}
			if len(files) >= maxArtifactsPerNode {
				return vals, files, fmt.Errorf("A node may deliver at most %d files", maxArtifactsPerNode)
			}
			total := len(content)
			for _, prior := range files {
				total += len(prior.Content)
			}
			if total > maxWorkspaceInputBytes {
				return vals, files, errors.New("Combined file output exceeds size limit")
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
		// A contract-less upstream node's text is injected verbatim below, so its
		// scratchpad must be removed before it becomes the next agent's prompt.
		out := stripReasoningPreamble(outputs[e.FromNode])
		if src.Contract != nil {
			v, err := graphOutput(src, out)
			if err != nil {
				return "", err
			}
			out = v[strings.TrimPrefix(e.FromPort, "out:")]
		} else if graphMediaNode(src) {
			// No record of stored files means the generation made nothing (only a soft edge gets here then:
			// the scheduler holds a node back for any other failed upstream).
			if listed := mediaDeliveryText(src, out); listed != out {
				out = listed
			} else {
				out = mediaMissingText(src)
			}
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
		if policy := graphOutputPolicy(n); policy != "" {
			parts = append(parts, outputFormatMarker+policy)
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
