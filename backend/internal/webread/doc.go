// Package webread reads one public web page for AwwO, safely, and turns it into readable text.
//
// It exists for one governed path: a member asks the API to import an address into the knowledge base. Models and
// workers never fetch anything themselves. The security model:
//
//   - Only http and https on the default ports, without credentials in the address, to a registered host name (no
//     IP literals in any spelling, no single-label or local names). Validated again on every redirect, at most five.
//   - Every connection is checked where it is made: the dialer refuses an address that is not public unicast, after
//     name resolution, so a name that resolves (or is rebound) to a private address is never reached. Proxy settings
//     are never consulted.
//   - robots.txt is obeyed for an honest product token; a server error reading it counts as "not allowed".
//   - No cookies, no referer, no JavaScript, an honest user agent, one deadline for the whole read, bounded headers
//     and body. A bot-challenge page is reported as such and never worked around.
//   - The extracted text drops content a person would not see (hidden elements, scripts, styles) and the invisible
//     characters that can smuggle instructions; it is still untrusted data for whoever reads it.
//
// Design informed by AIHOT (MIT, © 2026 数字生命卡兹克), Agent-Reach (MIT, © 2025 Agent Eyes) and Scrapling
// (BSD-3-Clause, © 2024 Karim Shoair); re-implemented for AwwO, no code copied.
package webread

// Error is a refusal or failure with a stable code; Message is a short sentence safe to show a person (it never
// echoes response bodies or internal addresses).
type Error struct {
	Code, Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func failure(code, message string) *Error { return &Error{Code: code, Message: message} }
