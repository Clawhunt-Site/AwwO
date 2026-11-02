package app

import (
	"context"
	"net/http"
	"strconv"
	"time"
)

// The prompt cache by path, for platform admins (the 2026-10-31 plan's 2.8: 持续监控): how much of each path's prompts
// the provider's cache read and wrote, this window beside the one before, so that a change to a prompt that breaks
// its cache shows as a share that fell. A path is a runtime, the kind of session its runs belong to (a canvas node, the
// planner, managed execution…) and the model. Counts only: no workspace, run or text.

const (
	// A path is marked falling when its read share fell by promptCacheAlertDrop or more against the window before, both
	// windows with at least promptCacheAlertCalls calls whose cache read is known.
	promptCacheAlertDrop  = 0.2
	promptCacheAlertCalls = 20
	// The view lists at most this many paths, the ones that sent the most prompt tokens first.
	promptCacheMaxPaths = 50
)

// adminPromptCache answers ?days= (1 to 30, 7 unless given). For each path it gives the calls with known usage in the
// last days, and how many of them had their cache read reported. It gives their prompt, cache-read, cache-write and
// output tokens, as decimal strings as the usage API gives them. It gives the read share, cache read over the prompt
// tokens of the calls whose cache read is known (rounded to 4 places), for both windows, and whether the path is
// falling, judged exactly.
func (a *App) adminPromptCache(w http.ResponseWriter, r *http.Request) {
	days := 7
	if values, given := r.URL.Query()["days"]; given {
		n, err := strconv.Atoi(values[0])
		if len(values) != 1 || err != nil || n < 1 || n > 30 {
			usageFailure(w, r, 400, "invalid_input", "days must be one whole number from 1 to 30", nil)
			return
		}
		days = n
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	tx, e := a.usageTransaction(ctx, false)
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	defer tx.Rollback(ctx)
	var asOf time.Time
	if e = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&asOf); e != nil {
		usageUnavailable(w, r)
		return
	}
	// A call's cache read is known when its provider reported it: one that did not (NULL) counts in the path's calls and
	// tokens but not in its read share, which would otherwise read it as nothing read. Falling compares the two windows'
	// shares exactly, by cross products of their sums: share <= share before - drop.
	paths, e := rowsJSON(ctx, tx, `WITH calls AS (SELECT i.runtime,COALESCE(s.kind,'') AS kind,i.model_id AS model,i.created_at>=$1::timestamptz-$2::int*interval '1 day' AS recent,
			i.input_tokens,i.cached_input_tokens,i.cache_write_tokens,i.output_tokens
		FROM model_invocations i LEFT JOIN runs r ON r.tenant_id=i.tenant_id AND r.id=i.run_id LEFT JOIN node_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id
		WHERE i.created_at>=$1::timestamptz-2*$2::int*interval '1 day' AND i.created_at<$1::timestamptz AND i.usage_status IN ('reported','partial') AND i.input_tokens IS NOT NULL),
	paths AS (SELECT runtime,kind,model,
			count(*) FILTER (WHERE recent) AS calls,sum(input_tokens) FILTER (WHERE recent) AS input,sum(cached_input_tokens) FILTER (WHERE recent) AS cached,
			sum(cache_write_tokens) FILTER (WHERE recent) AS written,sum(output_tokens) FILTER (WHERE recent) AS output,
			count(*) FILTER (WHERE recent AND cached_input_tokens IS NOT NULL) AS known,
			sum(input_tokens) FILTER (WHERE recent AND cached_input_tokens IS NOT NULL) AS known_input,
			count(*) FILTER (WHERE NOT recent) AS before_calls,count(*) FILTER (WHERE NOT recent AND cached_input_tokens IS NOT NULL) AS before_known,
			sum(input_tokens) FILTER (WHERE NOT recent AND cached_input_tokens IS NOT NULL) AS before_input,sum(cached_input_tokens) FILTER (WHERE NOT recent) AS before_cached
		FROM calls GROUP BY runtime,kind,model)
	SELECT jsonb_build_object('runtime',runtime,'kind',kind,'model',model,'calls',calls,'cacheKnownCalls',known,'inputTokens',input::text,'cachedInputTokens',cached::text,
		'cacheWriteTokens',written::text,'outputTokens',output::text,'readShare',round(cached/NULLIF(known_input,0),4),
		'previous',jsonb_build_object('calls',before_calls,'cacheKnownCalls',before_known,'readShare',round(before_cached/NULLIF(before_input,0),4)),
		'falling',known>=$3 AND before_known>=$3 AND known_input>0 AND before_input>0 AND cached*before_input<=(before_cached-$4::numeric*before_input)*known_input)
	FROM paths WHERE calls>0 ORDER BY input DESC NULLS LAST,runtime,kind,model LIMIT $5`,
		asOf, days, promptCacheAlertCalls, strconv.FormatFloat(promptCacheAlertDrop, 'f', -1, 64), promptCacheMaxPaths)
	if e != nil {
		usageUnavailable(w, r)
		return
	}
	writeJSON(w, 200, map[string]any{"days": days, "asOf": asOf.UTC(), "alert": map[string]any{"drop": promptCacheAlertDrop, "calls": promptCacheAlertCalls}, "paths": paths})
}
