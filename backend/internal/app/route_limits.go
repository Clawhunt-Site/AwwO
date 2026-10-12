package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Route limits are small daily allowances per paid model route, inside a workspace's daily
// allowance. They let a free workspace try premium models a few times a day without being able to
// spend its whole day on them, while the operator's self-hosted default model stays on the
// ordinary daily allowance alone.
//
// The route is derived from the model id at admission, the last gate before a paid call:
//   - media: image and video generations (rh.*), admitted on their own path
//   - bedrock: models billed per token by Amazon Bedrock (bedrock.*)
//   - gate: every other text model, except the free list (AWWO_ROUTE_FREE_MODELS)
//
// A workspace without route limits (NULL, every workspace created before the setting existed) is
// never route-limited and is not counted against the deployment-wide route ceilings. An empty object
// limits no route either and is not counted, but keeps the workspace on paid plans: the operator's own
// unlimited workspaces. Every other route-limited workspace is held by every route's ceiling and counted
// towards it, a route it does not limit included. Every count starts at UTC midnight, like the daily
// allowance the limits sit inside.
//
// The free default models have no route of their own and no per-workspace limit besides the daily allowance,
// but AWWO_FREE_MODEL_TOTAL_PER_DAY can give them a deployment-wide daily ceiling across the same workspaces the
// route ceilings hold (checkFreeModelCeiling). Unset or 0 sets none.
const (
	routeFree    = "free"
	routeGate    = "gate"
	routeBedrock = "bedrock"
	routeMedia   = "media"
)

var errRouteQuota = errors.New("premium_quota_exceeded")
var errRouteCapacity = errors.New("premium_capacity_exceeded")
var errFreeCapacity = errors.New("free_capacity_exceeded")

// routeLimits maps a route to its daily allowance. A route that is absent is not limited; 0 closes it.
type routeLimits map[string]int

const (
	maxRouteLimit = 100000
	maxRouteTotal = 1000000
)

// parseRouteSetting reads the env grammar "gate=3,bedrock=1,media=1".
func parseRouteSetting(name, raw string, max int) (routeLimits, error) {
	bad := fmt.Errorf("%s must be comma-separated route=count pairs for the routes gate, bedrock and media, each count between 0 and %d", name, max)
	out := routeLimits{}
	for _, part := range strings.Split(raw, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		n, err := strconv.Atoi(value)
		if !ok || err != nil || n < 0 || n > max || !validRoute(key) {
			return nil, bad
		}
		if _, dup := out[key]; dup {
			return nil, bad
		}
		out[key] = n
	}
	return out, nil
}

func validRoute(r string) bool { return r == routeGate || r == routeBedrock || r == routeMedia }

// normalizeRouteLimits is the admin PATCH grammar: absent leaves the column alone, null removes the
// limits, and an object of route counts replaces them; an empty object keeps the workspace
// route-limited, and so on plans, with no route limited. Unknown routes, non-integers and values out
// of range are refused rather than dropped, so a typo cannot silently lift a limit.
func normalizeRouteLimits(raw json.RawMessage) (routeLimits, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	if string(bytes.TrimSpace(raw)) == "null" {
		return nil, true, nil
	}
	var in map[string]json.RawMessage
	if err := json.Unmarshal(raw, &in); err != nil || in == nil || !uniquePricingKeys(json.NewDecoder(bytes.NewReader(raw)), 0) {
		return nil, false, errors.New("routeLimits must be null or an object of route counts")
	}
	out := routeLimits{}
	for k, v := range in {
		// Only a JSON integer literal: a quoted number or a fraction is a mistake, not a count.
		literal := string(bytes.TrimSpace(v))
		n, err := strconv.Atoi(literal)
		if !pricingInteger.MatchString(literal) || err != nil || n > maxRouteLimit || !validRoute(k) {
			return nil, false, fmt.Errorf("routeLimits takes the routes gate, bedrock and media, each a whole number between 0 and %d", maxRouteLimit)
		}
		out[k] = n
	}
	return out, true, nil
}

