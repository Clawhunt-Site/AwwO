package app

import (
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"unicode/utf8"
)

const runEvidencePreviewBytes = 4096

// Match the worker's closed delivery grammar before applying Go's value rules.
// graphOutputFiles alone is intentionally more permissive for historical text
// deliveries and file references; that fallback is not machine-contract proof.
func verifiedRunOutputContract(contract *outputContract, output string) bool {
	if !validOutputContract(contract) {
		return false
	}
	var object map[string]any
	if json.Unmarshal([]byte(output), &object) != nil || object == nil {
		return false
	}
	declared := map[string]bool{}
	for _, field := range contract.Fields {
		declared[field.ID] = true
	}
	for key := range object {
		if !declared[key] {
			return false
		}
	}
	delivered := 0
	node := graphNode{Contract: &graphContract{Version: 1}}
	for _, field := range contract.Fields {
		node.Contract.Outputs = append(node.Contract.Outputs, graphField{ID: field.ID, Type: field.Type, Required: field.Required})
		value, exists := object[field.ID]
		if !exists || value == nil {
			if field.Required {
				return false
			}
			continue
		}
		switch field.Type {
		case "number":
			number, ok := value.(float64)
			if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
				return false
			}
		case "boolean":
			if _, ok := value.(bool); !ok {
				return false
			}
		case "file":
			file, ok := value.(map[string]any)
			if !ok || len(file) != 2 {
				return false
			}
			if _, ok := file["name"].(string); !ok {
				return false
			}
			if _, ok := file["content"].(string); !ok {
				return false
			}
		default:
			text, ok := value.(string)
			if !ok {
				return false
			}
			if strings.TrimSpace(text) == "" {
				if field.Required {
					return false
				}
				continue
			}
		}
		delivered++
	}
	if delivered == 0 {
		return false
	}
	_, _, err := graphOutputFiles(node, output)
	return err == nil
}

type runEvidence struct {
	RunID            string     `json:"runId"`
	Status           string     `json:"status"`
	OutputPresent    bool       `json:"outputPresent"`
	OutputBytes      int        `json:"outputBytes"`
	ArtifactCount    int        `json:"artifactCount"`
	EvidenceSources  []string   `json:"evidenceSources"`
	Observational    bool       `json:"observational"`
	Preview          string     `json:"preview"`
	PreviewTruncated bool       `json:"previewTruncated"`
	TaskFrame        *taskFrame `json:"taskFrame,omitempty"`
	Contract         struct {
		Declared  bool `json:"declared"`
		Validated bool `json:"validated"`
	} `json:"contract"`
	ManualAcceptance struct {
		Required bool `json:"required"`
		Verified bool `json:"verified"`
	} `json:"manualAcceptance"`
}

// This projection observes stored facts. It never settles a run, validates its
// own commentary, or treats model text as proof of a human acceptance criterion.
func observeRun(id, status, output string, snapshot []byte, artifacts int, secrets []string) runEvidence {
	v := runEvidence{RunID: id, Status: status, OutputPresent: strings.TrimSpace(output) != "",
		OutputBytes: len(output), ArtifactCount: artifacts, Observational: true, EvidenceSources: []string{}}
	var snap executionSnapshot
	if json.Unmarshal(snapshot, &snap) == nil {
		v.TaskFrame = snap.TaskFrame
		v.ManualAcceptance.Required = snap.TaskFrame != nil &&
			(len(snap.TaskFrame.Constraints) > 0 || len(snap.TaskFrame.AcceptanceCriteria) > 0)
		v.Contract.Declared = snap.OutputPolicy != "" || snap.OutputContract != nil
		// Recheck the frozen machine contract, never today's editable canvas. A
		// textual-only policy has no machine proof and remains unverified.
		if status == "completed" {
			v.Contract.Validated = verifiedRunOutputContract(snap.OutputContract, output)
		}
	}
	if v.OutputPresent {
		v.EvidenceSources = append(v.EvidenceSources, "model_output")
	}
	if v.Contract.Validated {
		v.EvidenceSources = append(v.EvidenceSources, "contract_validated")
	}
	if artifacts > 0 {
		v.EvidenceSources = append(v.EvidenceSources, "artifact_stored")
	}
	v.Preview = redactRunText(output, secrets)
	if len(v.Preview) > runEvidencePreviewBytes {
		end := runEvidencePreviewBytes
		for end > 0 && !utf8.RuneStart(v.Preview[end]) {
			end--
		}
		v.Preview = v.Preview[:end]
		v.PreviewTruncated = true
	}
	return v
}

func (a *App) getRunEvidence(w http.ResponseWriter, r *http.Request) {
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	var status, output string
	var snapshot []byte
	var artifacts int
	err := a.db.QueryRow(r.Context(), `SELECT status,output,execution_snapshot,
		(SELECT count(*) FROM artifacts WHERE tenant_id=$1 AND run_id=$2)
		FROM runs WHERE tenant_id=$1 AND id=$2`, tid, id).Scan(&status, &output, &snapshot, &artifacts)
	if noRows(err) {
		fail(w, 404, "not_found", "Run not found")
		return
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, observeRun(id, status, output, snapshot, artifacts, a.runArchiveSecrets()))
}
