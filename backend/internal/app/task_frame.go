package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

// taskFrame is authored in the saved canvas, never inferred from model output.
// Its schema version is separate from the canvas CAS revision.
type taskFrame struct {
	Version            int      `json:"version"`
	Source             string   `json:"source"`
	Constraints        []string `json:"constraints"`
	AcceptanceCriteria []string `json:"acceptanceCriteria"`
}

func (f *taskFrame) UnmarshalJSON(raw []byte) error {
	type wire taskFrame
	var value wire
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return errors.New("Invalid task frame structure")
	}
	if value.Version != 1 || value.Source != "manual" || value.Constraints == nil || value.AcceptanceCriteria == nil {
		return errors.New("Task frame requires version 1, manual source and both item arrays")
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	if len(fields) != 4 || len(fields["version"]) == 0 || len(fields["source"]) == 0 || len(fields["constraints"]) == 0 || len(fields["acceptanceCriteria"]) == 0 {
		return errors.New("Invalid task frame fields")
	}
	for _, key := range []string{"constraints", "acceptanceCriteria"} {
		var items []json.RawMessage
		_ = json.Unmarshal(fields[key], &items)
		for _, item := range items {
			if bytes.Equal(bytes.TrimSpace(item), []byte("null")) {
				return errors.New("Task frame items must be strings")
			}
		}
	}
	keep := func(items []string) []string {
		result := []string{}
		for _, item := range items {
			if strings.TrimSpace(item) != "" {
				result = append(result, item)
			}
		}
		return result
	}
	value.Constraints = keep(value.Constraints)
	value.AcceptanceCriteria = keep(value.AcceptanceCriteria)
	total := 0
	for _, items := range [][]string{value.Constraints, value.AcceptanceCriteria} {
		if len(items) > 20 {
			return errors.New("Task frame allows at most 20 items in each list")
		}
		for _, item := range items {
			size := utf8.RuneCountInString(item)
			if size > 2000 {
				return errors.New("Task frame items may contain at most 2000 Unicode characters")
			}
			total += size
		}
	}
	if total > 12000 {
		return errors.New("Task frame may contain at most 12000 Unicode characters")
	}
	*f = taskFrame(value)
	return nil
}

func parseTaskFrame(raw json.RawMessage) (*taskFrame, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var frame taskFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil, err
	}
	return &frame, nil
}

func savedNodeTaskFrame(raw []byte, nodeID string) (*taskFrame, error) {
	var document struct {
		Nodes []struct {
			ID        string          `json:"id"`
			TaskFrame json.RawMessage `json:"taskFrame"`
		} `json:"nodes"`
	}
	if json.Unmarshal(raw, &document) != nil {
		return nil, errors.New("Invalid canvas")
	}
	for _, node := range document.Nodes {
		if node.ID == nodeID {
			return parseTaskFrame(node.TaskFrame)
		}
	}
	return nil, nil
}

// Validate only this additive field; legacy document shapes retain their existing
// save behavior and are still checked by the relevant execution admission path.
func validateCanvasTaskFrames(raw []byte) error {
	var document map[string]json.RawMessage
	var nodes []json.RawMessage
	if json.Unmarshal(raw, &document) != nil || json.Unmarshal(document["nodes"], &nodes) != nil {
		return nil
	}
	for _, rawNode := range nodes {
		var node map[string]json.RawMessage
		if json.Unmarshal(rawNode, &node) != nil {
			continue
		}
		if _, err := parseTaskFrame(node["taskFrame"]); err != nil {
			return err
		}
	}
	return nil
}

// An older client does not know this optional field. Its ordinary canvas save
// must not remove authored requirements. New clients clear them with a valid
// explicit frame containing empty arrays; deleting the node still deletes it.
func preserveCanvasTaskFrames(saved, incoming json.RawMessage) json.RawMessage {
	var prior, next map[string]json.RawMessage
	var oldNodes, newNodes []json.RawMessage
	if json.Unmarshal(saved, &prior) != nil || json.Unmarshal(incoming, &next) != nil ||
		json.Unmarshal(prior["nodes"], &oldNodes) != nil || json.Unmarshal(next["nodes"], &newNodes) != nil {
		return incoming
	}
	frames := map[string]json.RawMessage{}
	for _, raw := range oldNodes {
		var node struct {
			ID    string          `json:"id"`
			Kind  string          `json:"kind"`
			Frame json.RawMessage `json:"taskFrame"`
		}
		if json.Unmarshal(raw, &node) == nil && node.Kind == "session" && len(node.Frame) > 0 {
			frames[node.ID] = node.Frame
		}
	}
	changed := false
	for i, raw := range newNodes {
		var node map[string]json.RawMessage
		var id, kind string
		if json.Unmarshal(raw, &node) != nil {
			continue
		}
		_ = json.Unmarshal(node["id"], &id)
		_ = json.Unmarshal(node["kind"], &kind)
		if kind == "session" && len(node["taskFrame"]) == 0 && len(frames[id]) > 0 {
			node["taskFrame"] = frames[id]
			newNodes[i], _ = json.Marshal(node)
			changed = true
		}
	}
	if !changed {
		return incoming
	}
	next["nodes"], _ = json.Marshal(newNodes)
	result, _ := json.Marshal(next)
	return result
}

func taskFrameSystemPrompt(instructions string, frame *taskFrame) string {
	if frame == nil || (len(frame.Constraints) == 0 && len(frame.AcceptanceCriteria) == 0) {
		return instructions
	}
	raw, _ := json.Marshal(frame)
	return instructions + "\n\nManual task requirements (JSON; preserve the authored requirements):\n" + string(raw) +
		"\nFollow the constraints and evaluate the acceptance criteria against actual outputs. " +
		"These requirements are not evidence of completion. Report missing evidence and never claim that a criterion passed merely because a run completed."
}
