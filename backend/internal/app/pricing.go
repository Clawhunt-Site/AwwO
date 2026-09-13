package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

type PricingRates struct {
	Input       *string `json:"input"`
	CachedInput *string `json:"cachedInput"`
	CacheWrite  *string `json:"cacheWrite"`
	Output      *string `json:"output"`
	Reasoning   *string `json:"reasoning"`
}
type PricingSemantics struct {
	CachedInput string `json:"cachedInput"`
	CacheWrite  string `json:"cacheWrite"`
	Reasoning   string `json:"reasoning"`
}
type ModelPrice struct {
	Rates     PricingRates     `json:"ratesMicrousdPerMillion"`
	Semantics PricingSemantics `json:"semantics"`
	Rounding  string           `json:"rounding"`
}
type ModelPricing struct {
	Version  string                `json:"version"`
	Currency string                `json:"currency"`
	Models   map[string]ModelPrice `json:"models"`
}
type PriceSnapshot struct {
	Version    string `json:"version"`
	Currency   string `json:"currency"`
	CatalogKey string `json:"catalogKey"`
	ModelPrice
}

var pricingInteger = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
var pricingCatalogKey = regexp.MustCompile(`^(pi|openai-agents):[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$`)

func strictPricingJSON(raw []byte, dst any) error {
	if !uniquePricingKeys(json.NewDecoder(bytes.NewReader(raw)), 0) {
		return errors.New("invalid model pricing schema")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if e := d.Decode(dst); e != nil {
		return errors.New("invalid model pricing schema")
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("invalid model pricing schema")
	}
	return nil
}

// Ambiguous duplicate properties must not silently select a price/version.
func uniquePricingKeys(d *json.Decoder, depth int) bool {
	if depth > 8 {
		return false
	}
	token, err := d.Token()
	if err != nil {
		return false
	}
	delim, compound := token.(json.Delim)
	if !compound {
		return true
	}
	seen := map[string]bool{}
	for d.More() {
		if delim == '{' {
			key, err := d.Token()
			name, ok := key.(string)
			if err != nil || !ok || seen[name] {
				return false
			}
			seen[name] = true
		}
		if !uniquePricingKeys(d, depth+1) {
			return false
		}
	}
	_, err = d.Token()
	return err == nil
}
func ParseModelPricing(raw string) (*ModelPricing, error) {
	p := &ModelPricing{Models: map[string]ModelPrice{}}
	if strings.TrimSpace(raw) == "" {
		return p, nil
	}
	if len(raw) > 262144 {
		return nil, errors.New("model pricing exceeds size limit")
	}
	if e := strictPricingJSON([]byte(raw), p); e != nil {
		return nil, e
	}
	if len(p.Version) == 0 || len(p.Version) > 100 || p.Currency != "USD" || len(p.Models) > 256 || p.Models == nil {
		return nil, errors.New("invalid model pricing metadata")
	}
	for key, model := range p.Models {
		if !pricingCatalogKey.MatchString(key) {
			return nil, errors.New("invalid pricing catalog key")
		}
		if e := validateModelPrice(model); e != nil {
			return nil, e
		}
	}
	return p, nil
}
func validateModelPrice(p ModelPrice) error {
	bad := errors.New("invalid model pricing rates or semantics")
	for _, rate := range []*string{p.Rates.Input, p.Rates.Output, p.Rates.CachedInput, p.Rates.CacheWrite, p.Rates.Reasoning} {
		if rate != nil {
			if !pricingInteger.MatchString(*rate) {
				return bad
			}
			if _, e := strconv.ParseInt(*rate, 10, 64); e != nil {
				return bad
			}
		}
	}
	switch p.Rounding {
	case "floor_per_component", "ceil_per_component", "half_up_per_component":
	default:
		return bad
	}
	switch p.Semantics.CachedInput {
	case "replace_input_rate_for_subset", "additional_surcharge_on_subset":
		if p.Rates.CachedInput == nil {
			return bad
		}
	case "included_in_input_rate":
		if p.Rates.CachedInput != nil {
			return bad
		}
	default:
		return bad
	}
	switch p.Semantics.CacheWrite {
	case "additional":
		if p.Rates.CacheWrite == nil {
			return bad
		}
	case "included_in_input", "unsupported":
		if p.Rates.CacheWrite != nil {
			return bad
		}
	default:
		return bad
	}
	switch p.Semantics.Reasoning {
	case "additional_surcharge_on_subset":
		if p.Rates.Reasoning == nil {
			return bad
		}
	case "included_in_output", "unsupported":
		if p.Rates.Reasoning != nil {
			return bad
		}
	default:
		return bad
	}
	return nil
}

// Freeze returns only a controlled price schema; provider endpoints and credentials
// can never enter it. Missing catalog prices do not prevent model admission.
func (p *ModelPricing) Freeze(runtime, model string) (string, json.RawMessage) {
	if p == nil {
		return "", nil
	}
	key := runtime + ":" + model
	price, ok := p.Models[key]
	if !ok {
		b, _ := json.Marshal(map[string]string{"version": p.Version, "currency": "USD", "catalogKey": key})
		return p.Version, b
	}
	b, _ := json.Marshal(PriceSnapshot{p.Version, p.Currency, key, price})
	return p.Version, b
}
func EstimateInvocationCost(snapshot json.RawMessage, u InvocationUsage) (*int64, string) {
	if u.Status != "reported" && u.Status != "partial" {
		return nil, "unavailable"
	}
	var p PriceSnapshot
	if len(snapshot) == 0 || strictPricingJSON(snapshot, &p) != nil || p.Currency != "USD" || validateModelPrice(p.ModelPrice) != nil {
		return nil, "unavailable"
	}
	if u.InputTokens == nil || u.OutputTokens == nil || p.Rates.Input == nil || p.Rates.Output == nil {
		return nil, "unavailable"
	}
	for _, n := range []*int64{u.InputTokens, u.OutputTokens, u.CachedInputTokens, u.CacheWriteTokens, u.ReasoningTokens} {
		if n != nil && (*n < 0 || *n > 9007199254740991) {
			return nil, "unavailable"
		}
	}
	if u.CachedInputTokens != nil && *u.CachedInputTokens > *u.InputTokens {
		return nil, "unavailable"
	}
	if u.ReasoningTokens != nil && *u.ReasoningTokens > *u.OutputTokens {
		return nil, "unavailable"
	}
	type component struct {
		tokens int64
		rate   *string
	}
	input := *u.InputTokens
	parts := []component{}
	if p.Semantics.CachedInput != "included_in_input_rate" {
		if u.CachedInputTokens == nil {
			return nil, "unavailable"
		}
		if p.Semantics.CachedInput == "replace_input_rate_for_subset" {
			input -= *u.CachedInputTokens
		}
		parts = append(parts, component{*u.CachedInputTokens, p.Rates.CachedInput})
	}
	if p.Semantics.CacheWrite == "additional" {
		if u.CacheWriteTokens == nil {
			return nil, "unavailable"
		}
		parts = append(parts, component{*u.CacheWriteTokens, p.Rates.CacheWrite})
	} else if p.Semantics.CacheWrite == "unsupported" && u.CacheWriteTokens != nil && *u.CacheWriteTokens > 0 {
		return nil, "unavailable"
	}
	if p.Semantics.Reasoning == "additional_surcharge_on_subset" {
		if u.ReasoningTokens == nil {
			return nil, "unavailable"
		}
		parts = append(parts, component{*u.ReasoningTokens, p.Rates.Reasoning})
	} else if p.Semantics.Reasoning == "unsupported" && u.ReasoningTokens != nil && *u.ReasoningTokens > 0 {
		return nil, "unavailable"
	}
	parts = append(parts, component{input, p.Rates.Input}, component{*u.OutputTokens, p.Rates.Output})
	var total int64
	for _, part := range parts {
		rate, e := strconv.ParseInt(*part.rate, 10, 64)
		if e != nil {
			return nil, "unavailable"
		}
		if part.tokens != 0 && rate > math.MaxInt64/part.tokens {
			return nil, "overflow"
		}
		product := part.tokens * rate
		cost, rest := product/1000000, product%1000000
		if (p.Rounding == "ceil_per_component" && rest > 0) || (p.Rounding == "half_up_per_component" && rest >= 500000) {
			cost++
		}
		if total > math.MaxInt64-cost {
			return nil, "overflow"
		}
		total += cost
	}
	return &total, "none"
}
