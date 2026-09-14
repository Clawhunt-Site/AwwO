package app

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"unicode"
)

// A workspace without a stored list is unrestricted, which is what every
// workspace that exists today is, so the entitlement starts as the identity
// filter. A stored list is authoritative and exhaustive for that workspace: an
// empty one permits nothing rather than everything, so an operator narrowing an
// allowlist can never accidentally widen access.
type modelEntitlement struct{ allowed *[]string }

const maxAllowedModels = 64

var errModelNotAllowed = errors.New("model_not_allowed")
var errMalformedAllowlist = errors.New("workspace model allowlist is malformed")

// A caller that ignores a read failure still holds an entitlement permitting
// nothing, so an unreadable or malformed allowlist cannot fail open.
func deniedModels() modelEntitlement {
	empty := []string{}
	return modelEntitlement{allowed: &empty}
}
func (e modelEntitlement) unrestricted() bool { return e.allowed == nil }
func (e modelEntitlement) permits(model string) bool {
	return e.allowed == nil || permittedModel(*e.allowed, model)
}
func permittedModel(allowed []string, model string) bool {
	for _, id := range allowed {
		if id == model {
			return true
		}
	}
	return false
}

// apply stamps the entitlement onto a probed catalog. Every model decision in
// the kernel — default selection, member resolution, per-turn budget lookup —
// reads a piHealth, so filtering here instead of at each decision is what makes
// a call site enforce the allowlist without having to know it exists.
//
// Stamping only ever removes entries, so re-stamping an already stamped catalog
// with a wider entitlement cannot resurrect a model the first pass dropped. That
// direction is the safe one and it is why a persisted snapshot may be restamped.
func (e modelEntitlement) apply(h piHealth) piHealth {
	h.Allowed = nil
	if e.allowed == nil {
		return h
	}
	models := []piModel{}
	for _, m := range h.Models {
		if e.permits(m.ID) {
			models = append(models, m)
		}
	}
	list := append([]string{}, *e.allowed...)
	h.Models, h.Allowed = models, &list
	return h
}

// column renders the entitlement for the tenants row, where NULL is what "no
// restriction" stores.
func (e modelEntitlement) column() any {
	if e.allowed == nil {
		return nil
	}
	return *e.allowed
}

func (h piHealth) permits(model string) bool {
	return h.Allowed == nil || permittedModel(*h.Allowed, model)
}

// defaultModel is what an empty selection resolves to. An entitlement that excludes the
// worker's own default must not silently fall back to it, so an entitled model is chosen
// instead, and a workspace entitled to nothing resolves to no model at all rather than to
// the house default.
//
// The substitute is taken in allowlist order rather than in the order the worker happened
// to advertise, because the worker's order is not ours to depend on: two admissions of the
// same workspace would otherwise resolve to different models if a worker reordered its
// catalog, with nothing visible to the operator. The list is canonically ordered both on
// write and on read, so this is stable even for a row written outside the API, and it is
// the operator's own list rather than the provider's.
func (h piHealth) defaultModel() string {
	if h.Allowed == nil || h.permits(h.Model) {
		return h.Model
	}
	for _, id := range *h.Allowed {
		for _, m := range h.Models {
			if m.ID == id {
				return id
			}
		}
	}
	return ""
}

// validModelID mirrors what probeRuntime accepts from a worker (any non-empty id
// up to 200 bytes) rather than one worker's narrower profile grammar, minus the
// characters that cannot be an id and would make the database's joined-text
// check ambiguous.
func validModelID(id string) bool {
	if id == "" || len(id) > 200 {
		return false
	}
	for _, r := range id {
		if r == ',' || unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func newModelEntitlement(restricted bool, allowed []string) (modelEntitlement, error) {
	if !restricted {
		return modelEntitlement{}, nil
	}
	if len(allowed) > maxAllowedModels {
		return deniedModels(), errMalformedAllowlist
	}
	list := make([]string, 0, len(allowed))
	for _, id := range allowed {
		if !validModelID(id) {
			return deniedModels(), errMalformedAllowlist
		}
		list = append(list, id)
	}
	// Canonical order here, not only in the admin normalizer: a substitute default is taken
	// in this order, and a row written by anything other than the API would otherwise make
	// that choice depend on how the array happened to be stored.
	sort.Strings(list)
	return modelEntitlement{allowed: &list}, nil
}

// tenantModelEntitlement is the only read of a workspace allowlist. Every model
// decision resolves through the piHealth this stamps, so introducing a second
// reader is the only way a future call site could bypass the allowlist.
func tenantModelEntitlement(ctx context.Context, q querier, tid string) (modelEntitlement, error) {
	var restricted bool
	var allowed []string
	if e := q.QueryRow(ctx, "SELECT allowed_models IS NOT NULL,COALESCE(allowed_models,'{}') FROM tenants WHERE id=$1", tid).Scan(&restricted, &allowed); e != nil {
		return deniedModels(), e
	}
	return newModelEntitlement(restricted, allowed)
}

// A graph node freezes its snapshot when the graph is admitted, so the catalog it
// carries can outlive the entitlement that produced it. Re-stamping from the live
// row before a child run is created is what stops an already pinned model, and
// refusing rather than reporting a capacity wait is what settles the node as
// failed instead of retrying it forever.
func (s *executionSnapshot) restamp(e modelEntitlement) error {
	s.Health = e.apply(s.Health)
	for runtime, h := range s.RuntimeHealth {
		s.RuntimeHealth[runtime] = e.apply(h)
	}
	if e.unrestricted() {
		return nil
	}
	if _, _, ok := s.Health.modelLimits(s.Model); !ok {
		return errModelNotAllowed
	}
	if s.Team == nil {
		return nil
	}
	for _, m := range s.Team.Members {
		h, ok := s.memberHealth(memberRuntime(s.Team, m))
		if !ok {
			return errModelNotAllowed
		}
		if _, _, ok := h.modelLimits(m.Model); !ok {
			return errModelNotAllowed
		}
	}
	return nil
}

// Storing a model on an Agent is authorization, not availability: it is checked
// against the workspace entitlement alone, so a worker outage never blocks an
// edit and run admission stays the only place that proves a model exists.
func requireEntitledModel(ctx context.Context, q querier, tid, model string) error {
	if model == "" {
		return nil
	}
	e, err := tenantModelEntitlement(ctx, q, tid)
	if err != nil {
		return err
	}
	if !e.permits(model) {
		return setupError{"model_not_allowed", "This model is not available to this workspace"}
	}
	return nil
}

// A *[]string cannot tell "field absent" from an explicit null and the operator
// needs both, so the admin request keeps the raw JSON: absent leaves the
// entitlement alone, null removes the restriction, an array replaces it.
func normalizeAllowedModels(raw json.RawMessage) (modelEntitlement, bool, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return modelEntitlement{}, false, nil
	}
	if trimmed == "null" {
		return modelEntitlement{}, true, nil
	}
	var ids []string
	if json.Unmarshal(raw, &ids) != nil || ids == nil {
		return deniedModels(), false, errors.New("allowedModels must be null or an array of model ids")
	}
	if len(ids) > maxAllowedModels {
		return deniedModels(), false, errors.New("allowedModels accepts at most 64 model ids")
	}
	seen := map[string]bool{}
	list := []string{}
	for _, id := range ids {
		if !validModelID(id) {
			return deniedModels(), false, errors.New("allowedModels entries must be worker model ids without whitespace or commas")
		}
		if !seen[id] {
			seen[id], list = true, append(list, id)
		}
	}
	sort.Strings(list)
	return modelEntitlement{allowed: &list}, true, nil
}
