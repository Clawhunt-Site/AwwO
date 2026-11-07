package app

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
)

// marketSettings configures the Agent market (market.go, docs/awwo-agent-market.md). It is off unless AWWO_MARKET=on;
// transfers of the monthly statements an administrator approved into the authors' ClawHunt wallets are off unless
// AWWO_MARKET_PAYOUTS=on. What was used is settled, and its statements made, whether the market is on or not
// (market_settle.go).
type marketSettings struct {
	MarketEnabled bool
	// MarketFeeBps is the platform's share of an Agent's price, in basis points, frozen into each call when it is
	// admitted (AWWO_MARKET_FEE_BPS, 0-10000, unset 2500).
	MarketFeeBps int
	// MarketMaxPrice is the highest price per call an author may set, in credits (AWWO_MARKET_MAX_PRICE, 1-10000,
	// unset 500).
	MarketMaxPrice int
	// MarketHoldDays is how long after the caller's billing period ends an earning waits before it is final
	// (AWWO_MARKET_HOLD_DAYS, 1-90, unset 14): a refund or a dispute within the period still takes it back.
	MarketHoldDays int
	// MarketPayouts lets an administrator approve a monthly statement, which sends it to the author's ClawHunt wallet
	// (market_admin.go, market_settle.go). Nothing is transferred without an approval.
	MarketPayouts bool
	// MarketOfficialPrice is what a call to one of AwwO's official Agents costs, in credits (AWWO_MARKET_OFFICIAL_PRICE,
	// 0 to MarketMaxPrice, unset 0: no Agent fee), from MarketOfficialPriceFrom on (AWWO_MARKET_OFFICIAL_PRICE_FROM, an
	// RFC 3339 time; zero: at once). It is the platform's revenue, never an author's (owner 2026-11-07), so their stored
	// versions keep the price 0 they were seeded with and the ranking counts their calls as before.
	MarketOfficialPrice     int
	MarketOfficialPriceFrom time.Time
}

func (c *Config) marketSettingsFromEnv() error {
	switch os.Getenv("AWWO_MARKET") {
	case "", "off":
	case "on":
		c.MarketEnabled = true
	default:
		return errors.New("AWWO_MARKET must be on or off")
	}
	switch os.Getenv("AWWO_MARKET_PAYOUTS") {
	case "", "off":
	case "on":
		c.MarketPayouts = true
	default:
		return errors.New("AWWO_MARKET_PAYOUTS must be on or off")
	}
	c.MarketFeeBps = 2500
	if raw := strings.TrimSpace(os.Getenv("AWWO_MARKET_FEE_BPS")); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 0 || v > 10000 {
			return errors.New("AWWO_MARKET_FEE_BPS must be an integer between 0 and 10000")
		}
		c.MarketFeeBps = v
	}
	var err error
	if c.MarketMaxPrice, err = positiveEnvInt("AWWO_MARKET_MAX_PRICE", 500, 10000); err != nil {
		return err
	}
	if c.MarketHoldDays, err = positiveEnvInt("AWWO_MARKET_HOLD_DAYS", 14, 90); err != nil {
		return err
	}
	c.MarketOfficialPrice, c.MarketOfficialPriceFrom, err = parseMarketOfficialPrice(os.Getenv("AWWO_MARKET_OFFICIAL_PRICE"),
		os.Getenv("AWWO_MARKET_OFFICIAL_PRICE_FROM"), c.MarketMaxPrice)
	return err
}

// parseMarketOfficialPrice reads the official Agents' price (whole credits up to the price an author may set) and when
// it starts (RFC 3339, read as AWWO_PROMO_UNTIL is), which only a price above 0 can have.
func parseMarketOfficialPrice(rawPrice, rawFrom string, maxPrice int) (int, time.Time, error) {
	price := 0
	if raw := strings.TrimSpace(rawPrice); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 0 || v > maxPrice {
			return 0, time.Time{}, errors.New("AWWO_MARKET_OFFICIAL_PRICE must be a whole number of credits from 0 to AWWO_MARKET_MAX_PRICE (" + strconv.Itoa(maxPrice) + ")")
		}
		price = v
	}
	if rawFrom == "" {
		return price, time.Time{}, nil
	}
	if price == 0 {
		return 0, time.Time{}, errors.New("AWWO_MARKET_OFFICIAL_PRICE_FROM needs AWWO_MARKET_OFFICIAL_PRICE above 0")
	}
	from, err := time.Parse(time.RFC3339, rawFrom)
	if err != nil {
		return 0, time.Time{}, errors.New("AWWO_MARKET_OFFICIAL_PRICE_FROM must be an RFC 3339 time such as 2026-11-12T16:00:00Z")
	}
	return price, from.UTC(), nil
}

// marketOfficialPriceAt is what a call to an official Agent costs at now: the official price once its start has come
// (at once without one), and nothing before.
func (c Config) marketOfficialPriceAt(now time.Time) int {
	if c.MarketOfficialPrice > 0 && (c.MarketOfficialPriceFrom.IsZero() || !now.Before(c.MarketOfficialPriceFrom)) {
		return c.MarketOfficialPrice
	}
	return 0
}

// marketPriceAt is what a call to the Agent m at version v costs at now, as admission charges it and the market shows it:
// an official Agent's is the official price, whatever its stored version says; an author's is its version's.
func (c Config) marketPriceAt(m marketAgentRow, v marketVersion, now time.Time) int {
	if m.Official {
		return c.marketOfficialPriceAt(now)
	}
	return v.Price
}

// validateMarket: transfers need the ClawHunt client, and not the market open (closing it stops new use, never the
// settling and paying of what was earned).
func (c Config) validateMarket() error {
	if c.MarketPayouts && (c.ClawHuntURL == "" || c.ClawHuntClientID == "" || c.ClawHuntClientSecret == "") {
		return errors.New("AWWO_MARKET_PAYOUTS transfers into ClawHunt wallets and needs the ClawHunt client configured")
	}
	return nil
}
