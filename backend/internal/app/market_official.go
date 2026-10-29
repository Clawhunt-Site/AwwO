package app

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"strings"
)

// AwwO's own Agents in the market: the 39 MIT-licensed roles of wshobson/agents that the web app already bundles
// (market_official.json is apps/web/src/canvas/team-market-agents.wshobson.json byte for byte, which
// TestMarketOfficialRolesAreTheWebAppsOwn checks; THIRD_PARTY_NOTICES.md and third_party/wshobson-agents carry the
// licence). They are free, their instructions are public (as they are in the web app), and they are listed when the
// market opens, so it does not open empty. The bundle's company roles are left out: they are written for a company of
// Agents that delegate to each other, not for one canvas node.

//go:embed market_official.json
var marketOfficialFile []byte

type marketOfficialRole struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	DescriptionZh string `json:"descriptionZh"`
	Instructions  string `json:"instructions"`
	Source        struct {
		TeamID string `json:"teamId"`
	} `json:"source"`
}

const marketOfficialAttribution = "来源：wshobson/agents（MIT License，Copyright (c) 2024 Seth Hobson）。From wshobson/agents (MIT License, Copyright (c) 2024 Seth Hobson)."

// marketOfficialCategory places a role in a market category by its team, and a few by what they write.
func marketOfficialCategory(team, slug string) string {
	switch {
	case slug == "tutorial-engineer":
		return "education"
	case slug == "data-scientist" || slug == "prompt-engineer":
		return "research"
	case strings.Contains(slug, "content"):
		return "writing"
	}
	switch team {
	case "wshobson:business", "wshobson:growth":
		return "business"
	case "wshobson:design":
		return "design"
	case "wshobson:docs":
		return "writing"
	}
	return "code"
}

// stripRoleFrontmatter is a role file's body: the instructions after its YAML header.
func stripRoleFrontmatter(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	if rest, ok := strings.CutPrefix(text, "---\n"); ok {
		if end := strings.Index(rest, "\n---\n"); end >= 0 {
			text = rest[end+len("\n---\n"):]
		}
	}
	return strings.TrimSpace(text) + "\n"
}

// marketOfficialVersions are the official Agents as first versions, by Agent id.
func marketOfficialVersions() (map[string]marketVersion, []string, error) {
	var file struct {
		Agents []marketOfficialRole `json:"agents"`
	}
	if err := json.Unmarshal(marketOfficialFile, &file); err != nil {
		return nil, nil, err
	}
	out, order := map[string]marketVersion{}, []string{}
	for _, role := range file.Agents {
		parts := strings.Split(role.ID, ":")
		slug := parts[len(parts)-1]
		if len(parts) != 3 || parts[0] != "wshobson" || !skillNamePattern.MatchString(slug) {
			return nil, nil, errors.New("an official role has an unexpected id: " + role.ID)
		}
		id := "official-" + slug
		if _, dup := out[id]; dup {
			return nil, nil, errors.New("two official roles share a name: " + slug)
		}
		description := strings.TrimSpace(role.Description) + "\n\n" + marketOfficialAttribution
		in := marketDraftInput{Name: role.Name, Tagline: role.DescriptionZh, Description: description, Category: marketOfficialCategory(role.Source.TeamID, slug),
			Kind: "llm", Instructions: stripRoleFrontmatter(role.Instructions), InstructionsPublic: true}
		v, _, err := in.validate(0)
		if err != nil {
			return nil, nil, errors.New(role.ID + ": " + err.Error())
		}
		v.Skills = []marketSkill{}
		v.ContentHash = marketContentHash(v)
		v.AgentID, v.Version, v.State = id, 1, "approved"
		out[id] = v
		order = append(order, id)
	}
	return out, order, nil
}

// seedOfficialMarketAgents lists the official Agents that are not in the market yet. One already there, suspended or
// not, is left as it is.
func (a *App) seedOfficialMarketAgents(ctx context.Context) error {
	versions, order, err := marketOfficialVersions()
	if err != nil {
		return err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	for _, id := range order {
		v := versions[id]
		tag, err := tx.Exec(ctx, "INSERT INTO market_agents(id,official,status,listed_version,listed_at) VALUES($1,true,'listed',1,clock_timestamp()) ON CONFLICT (id) DO NOTHING", id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			continue
		}
		if err = insertMarketVersion(ctx, tx, id, 1, v); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "UPDATE market_agent_versions SET state='approved',reviewed_at=clock_timestamp(),review_note='AwwO official' WHERE agent_id=$1 AND version=1", id); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