// column is the jsonb value stored on a tenants row, or nil for NULL.
func (l routeLimits) column() any {
	if l == nil {
		return nil
	}
	b, _ := json.Marshal(l) // map keys marshal in sorted order
	return string(b)
}

// readRouteLimits decodes a stored column. A stored value this build cannot read limits every route
// to zero, so a damaged row costs a free workspace its premium calls rather than lifting its limits;
// so does an object that names routes but none this build knows, which would otherwise read as the
// empty object, unlimited and outside the ceilings.
func readRouteLimits(raw []byte) routeLimits {
	if raw == nil {
		return nil
	}
	closed := routeLimits{routeGate: 0, routeBedrock: 0, routeMedia: 0}
	out := routeLimits{}
	var in map[string]int
	// A JSON null decodes to a nil map: closed too, never the empty object (the column's check refuses one anyway).
	if json.Unmarshal(raw, &in) != nil || in == nil {
		return closed
	}
	for k, v := range in {
		if validRoute(k) {
			out[k] = v
		}
	}
	if len(in) > 0 && len(out) == 0 {
		return closed
	}
	return out
}

// noRouteLimited is the SQL test for a stored empty object, the one route-limited value that no
// ceiling holds or counts.
const noRouteLimited = `t.route_limits = '{}'::jsonb`

func (c *Config) routeSettingsFromEnv() error {
	if raw := os.Getenv("AWWO_NEW_WORKSPACE_ROUTE_LIMITS"); raw != "" {
		l, err := parseRouteSetting("AWWO_NEW_WORKSPACE_ROUTE_LIMITS", raw, maxRouteLimit)
		if err != nil {
			return err
		}
		c.NewWorkspaceRouteLimits = l
	}
	if raw := os.Getenv("AWWO_ROUTE_TOTAL_PER_DAY"); raw != "" {
		l, err := parseRouteSetting("AWWO_ROUTE_TOTAL_PER_DAY", raw, maxRouteTotal)
		if err != nil {
			return err
		}
		c.RouteTotalsPerDay = l
	}
	if raw := os.Getenv("AWWO_FREE_MODEL_TOTAL_PER_DAY"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 || n > maxRouteTotal {
			return fmt.Errorf("AWWO_FREE_MODEL_TOTAL_PER_DAY must be a whole number from 0 (no ceiling) to %d", maxRouteTotal)
		}
		c.FreeModelTotalPerDay = n
	}
	if raw := os.Getenv("AWWO_ROUTE_FREE_MODELS"); raw != "" {
		models, err := newWorkspaceModels(raw)
		if err != nil {
			return errors.New("AWWO_ROUTE_FREE_MODELS must be 1 to 64 comma-separated model ids of at most 200 bytes, without whitespace or control characters")
		}
		list, _ := models.column().([]string)
		c.RouteFreeModels = append([]string{}, list...)
		sort.Strings(c.RouteFreeModels)
	}
	return nil
}

// Route limits name worker model ids, which personal catalogues replace with per-connection ids,
// and a gate limit without a free list would put the default model itself on the premium allowance.
func (c Config) validateRouteSettings() error {
	if (c.NewWorkspaceRouteLimits != nil || c.RouteTotalsPerDay != nil) && c.UserCredentials {
		return errors.New("AWWO_NEW_WORKSPACE_ROUTE_LIMITS and AWWO_ROUTE_TOTAL_PER_DAY require AWWO_CREDENTIAL_MODE=operator")
	}
	_, gated := c.NewWorkspaceRouteLimits[routeGate]
	_, capped := c.RouteTotalsPerDay[routeGate]
	if (gated || capped) && len(c.RouteFreeModels) == 0 {
		return errors.New("a gate route limit or ceiling needs AWWO_ROUTE_FREE_MODELS to name the default model(s) it exempts")
	}
	// The free-model ceiling counts the models of the free list, so without one it would never hold anything.
	if c.FreeModelTotalPerDay > 0 && c.UserCredentials {
		return errors.New("AWWO_FREE_MODEL_TOTAL_PER_DAY requires AWWO_CREDENTIAL_MODE=operator")
	}
	if c.FreeModelTotalPerDay > 0 && len(c.RouteFreeModels) == 0 {
		return errors.New("AWWO_FREE_MODEL_TOTAL_PER_DAY needs AWWO_ROUTE_FREE_MODELS to name the default model(s) it counts")
	}
	return nil
}

