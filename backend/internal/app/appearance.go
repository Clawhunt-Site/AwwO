package app

import (
	"context"
	_ "embed"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

// The catalog preserves the original frontend's appearance contract and presets
// from packages/superclaw/src/superclaw/appearance.py. SaaS persistence is per user.
//
//go:embed appearance_catalog.json
var appearanceCatalog []byte

type appearanceState struct {
	ActivePreset string                       `json:"active_preset"`
	Custom       map[string]map[string]string `json:"custom"`
	Version      int                          `json:"version"`
}

func emptyAppearance() appearanceState {
	return appearanceState{ActivePreset: "default", Custom: map[string]map[string]string{"light": {}, "dark": {}}}
}

func (a *App) readAppearance(ctx context.Context, uid string) (appearanceState, error) {
	state := emptyAppearance()
	var custom []byte
	err := a.db.QueryRow(ctx, "SELECT active_preset,custom,version FROM user_appearance WHERE user_id=$1", uid).Scan(&state.ActivePreset, &custom, &state.Version)
	if noRows(err) {
		return emptyAppearance(), nil
	}
	if err != nil {
		return state, err
	}
	err = json.Unmarshal(custom, &state.Custom)
	return state, err
}

func appearancePayload(state appearanceState) map[string]any {
	var payload map[string]any
	// Embedded, checked-in JSON; decode a fresh copy to keep request state isolated.
	if err := json.Unmarshal(appearanceCatalog, &payload); err != nil {
		panic(err)
	}
	payload["active_preset"] = state.ActivePreset
	payload["custom"] = state.Custom
	payload["version"] = state.Version
	return payload
}

func (a *App) appearance(w http.ResponseWriter, r *http.Request) {
	state, err := a.readAppearance(r.Context(), currentUser(r).ID)
	if err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, appearancePayload(state))
}

var appearanceHex = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)

func validAppearance(state *appearanceState) bool {
	if state.Version < 0 || state.Version >= 2147483647 || len(state.Custom) != 2 || state.Custom["light"] == nil || state.Custom["dark"] == nil {
		return false
	}
	var catalog struct {
		Tokens []struct {
			ID string `json:"id"`
		}
		Presets []struct {
			ID string `json:"id"`
		}
	}
	if json.Unmarshal(appearanceCatalog, &catalog) != nil {
		return false
	}
	found := state.ActivePreset == "custom"
	for _, p := range catalog.Presets {
		found = found || p.ID == state.ActivePreset
	}
	if !found {
		return false
	}
	tokens := map[string]bool{}
	for _, t := range catalog.Tokens {
		tokens[t.ID] = true
	}
	for _, colors := range state.Custom {
		for token, color := range colors {
			if !tokens[token] || !appearanceHex.MatchString(color) {
				return false
			}
			color = strings.ToLower(color)
			if len(color) == 4 {
				color = "#" + strings.Repeat(color[1:2], 2) + strings.Repeat(color[2:3], 2) + strings.Repeat(color[3:4], 2)
			}
			colors[token] = color
		}
	}
	return true
}

func (a *App) updateAppearance(w http.ResponseWriter, r *http.Request) {
	// Pointer version distinguishes a deliberate initial write from an omitted CAS.
	var body struct {
		ActivePreset string                       `json:"active_preset"`
		Custom       map[string]map[string]string `json:"custom"`
		Version      *int                         `json:"version"`
	}
	if !a.decode(w, r, &body) {
		return
	}
	state := appearanceState{ActivePreset: body.ActivePreset, Custom: body.Custom}
	if body.Version != nil {
		state.Version = *body.Version
	}
	if body.Version == nil || !validAppearance(&state) {
		fail(w, 400, "invalid_appearance", "Invalid color scheme or version")
		return
	}
	custom, _ := json.Marshal(state.Custom)
	var err error
	if state.Version == 0 {
		err = a.db.QueryRow(r.Context(), `INSERT INTO user_appearance(user_id,active_preset,custom,version) VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING RETURNING version`, currentUser(r).ID, state.ActivePreset, custom).Scan(&state.Version)
	} else {
		err = a.db.QueryRow(r.Context(), `UPDATE user_appearance SET active_preset=$2,custom=$3,version=version+1 WHERE user_id=$1 AND version=$4 RETURNING version`, currentUser(r).ID, state.ActivePreset, custom, state.Version).Scan(&state.Version)
	}
	if noRows(err) {
		fail(w, 409, "version_conflict", "Color scheme changed elsewhere. Reload before saving.")
		return
	}
	if err != nil {
		a.dbError(w, err)
		return
	}
	writeJSON(w, 200, appearancePayload(state))
}

func (a *App) exportAppearance(w http.ResponseWriter, r *http.Request) {
	state, err := a.readAppearance(r.Context(), currentUser(r).ID)
	if err != nil {
		a.dbError(w, err)
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="awwo-appearance.json"`)
	writeJSON(w, 200, map[string]any{"kind": "superclaw.appearance", "schema_version": "0.1.0", "active_preset": state.ActivePreset, "custom": state.Custom})
}
