package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/netip"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// First ClawHunt sign-ins create an AwwO account and its workspace (acceptClawHunt). Two opt-in limits hold that
// step and nothing else, so an existing account, an account link proved with its password, and every later
// sign-in are never held by either:
//
//   - AWWO_NEW_ACCOUNTS_PER_IP_PER_DAY (0 or unset: no limit) counts the accounts created per client address and
//     UTC day, the address resolved as the sign-in limiter resolves it (clientIP, AWWO_TRUSTED_PROXY_CIDRS). An IPv6
//     address counts by its /64, the block one subscriber line is usually given. The count lives in signup_ip_days
//     (migration 027) under a keyed hash of the day and the address, never the address itself, and is taken in the
//     transaction that creates the account, so concurrent sign-ins cannot pass it together and a sign-in that fails
//     later counts nothing.
//   - AWWO_REQUIRE_VERIFIED_EMAIL (false or unset: off) creates no account for an identity whose issuer reports its
//     email unverified (email_verified false or absent).
//
// A refused sign-in returns to the sign-in page with sso=error and reason signup_limited or email_unverified.
var (
	errSignupLimited         = errors.New("signup_limited")
	errSignupUnverifiedEmail = errors.New("email_unverified")
)

const maxNewAccountsPerIPPerDay = 100000

// signupCountDays is how many UTC days before today a sign-up count is kept; clawHuntStart drops older ones.
const signupCountDays = 3

func (c *Config) signupSettingsFromEnv() error {
	if raw := os.Getenv("AWWO_NEW_ACCOUNTS_PER_IP_PER_DAY"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 || n > maxNewAccountsPerIPPerDay {
			return errors.New("AWWO_NEW_ACCOUNTS_PER_IP_PER_DAY must be a whole number from 0 (no limit) to " + strconv.Itoa(maxNewAccountsPerIPPerDay))
		}
		c.NewAccountsPerIPPerDay = n
	}
	// Unset, empty and "false" mean off; anything but "true" stops startup instead of guessing.
	switch os.Getenv("AWWO_REQUIRE_VERIFIED_EMAIL") {
	case "", "false":
	case "true":
		c.RequireVerifiedEmail = true
	default:
		return errors.New("AWWO_REQUIRE_VERIFIED_EMAIL must be true or false")
	}
	return nil
}

// Both limits hold the first ClawHunt sign-in only, so without ClawHunt they would silently hold nothing.
func (c Config) validateSignupSettings() error {
	if (c.NewAccountsPerIPPerDay > 0 || c.RequireVerifiedEmail) && c.ClawHuntURL == "" {
		return errors.New("AWWO_NEW_ACCOUNTS_PER_IP_PER_DAY and AWWO_REQUIRE_VERIFIED_EMAIL hold first ClawHunt sign-ins and need AWWO_CLAWHUNT_URL")
	}
	return nil
}

// signupRefusal is the sign-in page's reason for a first sign-in acceptClawHunt refused: a sign-up limit's own,
// otherwise "conflict", as before the limits.
func signupRefusal(err error) string {
	switch {
	case errors.Is(err, errSignupLimited):
		return "signup_limited"
	case errors.Is(err, errSignupUnverifiedEmail):
		return "email_unverified"
	}
	return "conflict"
}

// admitNewAccount decides, inside the transaction that would create it, whether a first sign-in may create an
// account: the verified-email requirement first, so an identity it refuses never spends its address's count, then
// the address's count for today, which it takes. Under the limit the row lock of the address's count serializes
// concurrent sign-ins, so they cannot pass it together.
func (a *App) admitNewAccount(ctx context.Context, tx pgx.Tx, id clawHuntIdentity, ip string) error {
	if a.cfg.RequireVerifiedEmail && !id.EmailVerified {
		return errSignupUnverifiedEmail
	}
	if a.cfg.NewAccountsPerIPPerDay <= 0 {
		return nil
	}
	day := a.signupDay()
	var accounts int
	err := tx.QueryRow(ctx, `INSERT INTO signup_ip_days(day,ip_hash,accounts) VALUES($1::date,$2,1)
		ON CONFLICT (day,ip_hash) DO UPDATE SET accounts=signup_ip_days.accounts+1 WHERE signup_ip_days.accounts<$3
		RETURNING accounts`, day, a.signupIPHash(day, ip), a.cfg.NewAccountsPerIPPerDay).Scan(&accounts)
	if noRows(err) {
		return errSignupLimited
	}
	return err
}

// signupDay is the UTC day a sign-up counts for, as YYYY-MM-DD.
func (a *App) signupDay() string {
	now := time.Now
	if a.signupClock != nil {
		now = a.signupClock
	}
	return now().UTC().Format(time.DateOnly)
}

// signupIPHash is the key of an address's count for a day: an HMAC of the day and the address under a key derived
// from the credential encryption key (which ClawHunt sign-in requires). The table so holds no address, a reader of
// the database alone cannot test candidate addresses against it, and one address's rows of different days are not
// linkable.
func (a *App) signupIPHash(day, ip string) string {
	derive := hmac.New(sha256.New, a.cfg.CredentialKey)
	derive.Write([]byte("awwo signup ip count v1"))
	m := hmac.New(sha256.New, derive.Sum(nil))
	m.Write([]byte(day + "\x00" + signupAddress(ip)))
	return hex.EncodeToString(m.Sum(nil))
}

// signupAddress is what one count is kept for: an IPv4 address (an IPv4-mapped IPv6 address is its IPv4 address),
// or an IPv6 address's /64. Counting single IPv6 addresses would let one subscriber line create accounts without
// limit. Anything that does not parse counts as itself.
func signupAddress(ip string) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	addr = addr.Unmap().WithZone("")
	if addr.Is4() {
		return addr.String()
	}
	prefix, err := addr.Prefix(64)
	if err != nil {
		return addr.String()
	}
	return prefix.String()
}

// pruneSignupCounts drops the counts of days more than $1 (signupCountDays) UTC days before today, whether or not the
// limit is on now, so the table never outlives its use by more than a few days.
const pruneSignupCounts = `DELETE FROM signup_ip_days WHERE day<(now() AT TIME ZONE 'UTC')::date-$1::integer`