func (c Config) modelRoute(model string) string {
	switch {
	case isMediaModelID(model):
		return routeMedia
	case strings.HasPrefix(model, "bedrock."):
		return routeBedrock
	}
	i := sort.SearchStrings(c.RouteFreeModels, model)
	if i < len(c.RouteFreeModels) && c.RouteFreeModels[i] == model {
		return routeFree
	}
	return routeGate
}

// The same classification as checkRouteLimit, over the model ids the ledger stores ($1 is the route and
// $2 the free list). A call that settled without reaching a provider (cost_status not_incurred, for
// example a busy runtime) gives its allowance back; a running one always counts, so concurrent
// admissions cannot pass the limit together. A call admitted under a paid plan (billed_user_id) spent
// credits, not a route allowance, and counts towards neither a workspace's limit nor a ceiling; neither does a
// canvas plan on the operator's planner model, which its own ceilings bound (planner_model.go).
const routeInvocationFilter = `CASE WHEN $1='bedrock' THEN mi.model_id LIKE 'bedrock.%'
	ELSE mi.model_id NOT LIKE 'bedrock.%' AND NOT (mi.model_id = ANY($2::text[])) END
	AND NOT (mi.status<>'running' AND mi.cost_status='not_incurred') AND mi.billed_user_id IS NULL AND NOT ` + operatorPaidRun

const todayUTC = `date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`

// checkRouteLimit runs inside reserveInvocation's transaction, with the workspace row already
// locked, so concurrent calls of one workspace cannot each see room for one more. The
// deployment-wide ceiling takes its own advisory lock for the same reason across workspaces; it is
// taken after the workspace lock, in every caller, so the two can never wait on each other in
// opposite orders.
func (a *App) checkRouteLimit(ctx context.Context, tx pgx.Tx, tid, model string, limits routeLimits) error {
	return a.routeLimit(ctx, tx, tid, model, limits, true)
}

// routeLimit is checkRouteLimit; lock false asks the same question without the ceilings' advisory lock, for a caller
// that only wants to know whether a call would pass now (the vision switch, vision.go). Only a reservation decides.
func (a *App) routeLimit(ctx context.Context, tx pgx.Tx, tid, model string, limits routeLimits, lock bool) error {
	route := a.cfg.modelRoute(model)
	if route == routeFree {
		return a.freeModelCeiling(ctx, tx, limits, lock)
	}
	if route == routeMedia {
		// Generations are admitted on their own path; a text call with such an id is still paid.
		route = routeGate
	}
	limit, limited := limits[route]
	ceiling, capped := a.cfg.RouteTotalsPerDay[route]
	free := a.cfg.RouteFreeModels
	if free == nil {
		free = []string{}
	}
	if limited {
		var used int
		if e := tx.QueryRow(ctx, `SELECT count(*) FROM model_invocations mi WHERE mi.tenant_id=$3 AND mi.created_at>=`+todayUTC+` AND `+routeInvocationFilter, route, free, tid).Scan(&used); e != nil {
			return e
		}
		if used >= limit {
			return errRouteQuota
		}
	}
	// A workspace that limits no route (the empty object) is outside the ceilings, held and counted by none.
	if capped && len(limits) > 0 {
		if lock {
			if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(84321011)"); e != nil {
				return e
			}
		}
		var used int
		if e := tx.QueryRow(ctx, `SELECT count(*) FROM model_invocations mi JOIN tenants t ON t.id=mi.tenant_id WHERE t.route_limits IS NOT NULL AND NOT `+noRouteLimited+` AND mi.created_at>=`+todayUTC+` AND `+routeInvocationFilter, route, free).Scan(&used); e != nil {
			return e
		}
		if used >= ceiling {
			return errRouteCapacity
		}
	}
	return nil
}

