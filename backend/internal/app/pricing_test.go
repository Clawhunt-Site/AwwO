package app

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

const pricingFixture = `{"version":"test-v1","currency":"USD","models":{"openai-agents:fixture":{"ratesMicrousdPerMillion":{"input":"2000000","cachedInput":"500000","cacheWrite":null,"output":"8000000","reasoning":null},"semantics":{"cachedInput":"replace_input_rate_for_subset","cacheWrite":"unsupported","reasoning":"included_in_output"},"rounding":"half_up_per_component"}}}`

func TestPricingExactFrozenCost(t *testing.T) {
	p, e := ParseModelPricing(pricingFixture)
	if e != nil {
		t.Fatal(e)
	}
	version, snapshot := p.Freeze("openai-agents", "fixture")
	u := InvocationUsage{Status: "reported", InputTokens: int64ptr(1000000), OutputTokens: int64ptr(100000), CachedInputTokens: int64ptr(200000), ReasoningTokens: int64ptr(20000)}
	cost, reason := EstimateInvocationCost(snapshot, u)
	if version != "test-v1" || cost == nil || *cost != 2500000 || reason != "none" {
		t.Fatal("wrong exact estimate", cost, reason)
	}
	p.Models["openai-agents:fixture"] = ModelPrice{}
	again, _ := EstimateInvocationCost(snapshot, u)
	if again == nil || *again != *cost {
		t.Fatal("price mutation changed frozen estimate")
	}
	u.InputTokens = int64ptr(0)
	u.OutputTokens = int64ptr(0)
	u.CachedInputTokens = int64ptr(0)
	u.ReasoningTokens = int64ptr(0)
	cost, _ = EstimateInvocationCost(snapshot, u)
	if cost == nil || *cost != 0 {
		t.Fatal("explicit zero lost")
	}
	u.InputTokens = nil
	if cost, _ = EstimateInvocationCost(snapshot, u); cost != nil {
		t.Fatal("missing token estimated")
	}
}

