package app

import "net/http"

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
	writeJSON(w, 200, map[string]any{
		"skills":        map[string]any{"enabled": true, "maxNodeSkills": maxNodeSkills, "maxNodeSkillBytes": maxNodeSkillBytes},
		"skillRegistry": map[string]any{"enabled": a.cfg.SkillRegistryEnabled, "source": "skills.sh"},
		"memory":        map[string]any{"enabled": true, "maxRunItems": maxMemoryRunItems, "maxRunBytes": maxMemoryRunBytes, "maxPerScope": maxMemoryPerScope},
		"webReader":     map[string]any{"enabled": a.cfg.WebReaderEnabled, "perDay": a.cfg.WebReadsPerDay, "usedToday": reads},
		"render": map[string]any{"enabled": a.cfg.RenderURL != "", "perDay": a.cfg.RendersPerDay, "usedToday": renders,
			"limits": map[string]any{"maxSeconds": maxRenderSeconds, "maxFps": 60, "maxWidth": 1920, "maxHeight": 1920, "maxFrames": maxRenderFrames, "maxHtmlBytes": maxRenderHTMLBytes}},
		// Edit nodes (edits.go) render on the same worker.
		"edit": map[string]any{"enabled": a.cfg.RenderURL != "", "perDay": editsPerDay, "usedToday": edits,
			"limits": map[string]any{"maxSeconds": 1200, "maxFiles": maxEditFiles, "maxTimelineBytes": maxEditTimelineBytes}},
	})
}

func (a *App) registerCapabilityRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/tenants/{tenantId}/capabilities", a.tenant(a.capabilities, 1))
	m.HandleFunc("POST /api/v1/tenants/{tenantId}/knowledge/sources/web", a.tenant(a.importWebSource, 2))
}
