package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
)

type deliveryReference struct {
	ID, Name, SHA256 string
	Size             int
}

// File bytes are transport data, never transcript text. Only an existing exact
// tenant/run/session-node/canvas/field artifact with matching bytes becomes a link.
// Missing storage is described as unavailable; no derived or invented ID is used.
func projectFileDelivery(output string, references map[string]deliveryReference) (string, bool) {
	normalized := strings.TrimSpace(stripReasoningPreamble(output))
	if strings.HasPrefix(normalized, "```") && strings.HasSuffix(normalized, "```") {
		normalized = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(normalized, "```json"), "```"), "```"))
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(normalized), &fields) != nil || fields == nil {
		return output, false
	}
	changed := false
	for id, raw := range fields {
		var file map[string]any
		if json.Unmarshal(raw, &file) != nil {
			continue
		}
		name, hasName := file["name"].(string)
		content, hasContent := file["content"].(string)
		if !hasName || !hasContent {
			continue
		}
		changed = true
		safeName, nameErr := artifactName(name)
		if nameErr != nil {
			safeName = "delivery"
		}
		metadata := map[string]any{"name": safeName, "contentOmitted": true, "storedReference": "unavailable"}
		decoded, err := decodeArtifactContent(file, content)
		if err != nil || nameErr != nil {
			metadata["invalidContent"] = true
		}
		if err == nil {
			metadata["byteLength"] = len(decoded)
			sum := sha256.Sum256([]byte(decoded))
			if ref, ok := references[id]; ok && nameErr == nil && ref.Name == safeName && ref.Size == len(decoded) && ref.SHA256 == hex.EncodeToString(sum[:]) {
				fields[id], _ = json.Marshal(artifactRefPrefix + ref.ID)
				continue
			}
		}
		fields[id], _ = json.Marshal(metadata)
	}
	if !changed {
		return output, false
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		return "", true
	}
	return string(encoded), true
}

var encodedDeliveryContent = regexp.MustCompile(`("content"\s*:\s*")([A-Za-z0-9+/=]{256,})`)

// Malformed historical provider envelopes may contain a prose prefix or be
// truncated before its name/encoding members. Remove only long base64-alphabet
// strings attached to a literal JSON content member, preserving surrounding
// source/prose. This is only applied to assistant history, never user tasks.
func projectHistoryDelivery(content string) string {
	if projected, changed := projectFileDelivery(content, nil); changed {
		return projected
	}
	if encodedDeliveryContent.MatchString(content) {
		return "Host note: encoded file transport bytes were omitted below. Inspect stored artifacts or existing project files; do not infer a successful delivery.\n" + encodedDeliveryContent.ReplaceAllString(content, `${1}[encoded file bytes omitted]`)
	}
	return content
}

func projectStoredDelivery(ctx context.Context, q querier, tid, rid, output string) (string, error) {
	if _, changed := projectFileDelivery(output, nil); !changed {
		return output, nil
	}
	refs := map[string]deliveryReference{}
	rows, err := q.Query(ctx, `SELECT a.field_id,a.id,a.name,a.size,a.sha256 FROM artifacts a
		JOIN runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
		JOIN node_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id
		WHERE a.tenant_id=$1 AND a.run_id=$2 AND a.canvas_id=s.canvas_id AND a.node_id=s.node_id
		AND a.field_id<>'__workspace_snapshot'`, tid, rid)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var field string
		var ref deliveryReference
		if err = rows.Scan(&field, &ref.ID, &ref.Name, &ref.Size, &ref.SHA256); err != nil {
			return "", err
		}
		refs[field] = ref
	}
	if err = rows.Err(); err != nil {
		return "", err
	}
	projected, _ := projectFileDelivery(output, refs)
	return projected, nil
}

func projectDeliveryRecord(ctx context.Context, q querier, tid, rid string, raw json.RawMessage, textKey string) (json.RawMessage, error) {
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	var output string
	if json.Unmarshal(value[textKey], &output) != nil {
		return raw, nil
	}
	if rid == "" {
		_ = json.Unmarshal(value["id"], &rid)
	}
	projected, err := projectStoredDelivery(ctx, q, tid, rid, output)
	if err != nil {
		return nil, err
	}
	if projected == output {
		return raw, nil
	}
	value[textKey], _ = json.Marshal(projected)
	return json.Marshal(value)
}

func projectDeliveryRecords(ctx context.Context, q querier, tid string, records []json.RawMessage, runKey, textKey string, assistantOnly bool) ([]json.RawMessage, error) {
	result := make([]json.RawMessage, len(records))
	for i, raw := range records {
		var item struct{ ID, RunID, TenantID, Role string }
		if err := json.Unmarshal(raw, &item); err != nil {
			return nil, err
		}
		result[i] = raw
		if assistantOnly && item.Role != "assistant" {
			continue
		}
		rid := item.ID
		if runKey == "runId" {
			rid = item.RunID
		}
		tenant := tid
		if tenant == "" {
			tenant = item.TenantID
		}
		projected, err := projectDeliveryRecord(ctx, q, tenant, rid, raw, textKey)
		if err != nil {
			return nil, err
		}
		result[i] = projected
	}
	return result, nil
}
