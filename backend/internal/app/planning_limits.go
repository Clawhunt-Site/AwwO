package app

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// maxPlannerLimitModels bounds how many models the planner's node limits name: more than a workspace's allowlist may
	// hold (maxAllowedModels), so a list is cut only where unrestricted worker catalogs are that large.
	maxPlannerLimitModels = 100
	// maxCompactLimitModels bounds the models below the default that the limits name in a few words.
	maxCompactLimitModels = 12
	// plannerAssumedLimit is what the planner's instructions assume one answer holds where they are told no limit
	// ("assume 16,000 tokens"): a worker that offers a model without saying its limit counts as that much for it, and
	// the limits then say so (assumedNote).
	plannerAssumedLimit = 16000
	assumedNote         = "taken as 16,000 where a worker offering the model gives none"
)

// plannerNodeLimits is the part of a plan request that tells the canvas planner how much one node's run can deliver
// (plannerInstructions sizes each node's task by it and splits a larger one), found 2026-10-22: 17 of the 26 canvas
// nodes that failed in three days had answers longer than their model's output limit, which the planner was never told.
// It names each model the workspace may run a node on with the most one answer of it holds, in output tokens with its
// thinking included, as its workers call it now: the least of openai-agents and Pi where both offer it, since AwwO runs
// a node on openai-agents where that offers the model (apps/web canvas/nodeRuntime.ts automaticEntry) but a node bound
// to a workspace Agent keeps that Agent's runtime (today both give each model the same limit), a worker that offers it
// without saying counting as plannerAssumedLimit, so no model is sized past what is known of it; the workspace default,
// which a node without a model runs on ("default", openai-agents' own: a node with no runtime is set up there,
// node_setup.go); the least of the models it does not name, as the limit to take for each of them; and the run's time
// limit. The page names the model the nodes a plan adds take (canvasPlanning.ts newNodeModel). compact is the same in a
// few words, for a prompt the whole would take past a bound: the default, also under its own id, the models whose limit
// is lower, and the least of every other one. Empty when no worker says any limit, so a plan is made as before; it
// never fails a plan. With
// personal model connections it names none: their limits are the user's providers', which no worker publishes. Only
// called once the request is authorized: it calls the workers.
func (a *App) plannerNodeLimits(ctx context.Context, tid string) (full, compact string) {
	if a.cfg.UserCredentials {
		return "", ""
	}
	entitlement, err := tenantModelEntitlement(ctx, a.db, tid)
	if err != nil {
		return "", ""
	}
	runtimes := []string{runtimeOpenAIAgents, runtimePI}
	healths, found := make([]piHealth, len(runtimes)), make([]bool, len(runtimes))
	var wg sync.WaitGroup
	for i, runtime := range runtimes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if h, err := a.probeRuntime(ctx, runtime); err == nil {
				healths[i], found[i] = entitlement.apply(h), true
			}
		}()
	}
	wg.Wait()
	limits, order, fallback := map[string]int{}, []string{}, ""
	said, assumed := false, false
	if found[0] {
		fallback = healths[0].defaultModel()
	}
	for i := range runtimes {
		if !found[i] {
			continue
		}
		for _, m := range healths[i].Models {
			if m.ID == "default" {
				continue
			}
			n := m.MaxOutputTokens
			if n > 0 {
				said = true
			} else {
				n, assumed = plannerAssumedLimit, true
			}
			if known, seen := limits[m.ID]; seen {
				limits[m.ID] = min(known, n)
			} else {
				order, limits[m.ID] = append(order, m.ID), n
			}
		}
	}
	if !said {
		return "", ""
	}
	ends := ""
	if a.cfg.RunTimeout > 0 {
		ends = " A node's run also ends after at most " + durationText(a.cfg.RunTimeout) + "."
	}
	notes, taken := []string{}, ""
	if assumed {
		notes, taken = append(notes, assumedNote), " ("+assumedNote+")"
	}
	limit, hasDefault := limits[fallback]
	// The whole: the default and the first models, and the least of those it leaves out.
	named := order[:min(len(order), maxPlannerLimitModels)]
	head := []string{}
	if hasDefault {
		head, notes = []string{limitEntry("default", limit)}, append(notes, "\"default\" is the model a node without one runs on")
	}
	explained := ""
	if len(notes) > 0 {
		explained = " (" + strings.Join(notes, "; ") + ")"
	}
	full = "\n\nNode limits: the most one answer of each model holds, in output tokens with the model's thinking included, as its workers call it now" +
		explained + ": " + limitsObject(head, named, limits) + "." + leastOfOthers(order[len(named):], limits) + ends
	// In a few words: the default and the models whose limit is lower (the smallest of them where there are many), or
	// with no default the least of all.
	if !hasDefault {
		compact = "\n\nNode limits, shortened to fit: take every model's limit as " + strconv.Itoa(leastOf(order, limits)) +
			" output tokens, with the model's thinking included." + ends
		return full, compact
	}
	below := []string{}
	for _, id := range order {
		if limits[id] < limit {
			below = append(below, id)
		}
	}
	slices.SortStableFunc(below, func(x, y string) int { return limits[x] - limits[y] })
	shown := below[:min(len(below), maxCompactLimitModels)]
	others := slices.DeleteFunc(slices.Clone(order), func(id string) bool { return id == fallback || slices.Contains(shown, id) })
	head = append(head, limitEntry(fallback, limit))
	compact = "\n\nNode limits, shortened to fit: the most one answer holds, in output tokens with the model's thinking included" + taken +
		", on the default model (\"default\", the model a node without one runs on) and on the models whose limit is lower: " +
		limitsObject(head, shown, limits) + "." + leastOfOthers(others, limits) + ends
	return full, compact
}

func limitEntry(id string, n int) string {
	k, _ := json.Marshal(id)
	return string(k) + ":" + strconv.Itoa(n)
}

// limitsObject is the JSON object of the head entries and then the models named, by id.
func limitsObject(head, ids []string, limits map[string]int) string {
	entries := append([]string{}, head...)
	for _, id := range ids {
		entries = append(entries, limitEntry(id, limits[id]))
	}
	return "{" + strings.Join(entries, ",") + "}"
}

func leastOf(ids []string, limits map[string]int) int {
	least := limits[ids[0]]
	for _, id := range ids {
		least = min(least, limits[id])
	}
	return least
}

// leastOfOthers says what to take as the limit of a model the limits leave out, the least of those; nothing where they
// leave none out.
func leastOfOthers(ids []string, limits map[string]int) string {
	if len(ids) == 0 {
		return ""
	}
	return " Take every other model's limit as " + strconv.Itoa(leastOf(ids, limits)) + "."
}

// durationText says a time limit in whole minutes, or in whole seconds under a minute.
func durationText(d time.Duration) string {
	n, unit := int(d/time.Minute), "minute"
	if n < 1 {
		n, unit = max(1, int(d/time.Second)), "second"
	}
	if n != 1 {
		unit += "s"
	}
	return strconv.Itoa(n) + " " + unit
}
