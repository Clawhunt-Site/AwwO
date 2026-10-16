package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// An assemble node makes its deliverable from its inputs without a model: every {{in:<field id>}} slot of its template
// takes that input's exact text — the upstream output its wire carries, or the field's own value. An agent team
// delivers a program as modules; before this node, a model call re-typed every module into the page, which spent most
// of a 32,000-token call on copying and capped a delivered page at about 42 KB (car-plant's page node, 2026-10-15).
//
// The same algorithm runs in the canvas (apps/web/src/canvas/assembleNode.ts); both are checked against
// testdata/assemble_vectors.json.
const (
	maxAssembleTemplateBytes = 64 << 10
	// The page preview's own limit (MAX_ARTIFACT_PREVIEW_BYTES); a larger document could not be shown anyway.
	maxAssembleOutputBytes = 2 << 20
	assembleDefaultFile    = "index.html"
)

var assembleSlot = regexp.MustCompile(`\{\{in:([A-Za-z0-9_-]{1,64})\}\}`)
// HTML tag names are case-insensitive in ASCII only, so the patterns spell their cases out: (?i) would also fold
// letters such as ſ (long s), which no browser reads as an s.
var assembleScriptClose = regexp.MustCompile(`</([sS][cC][rR][iI][pP][tT])`)
var assembleStyleClose = regexp.MustCompile(`</([sS][tT][yY][lL][eE])`)

// assembleRegion is the content of one <script> or <style> element of a template.
type assembleRegion struct {
	start, end int
	tag        string
}

// assembleRegions finds the raw-text elements of a template, skipping HTML comments, so a slot knows whether the text
// it receives lands in a script, a style sheet or the page itself.
func assembleRegions(template string) []assembleRegion {
	lower := asciiLower(template)
	regions := []assembleRegion{}
	for i := 0; i < len(template); {
		if strings.HasPrefix(lower[i:], "<!--") {
			end := strings.Index(lower[i+4:], "-->")
			if end < 0 {
				break
			}
			i += 4 + end + 3
			continue
		}
		tag := ""
		for _, name := range []string{"script", "style"} {
			if strings.HasPrefix(lower[i:], "<"+name) {
				next := i + 1 + len(name)
				if next == len(lower) || strings.IndexByte(" \t\r\n\f/>", lower[next]) >= 0 {
					tag = name
				}
			}
		}
		if tag == "" {
			i++
			continue
		}
		open := strings.IndexByte(template[i:], '>')
		if open < 0 {
			break
		}
		start := i + open + 1
		end := len(template)
		if closing := strings.Index(lower[start:], "</"+tag); closing >= 0 {
			end = start + closing
		}
		regions = append(regions, assembleRegion{start, end, tag})
		i = end
	}
	return regions
}

// asciiLower lowercases A-Z only, so every byte offset of the result is the input's (strings.ToLower can change the
// length of non-ASCII text).
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// unfenceAssembleValue returns the body of a value that is exactly one Markdown code fence (a model often wraps a
// module in one); any other value is returned unchanged, byte for byte.
func unfenceAssembleValue(value string) string {
	trimmed := strings.TrimSpace(value)
	if !strings.HasPrefix(trimmed, "```") {
		return value
	}
	lines := strings.Split(strings.ReplaceAll(trimmed, "\r\n", "\n"), "\n")
	if len(lines) < 2 || strings.TrimSpace(lines[len(lines)-1]) != "```" {
		return value
	}
	info := strings.TrimSpace(strings.TrimPrefix(lines[0], "```"))
	if strings.Contains(info, "`") {
		return value
	}
	body := lines[1 : len(lines)-1]
	for _, line := range body {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			return value
		}
	}
	return strings.Join(body, "\n")
}

// escapeAssembleValue keeps inserted text inside the element it was placed in: a script or style sheet may not end its
// own element. In a script, `</script` becomes `<\/script` and `<!--` becomes `<\!--`, which mean the same in a
// JavaScript string, template or regular expression.
func escapeAssembleValue(value, tag string) string {
	switch tag {
	case "script":
		return strings.ReplaceAll(assembleScriptClose.ReplaceAllString(value, `<\/$1`), "<!--", `<\!--`)
	case "style":
		return assembleStyleClose.ReplaceAllString(value, `<\/$1`)
	}
	return value
}

// assembleTemplate fills every slot in one left-to-right pass; inserted text is never scanned for slots again.
func assembleTemplate(template string, values map[string]string) (string, error) {
	regions := assembleRegions(template)
	var b strings.Builder
	last := 0
	for _, m := range assembleSlot.FindAllStringSubmatchIndex(template, -1) {
		id := template[m[2]:m[3]]
		value, ok := values[id]
		if !ok {
			return "", fmt.Errorf("Template slot {{in:%s}} names no input", id)
		}
		tag := ""
		for _, r := range regions {
			if m[0] >= r.start && m[1] <= r.end {
				tag = r.tag
				break
			}
		}
		b.WriteString(template[last:m[0]])
		b.WriteString(escapeAssembleValue(unfenceAssembleValue(value), tag))
		last = m[1]
		if b.Len() > maxAssembleOutputBytes {
			return "", errors.New("The assembled result exceeds 2 MiB")
		}
	}
	b.WriteString(template[last:])
	if b.Len() > maxAssembleOutputBytes {
		return "", errors.New("The assembled result exceeds 2 MiB")
	}
	return b.String(), nil
}