// The workers report Bedrock's cache writes since 2026-10-31 (the bridges' cache_write_tokens). Under the live table's
// semantics for every model (cache reads and writes folded into the input rate), a call that now reports its writes
// costs exactly what it cost when they were left out; a price that says writes are unsupported cannot price it.
func TestPricingAReportedCacheWriteLeavesAFoldedInCostUnchanged(t *testing.T) {
	folded := `{"version":"live-shape","currency":"USD","models":{"pi:bedrock.claude-opus-5-5":{"ratesMicrousdPerMillion":{"input":"4000000","output":"20000000","cachedInput":null,"cacheWrite":null,"reasoning":null},"semantics":{"cachedInput":"included_in_input_rate","cacheWrite":"included_in_input","reasoning":"included_in_output"},"rounding":"ceil_per_component"}}}`
	p, e := ParseModelPricing(folded)
	if e != nil {
		t.Fatal(e)
	}
	_, snapshot := p.Freeze("pi", "bedrock.claude-opus-5-5")
	without := InvocationUsage{Status: "reported", InputTokens: int64ptr(5635), OutputTokens: int64ptr(48), CachedInputTokens: int64ptr(5575)}
	with := without
	with.CacheWriteTokens = int64ptr(58)
	before, reason := EstimateInvocationCost(snapshot, without)
	after, again := EstimateInvocationCost(snapshot, with)
	if before == nil || after == nil || *before != *after || reason != "none" || again != "none" {
		t.Fatal("a reported write changed a folded-in cost", before, after, reason, again)
	}
	if creditsFor(*before) != creditsFor(*after) {
		t.Fatal("a reported write changed the credits")
	}
	unsupported, e := ParseModelPricing(strings.Replace(folded, `"cacheWrite":"included_in_input"`, `"cacheWrite":"unsupported"`, 1))
	if e != nil {
		t.Fatal(e)
	}
	_, snapshot = unsupported.Freeze("pi", "bedrock.claude-opus-5-5")
	if cost, reason := EstimateInvocationCost(snapshot, with); cost != nil || reason != "unavailable" {
		t.Fatal("a price without cache writes priced one", cost, reason)
	}
}
func TestPricingStrictSchemaAndMissing(t *testing.T) {
	for _, raw := range []string{strings.Replace(pricingFixture, `"2000000"`, `2000000`, 1), strings.Replace(pricingFixture, "half_up_per_component", "bankers", 1), strings.Replace(pricingFixture, "included_in_output", "whatever", 1), strings.Replace(pricingFixture, `"currency":"USD"`, `"currency":"EUR"`, 1), strings.Replace(pricingFixture, `"version":"test-v1"`, `"version":"test-v1","secret":"bad"`, 1), strings.Replace(pricingFixture, `"500000"`, `null`, 1), strings.Replace(pricingFixture, `"2000000"`, `"01"`, 1), strings.Replace(pricingFixture, `"2000000"`, `"9223372036854775808"`, 1)} {
		if _, e := ParseModelPricing(raw); e == nil {
			t.Fatalf("accepted invalid config %s", raw)
		}
	}
	p, e := ParseModelPricing("")
	if e != nil {
		t.Fatal(e)
	}
	_, snapshot := p.Freeze("pi", "unknown")
	if cost, reason := EstimateInvocationCost(snapshot, InvocationUsage{Status: "reported"}); cost != nil || reason != "unavailable" {
		t.Fatal("missing price became estimate")
	}
}
func TestPricingRoundingOverflowAndSpecialRates(t *testing.T) {
	p, _ := ParseModelPricing(pricingFixture)
	_, raw := p.Freeze("openai-agents", "fixture")
	var snapshot PriceSnapshot
	if e := json.Unmarshal(raw, &snapshot); e != nil {
		t.Fatal(e)
	}
	one := "1"
	snapshot.Rates.Input = &one
	snapshot.Rounding = "half_up_per_component"
	snapshot.Rates.Output = &one
	snapshot.Rates.CachedInput = nil
	snapshot.Semantics.CachedInput = "included_in_input_rate"
	u := InvocationUsage{Status: "reported", InputTokens: int64ptr(500000), OutputTokens: int64ptr(500000)}
	for rule, want := range map[string]int64{"floor_per_component": 0, "ceil_per_component": 2, "half_up_per_component": 2} {
		price := snapshot
		price.Rounding = rule
		b, _ := json.Marshal(price)
		cost, why := EstimateInvocationCost(b, u)
		if cost == nil || *cost != want || why != "none" {
			t.Fatalf("rounding %s = %v %s", rule, cost, why)
		}
	}
	max := "9223372036854775807"
	snapshot.Rates.Input = &max
	b, _ := json.Marshal(snapshot)
	if cost, why := EstimateInvocationCost(b, u); cost != nil || why != "overflow" {
		t.Fatal("multiplication overflow accepted", cost, why)
	}
	snapshot.Rates.Input = &one
	u.InputTokens = int64ptr(9007199254740991)
	u.OutputTokens = int64ptr(0)
	b, _ = json.Marshal(snapshot)
	if cost, _ := EstimateInvocationCost(b, u); cost == nil || *cost != 9007199255 {
		t.Fatal("largest protocol token failed", cost)
	}
	u.InputTokens = int64ptr(math.MaxInt64)
	if cost, _ := EstimateInvocationCost(b, u); cost != nil {
		t.Fatal("unsafe token accepted")
	}
	snapshot.Semantics.CacheWrite = "additional"
	snapshot.Rates.CacheWrite = &one
	snapshot.Semantics.Reasoning = "additional_surcharge_on_subset"
	snapshot.Rates.Reasoning = &one
	u = InvocationUsage{Status: "partial", InputTokens: int64ptr(1000000), OutputTokens: int64ptr(1000000), CacheWriteTokens: int64ptr(1000000), ReasoningTokens: int64ptr(500000)}
	snapshot.Rounding = "half_up_per_component"
	b, _ = json.Marshal(snapshot)
	cost, _ := EstimateInvocationCost(b, u)
	if cost == nil || *cost != 4 {
		t.Fatal("surcharge components incorrect", cost)
	}
	u.CacheWriteTokens = nil
	if cost, _ := EstimateInvocationCost(b, u); cost != nil {
		t.Fatal("unknown surcharge priced")
	}
}

func TestPricingDuplicatePropertiesRejected(t *testing.T) {
	for _, raw := range []string{strings.Replace(pricingFixture, `"version":"test-v1"`, `"version":"test-v1","version":"test-v2"`, 1), strings.Replace(pricingFixture, `"input":"2000000"`, `"input":"2000000","input":"1"`, 1)} {
		if _, e := ParseModelPricing(raw); e == nil {
			t.Fatal("ambiguous price properties accepted")
		}
	}
}
