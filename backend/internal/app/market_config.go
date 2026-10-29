package app

import (
	"errors"
	"os"
	"strconv"
	"strings"
)

// marketSettings configures the Agent market (market.go, docs/awwo-agent-market.md). It is off unless AWWO_MARKET=on;
// transfers of authors' earnings into their ClawHunt wallets are off unless AWWO_MARKET_PAYOUTS=on. What was used is
// settled whether the market is on or not (market_settle.go).
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
	// MarketPayouts transfers final earnings to the authors' ClawHunt wallets (market_settle.go).
	MarketPayouts bool
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
	return nil
}

// validateMarket: payouts need the ClawHunt client, and not the market open (closing it stops new use, never the
// settling and paying of what was earned).
func (c Config) validateMarket() error {
	if c.MarketPayouts && (c.ClawHuntURL == "" || c.ClawHuntClientID == "" || c.ClawHuntClientSecret == "") {
		return errors.New("AWWO_MARKET_PAYOUTS transfers into ClawHunt wallets and needs the ClawHunt client configured")
	}
	return nil
}