// assembleOutputs returns the node's text output and file output fields (either may be nil).
func assembleOutputs(n graphNode) (*graphField, *graphField) {
	var text, file *graphField
	if n.Contract == nil {
		return nil, nil
	}
	for i := range n.Contract.Outputs {
		f := &n.Contract.Outputs[i]
		if f.Type == "file" {
			file = f
		} else {
			text = f
		}
	}
	return text, file
}

// validateAssembleNode is parseGraph's check of an assemble node: one or two outputs (at most one text-like and at most
// one file), inputs that carry text, and a template whose every slot names an input.
func validateAssembleNode(n graphNode) error {
	if n.Contract == nil {
		return errors.New("An assemble node needs its inputs and outputs")
	}
	texts, files := 0, 0
	for _, f := range n.Contract.Outputs {
		switch f.Type {
		case "html", "markdown", "text":
			texts++
		case "file":
			files++
		default:
			return errors.New("An assemble node delivers text, Markdown, HTML or a file")
		}
	}
	if texts > 1 || files > 1 || texts+files == 0 {
		return errors.New("An assemble node delivers one text result, one file, or both")
	}
	inputs := map[string]bool{}
	for _, f := range n.Contract.Inputs {
		if f.Type == "file" {
			return errors.New("An assemble node's inputs carry text")
		}
		inputs[f.ID] = true
	}
	if strings.TrimSpace(n.Template) == "" || len(n.Template) > maxAssembleTemplateBytes || !utf8.ValidString(n.Template) {
		return fmt.Errorf("An assemble node needs a template of 1–%d bytes", maxAssembleTemplateBytes)
	}
	for _, m := range assembleSlot.FindAllStringSubmatch(n.Template, -1) {
		if !inputs[m[1]] {
			return fmt.Errorf("Template slot {{in:%s}} names no input", m[1])
		}
	}
	if files > 0 {
		if _, err := artifactName(assembleFileName(n)); err != nil {
			return err
		}
	}
	return nil
}

func assembleFileName(n graphNode) string {
	if strings.TrimSpace(n.FileName) == "" {
		return assembleDefaultFile
	}
	return strings.TrimSpace(n.FileName)
}

// assembleInputValues resolves each input as graphPrompt does: a wired input reads its upstream's delivered field, an
// unwired one keeps the value typed into it.
func assembleInputValues(n graphNode, d graphDocument, outputs map[string]string) (map[string]string, error) {
	nodes := map[string]graphNode{}
	for _, v := range d.Nodes {
		nodes[v.ID] = v
	}
	values := map[string]string{}
	for _, f := range n.Contract.Inputs {
		value, wired := f.Value, false
		for _, e := range d.Edges {
			if e.ToNode != n.ID || e.ToPort != "in:"+f.ID {
				continue
			}
			src := nodes[e.FromNode]
			out := stripReasoningPreamble(outputs[e.FromNode])
			if src.Contract != nil {
				vals, err := graphOutput(src, out)
				if err != nil {
					return nil, err
				}
				out = vals[strings.TrimPrefix(e.FromPort, "out:")]
			} else if graphMediaNode(src) {
				if listed := mediaDeliveryText(src, out); listed != out {
					out = listed
				} else {
					out = mediaMissingText(src)
				}
			}
			value, wired = out, true
		}
		if f.Required && strings.TrimSpace(value) == "" {
			label := f.Label
			if label == "" {
				label = f.ID
			}
			if wired {
				return nil, fmt.Errorf("Input %s received nothing from its upstream", label)
			}
			return nil, fmt.Errorf("Input %s is empty", label)
		}
		values[f.ID] = value
	}
	return values, nil
}

// executeAssembleNode settles an assemble node: its result, or the reason it could not be made. A file output is
// stored as the canvas's artifact under the graph's id, so a sandbox node downstream receives the page as a real file.
func (a *App) executeAssembleNode(ctx context.Context, tid, gid, canvasID string, n graphNode, d graphDocument, outputs map[string]string) (string, error) {
	values, err := assembleInputValues(n, d, outputs)
	if err != nil {
		return "", err
	}
	result, err := assembleTemplate(n.Template, values)
	if err != nil {
		return "", err
	}
	text, file := assembleOutputs(n)
	if text != nil {
		if err = fieldValue(*text, result); err != nil {
			return "", fmt.Errorf("The assembled result is not deliverable: %w", err)
		}
		if file == nil {
			return result, nil
		}
	}
	// Base64 lets the file take the sandbox's 2 MiB file limit instead of the 256 KiB a model's text file gets.
	object := map[string]any{file.ID: map[string]string{"name": assembleFileName(n), "content": base64.StdEncoding.EncodeToString([]byte(result)), "encoding": "base64"}}
	if text != nil {
		object[text.ID] = result
	}
	raw, _ := json.Marshal(object)
	vals, files, err := graphOutputFiles(n, string(raw))
	if err != nil {
		return "", fmt.Errorf("The assembled result is not deliverable: %w", err)
	}
	return a.storeArtifacts(ctx, tid, canvasID, "graph:"+gid, n.ID, string(raw), vals, files)
}
