package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

type workspaceAgentReference struct {
	Source  string `json:"source"`
	AgentID string `json:"agentId"`
}

func parseWorkspaceAgentReference(raw json.RawMessage) (*workspaceAgentReference, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var fields map[string]json.RawMessage
	var ref workspaceAgentReference
	if json.Unmarshal(raw, &fields) != nil || len(fields) != 2 || len(fields["source"]) == 0 || len(fields["agentId"]) == 0 || json.Unmarshal(raw, &ref) != nil || ref.Source != "workspace" || ref.AgentID == "" || ref.AgentID != strings.TrimSpace(ref.AgentID) || len(ref.AgentID) > 200 {
		return nil, invalidSetup("Select a valid existing Agent from this workspace")
	}
	return &ref, nil
}

// Resolve the selection under the same tenant-first transaction as initialization.
// Browser model/persona fields are only a preview, never this Agent's definition.
func resolveWorkspaceAgent(ctx context.Context, tx pgx.Tx, tid string, raw json.RawMessage) (json.RawMessage, *setupBinding, error) {
	var node map[string]json.RawMessage
	if json.Unmarshal(raw, &node) != nil || node == nil {
		return nil, nil, invalidSetup("Invalid node configuration")
	}
	ref, err := parseWorkspaceAgentReference(node["agentRef"])
	if err != nil || ref == nil {
		return raw, nil, err
	}
	if team := node["team"]; len(team) > 0 && string(team) != "null" {
		return nil, nil, invalidSetup("An existing workspace Agent cannot be replaced by an inline team")
	}
	var name, runtime, model, effort, instructions string
	err = tx.QueryRow(ctx, "SELECT name,runtime,model,effort,instructions FROM agents WHERE tenant_id=$1 AND id=$2 AND NOT internal FOR SHARE", tid, ref.AgentID).Scan(&name, &runtime, &model, &effort, &instructions)
	if noRows(err) {
		return nil, nil, missingSetupReference()
	}
	if err != nil {
		return nil, nil, err
	}
	putJSON(node, "runtime", legacyRuntime(runtime))
	putJSON(node, "model", model)
	putJSON(node, "effort", effort)
	putJSON(node, "persona", instructions)
	resolved, err := json.Marshal(node)
	return resolved, &setupBinding{CompanyID: tid, AgentID: ref.AgentID, AgentName: name}, err
}

// A changed selection must be initialized before any manual or graph execution.
// This also prevents attaching an inline team to a referenced Agent via raw JSON.
func validateSavedWorkspaceAgent(document json.RawMessage, nodeID, agentID string) error {
	ref, err := savedWorkspaceAgentReference(document, nodeID)
	if err != nil || ref == nil {
		return err
	}
	if ref.AgentID != agentID {
		return workspaceAgentSetupRequired()
	}
	return nil
}

func workspaceAgentSetupRequired() error {
	return setupError{"node_setup_required", "Initialize the node to apply its selected workspace Agent and current configuration"}
}

func (a *App) workspaceAgentAdmissionError(w http.ResponseWriter, err error) {
	var input setupError
	if errors.As(err, &input) {
		status := http.StatusBadRequest
		if input.code == "node_setup_required" {
			status = http.StatusConflict
		}
		fail(w, status, input.code, input.message)
	} else if noRows(err) {
		fail(w, http.StatusNotFound, "not_found", "Node session not found in workspace")
	} else {
		a.dbError(w, err)
	}
}

func savedWorkspaceAgentReference(document json.RawMessage, nodeID string) (*workspaceAgentReference, error) {
	var doc struct {
		Nodes []struct {
			ID       string          `json:"id"`
			AgentRef json.RawMessage `json:"agentRef"`
			Team     json.RawMessage `json:"team"`
		} `json:"nodes"`
	}
	if json.Unmarshal(document, &doc) != nil {
		return nil, invalidSetup("Invalid saved canvas")
	}
	for _, node := range doc.Nodes {
		if node.ID != nodeID {
			continue
		}
		ref, err := parseWorkspaceAgentReference(node.AgentRef)
		if err != nil || ref == nil {
			return nil, err
		}
		if len(node.Team) != 0 && string(node.Team) != "null" {
			return nil, invalidSetup("An existing workspace Agent cannot be replaced by an inline team")
		}
		return ref, nil
	}
	return nil, nil // Internal planner sessions do not have a canvas node.
}

// Initialization snapshots the definition used by this conversation. A later
// shared Agent edit (or detach) must fork through initialize before admission,
// including direct API callers and edits between UI initialization and running.
// The caller holds the tenant mutation lock, also used by Agent updates.
func validateWorkspaceAgentSession(ctx context.Context, tx pgx.Tx, tid, sid, nodeID string, document json.RawMessage, execution executionSnapshot) error {
	ref, err := savedWorkspaceAgentReference(document, nodeID)
	if err != nil {
		return err
	}
	if sid == "" {
		if ref != nil {
			return workspaceAgentSetupRequired()
		}
		return nil
	}
	var raw json.RawMessage
	var name, agentID string
	err = tx.QueryRow(ctx, "SELECT s.setup_snapshot,a.name,a.id FROM node_sessions s JOIN agents a ON a.tenant_id=s.tenant_id AND a.id=s.agent_id WHERE s.tenant_id=$1 AND s.id=$2", tid, sid).Scan(&raw, &name, &agentID)
	if err != nil {
		return err
	}
	var prior setupConfiguration
	if len(raw) > 0 && json.Unmarshal(raw, &prior) != nil {
		return workspaceAgentSetupRequired()
	}
	if ref == nil && prior.AgentRef == nil {
		return nil // Preserve the legacy/custom Agent execution contract.
	}
	if ref == nil || prior.AgentRef == nil || *ref != *prior.AgentRef || ref.AgentID != agentID || prior.Name != name || prior.Runtime != execution.Runtime || prior.Model != execution.Model || prior.Effort != execution.Effort || prior.Persona != execution.Instructions {
		return workspaceAgentSetupRequired()
	}
	return nil
}