// The free default models' calls the free-model ceiling counts ($1 is the free list): the same rules as
// routeInvocationFilter, so a call settled without reaching a provider gives its place back, a call admitted under
// a paid plan (billed_user_id) is the plan's, and a canvas plan on the operator's planner model is the operator's.
const freeInvocationFilter = `mi.model_id = ANY($1::text[])
	AND NOT (mi.status<>'running' AND mi.cost_status='not_incurred') AND mi.billed_user_id IS NULL AND NOT ` + operatorPaidRun

// checkFreeModelCeiling applies AWWO_FREE_MODEL_TOTAL_PER_DAY, the deployment-wide daily ceiling on calls of the free
// default models (0: none). It holds and counts the workspaces the route ceilings hold: every route-limited one but
// the empty object (the operator's own unlimited workspaces); a workspace without route limits is neither. Only free
// admissions reach it: a paid plan's calls take admitPlanInvocation, and the operator's planner calls are admitted
// without route limits (reserveInvocation). It runs where checkRouteLimit runs, under the workspace row lock and once
// a slot is free, and takes the route ceilings' advisory lock, so concurrent calls of different workspaces cannot
// each see room for one more.
func (a *App) checkFreeModelCeiling(ctx context.Context, tx pgx.Tx, limits routeLimits) error {
	return a.freeModelCeiling(ctx, tx, limits, true)
}

// freeModelCeiling is checkFreeModelCeiling; lock false skips the advisory lock (routeLimit).
func (a *App) freeModelCeiling(ctx context.Context, tx pgx.Tx, limits routeLimits, lock bool) error {
	if a.cfg.FreeModelTotalPerDay <= 0 || len(limits) == 0 {
		return nil
	}
	free := a.cfg.RouteFreeModels
	if free == nil {
		free = []string{}
	}
	if lock {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(84321011)"); e != nil {
			return e
		}
	}
	var used int
	if e := tx.QueryRow(ctx, `SELECT count(*) FROM model_invocations mi JOIN tenants t ON t.id=mi.tenant_id WHERE t.route_limits IS NOT NULL AND NOT `+noRouteLimited+` AND mi.created_at>=`+todayUTC+` AND `+freeInvocationFilter, free).Scan(&used); e != nil {
		return e
	}
	if used >= a.cfg.FreeModelTotalPerDay {
		return errFreeCapacity
	}
	return nil
}

// mediaRouteLimit applies a route-limited workspace's media allowance and the deployment-wide media
// route ceiling, which a workspace that limits no route is outside of. It runs under the media
// admission's own advisory lock, after the ordinary media limits, and writes the refusal itself.
func (a *App) mediaRouteLimit(ctx context.Context, tx pgx.Tx, limits routeLimits, usedToday int) (code string, err error) {
	if len(limits) == 0 {
		return "", nil
	}
	if limit, ok := limits[routeMedia]; ok && usedToday >= limit {
		return "media_quota_exceeded", nil
	}
	if ceiling, ok := a.cfg.RouteTotalsPerDay[routeMedia]; ok {
		var used int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM media_generations g JOIN tenants t ON t.id=g.tenant_id WHERE t.route_limits IS NOT NULL AND NOT `+noRouteLimited+` AND g.billed_user_id IS NULL AND g.created_at>=`+todayUTC).Scan(&used); err != nil {
			return "", err
		}
		if used >= ceiling {
			return "media_capacity_exceeded", nil
		}
	}
	return "", nil
}
