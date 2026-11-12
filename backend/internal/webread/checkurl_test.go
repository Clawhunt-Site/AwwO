package webread

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// A caller's own address check holds on every address a read requests: the page's, each redirect's, and each redirect
// of the site's robots.txt, so a page or a robots.txt that redirects cannot lead past it (a model's reads pass theirs).
func TestFetchCheckURLHoldsOnEveryHop(t *testing.T) {
	var probed, robotsTarget int
	mux := http.NewServeMux()
	mux.HandleFunc("/start", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/.git/config", http.StatusFound) })
	mux.HandleFunc("/.git/config", func(w http.ResponseWriter, _ *http.Request) { probed++; fmt.Fprint(w, "[core]") })
	mux.HandleFunc("/fine", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "a plain page with enough words to be read as text by the reader")
	})
	s := newSite(t, mux)
	refuseHidden := func(u *url.URL) error {
		if strings.Contains(u.Path, "/.") {
			return failure("caller_refused", "refused by the caller")
		}
		return nil
	}
	opt := s.options(NewRobotsCache(0, 4))
	opt.CheckURL = refuseHidden
	var refused *Error
	if _, err := Fetch(context.Background(), "http://site.test/start", opt); !errors.As(err, &refused) || refused.Code != "caller_refused" || probed != 0 {
		t.Fatalf("a redirect to a refused address must not be requested: %v, requests %d", err, probed)
	}
	if _, err := Fetch(context.Background(), "http://site.test/.git/config", opt); !errors.As(err, &refused) || refused.Code != "caller_refused" || probed != 0 {
		t.Fatalf("the first address is checked too: %v", err)
	}
	// A page read records which extractor made its text: the one that keeps a page of several lists whole.
	if result, err := Fetch(context.Background(), "http://site.test/fine", opt); err != nil || !strings.Contains(result.Text, "plain page") || result.Extractor != "awwo-reader/2" {
		t.Fatalf("an allowed page still reads: %v", err)
	}
	// Without the check the reader follows the same redirect, as a member's import does.
	plain := s.options(NewRobotsCache(0, 4))
	if _, err := Fetch(context.Background(), "http://site.test/start", plain); err != nil || probed != 1 {
		t.Fatalf("without a caller's check the redirect is followed: %v, requests %d", err, probed)
	}

	// robots.txt's own redirects are held to the check as well.
	robots := http.NewServeMux()
	robots.HandleFunc("/robots.txt", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/.well-known/robots", http.StatusFound)
	})
	robots.HandleFunc("/.well-known/robots", func(w http.ResponseWriter, _ *http.Request) {
		robotsTarget++
		fmt.Fprint(w, "User-agent: *\nAllow: /\n")
	})
	robots.HandleFunc("/page", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "a plain page with enough words to be read as text by the reader")
	})
	r := newSite(t, robots)
	// One cache for both reads, as the API shares one: a refusal under a caller's check is not kept for others.
	shared := NewRobotsCache(time.Hour, 4)
	ropt := r.options(shared)
	ropt.CheckURL = refuseHidden
	if _, err := Fetch(context.Background(), "http://site.test/page", ropt); err == nil || robotsTarget != 0 {
		t.Fatalf("a robots.txt redirect to a refused address must not be requested: %v, requests %d", err, robotsTarget)
	}
	member := r.options(shared)
	if result, err := Fetch(context.Background(), "http://site.test/page", member); err != nil || robotsTarget != 1 || !result.Robots.Allowed {
		t.Fatalf("a read without the check follows the same robots.txt redirect and reads the page: %v, requests %d", err, robotsTarget)
	}
}
