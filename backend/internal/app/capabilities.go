package app

import (
	"net/http"
	"time"
)

// capabilities tells the web app which of the optional abilities this server offers a workspace and how much of
// today's allowance is left, so it can show (or hide) skills, the skill registry, memory, web import and video
// rendering honestly.
func (a *App) capabilities(w http.ResponseWriter, r *http.Request) {
	tid := r.PathValue("tenantId")
	reads, renders, edits := 0, 0, 0
	if a.cfg.WebReaderEnabled {
		if err := a.db.QueryRow(r.Context(), "SELECT count(*) FROM web_reads w WHERE w.tenant_id=$1 AND "+webReadsToday, tid).Scan(&reads); err != nil {
			a.dbError(w, err)
			return
		}
	}
	if a.cfg.RenderURL != "" {
		if err := a.db.QueryRow(r.Context(), "SELECT count(*) FROM render_jobs j WHERE j.tenant_id=$1 AND "+renderCountedToday, tid).Scan(&renders); err != nil {
			a.dbError(w, err)
			return
		}
		if err := a.db.QueryRow(r.Context(), "SELECT count(*) FROM edit_jobs WHERE tenant_id=$1 AND "+editCountedToday, tid).Scan(&edits); err != nil {
			a.dbError(w, err)
			return
		}
	}
	editsPerDay, _, _, _ := a.editLimits()
	// A workspace the free plan's end holds has none of the two allowances that call no model (free_plan.go): their
	// daily numbers read 0 here, so a panel offers no read or render that would only be refused.
	webPerDay, rendersPerDay := a.cfg.WebReadsPerDay, a.cfg.RendersPerDay
	if a.cfg.freePlanEnded(time.Now()) {
		plan, err := ownerPlan(r.Context(), a.db, tid, false)
		if err != nil {
			a.dbError(w, err)
			return
		}
		held, err := freePlanHolds(r.Context(), a.db, tid, a.cfg.FreePlanUntil, plan)
		if err != nil {
			a.dbError(w, err)
			return
		}
		if held {
			webPerDay, rendersPerDay = 0, 0
		}
	}
	writeJSON(w, 200, map[string]any{
		"skills":        map[string]any{"enabled": true, "maxNodeSkills": maxNodeSkills, "maxNodeSkillBytes": maxNodeSkillBytes},
		"skillRegistry": map[string]any{"enabled": a.cfg.SkillRegistryEnabled, "source": "skills.sh"},
		"memory":        map[string]any{"enabled": true, "maxRunItems": maxMemoryRunItems, "maxRunBytes": maxMemoryRunBytes, "maxPerScope": maxMemoryPerScope},
		// fit: POST …/knowledge/sources/web cuts a page to its share of a task's quoted knowledge, which reading the pages
		// a message names needs; a page meeting a server without it reads none of them (and sends it no fit).
		// modelReads: a node's model may ask for up to three pages a run (model_web_reads.go), out of the same allowance;
		// modelReadSites says of which sites: "named" (the ones a member named for the run) or "any".
		"webReader": map[string]any{"enabled": a.cfg.WebReaderEnabled, "perDay": webPerDay, "usedToday": reads, "fit": true,
			"modelReads": a.cfg.WebReaderEnabled && a.cfg.ModelWebReads, "modelReadSites": a.cfg.modelReadSites()},
		"render": map[string]any{"enabled": a.cfg.RenderURL != "", "perDay": rendersPerDay, "usedToday": renders,
			"limits": map[string]any{"maxSeconds": maxRenderSeconds, "maxFps": 60, "maxWidth": 1920, "maxHeight": 1920, "maxFrames": maxRenderFrames, "maxHtmlBytes": maxRenderHTMLBytes}},
		// Edit nodes (edits.go) render on the same worker.
		"edit": map[string]any{"enabled": a.cfg.RenderURL != "", "perDay": editsPerDay, "usedToday": edits,
			"limits": map[string]any{"maxSeconds": 1200, "maxFiles": maxEditFiles, "maxTimelineBytes": maxEditTimelineBytes}},
		// The Agent market (market.go).
		"market": a.marketCapability(),
		// 多人同屏 (docs/awwo-canvas-live-collaboration.md): a page saves by changes (PATCH) and opens the canvas's live
		// stream only where this says so; a page reading a server older than it keeps whole-document saves. people: the
		// canvas offers sharing it with people (invitations bound to an email, sent from the canvas; capability_config.go).
		"multiplayer": map[string]any{"enabled": true, "maxChangeOps": maxCanvasChangeOps, "people": a.cfg.PeopleSharing},
	})
}

func (a *App) registerCapabilityRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/capabilities", a.tenant(a.capabilities, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/knowledge/sources/web", a.tenant(a.importWebSource, 2))
}
