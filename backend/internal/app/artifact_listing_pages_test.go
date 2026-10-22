package app

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// A canvas that stored more files than one page holds is listed to its end, page by page: newest first, each file once,
// whatever page boundary falls inside files stored at one instant, and truncated exactly when more follow (also when the
// files fill their last page). The cursor is bound to its reader and its canvas, and a file stored after the first page
// was read is in no later page of that listing.
func TestPostgresArtifactListingPagesToItsEnd(t *testing.T) {
	h := newHarness(t, "")
	ctx := context.Background()
	owner, tid, _ := h.register(t, "owner-artifact-pages@awwo.invalid")
	newCanvas := func(name string) string {
		canvas := h.request(t, owner, "POST", "/tenants/"+tid+"/canvases", map[string]any{"name": name,
			"document": map[string]any{"nodes": []any{map[string]any{"id": "coder", "kind": "form", "fields": []any{}}}, "edges": []any{}}}, 201)
		return canvas["id"].(string)
	}
	cid, full, other := newCanvas("Many files"), newCanvas("Two full pages"), newCanvas("Other")
	// 1,203 files: 600 stored at one instant and 500 an hour later (so two pages end inside one instant, where only the id
	// orders them), then 103 a second apart; 1,000 files on another canvas, which fill two pages exactly; and files the
	// listing never shows: an upload, a workspace snapshot and another canvas's file.
	at := time.Now().Add(-48 * time.Hour).Truncate(time.Second)
	store := func(canvas, prefix string, count int) {
		if _, e := h.db.Exec(ctx, `INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content,created_at)
			SELECT $4||lpad(i::text,4,'0'),$1,$2,'run','coder','file','f'||i||'.bin',1,repeat('0',64),'x'::bytea,
				CASE WHEN i < 600 THEN $3::timestamptz WHEN i < 1100 THEN $3::timestamptz + interval '1 hour'
					ELSE $3::timestamptz + interval '2 hours' + (i - 1100) * interval '1 second' END
			FROM generate_series(0,$5::int - 1) AS i`, tid, canvas, at, prefix, count); e != nil {
			t.Fatal(e)
		}
	}
	store(cid, "a", 1203)
	store(full, "b", 1000)
	for _, row := range [][3]string{{"upload-1", cid, "upload"}, {"snapshot-1", cid, "__workspace_snapshot"}, {"elsewhere-1", other, "file"}} {
		if _, e := h.db.Exec(ctx, "INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content,created_at) VALUES($1,$2,$3,'run','coder',$4,'x.bin',1,$5,'x',$6)",
			row[0], tid, row[1], row[2], strings.Repeat("0", 64), at.Add(3*time.Hour)); e != nil {
			t.Fatal(e)
		}
	}
	// A second member of the workspace, who may list but not with the owner's cursor.
	member, _, _ := h.register(t, "member-artifact-pages@awwo.invalid")
	if _, e := h.db.Exec(ctx, "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'member' FROM users WHERE email=$2", tid, "member-artifact-pages@awwo.invalid"); e != nil {
		t.Fatal(e)
	}
	list := func(who *http.Cookie, canvas, query string, status int) map[string]any {
		return h.request(t, who, "GET", "/tenants/"+tid+"/canvases/"+canvas+"/artifacts"+query, nil, status)
	}

	// walk reads a canvas's listing to its end; after the first page it calls between(cursor) and, after the second,
	// atSecond(cursor).
	walk := func(canvas string, between, atSecond func(string)) (sizes []int, flags []bool, seen map[string]bool) {
		seen = map[string]bool{}
		var last struct {
			at time.Time
			id string
		}
		query := ""
		for page := 0; ; page++ {
			listed := list(owner, canvas, query, 200)
			items := listed["items"].([]any)
			sizes, flags = append(sizes, len(items)), append(flags, listed["truncated"].(bool))
			for _, value := range items {
				item := value.(map[string]any)
				id := item["id"].(string)
				created, e := time.Parse(time.RFC3339Nano, item["createdAt"].(string))
				if e != nil {
					t.Fatal(e)
				}
				if seen[id] {
					t.Fatalf("%s listed twice", id)
				}
				seen[id] = true
				if last.id != "" && (created.After(last.at) || (created.Equal(last.at) && id >= last.id)) {
					t.Fatalf("%s (%s) listed after %s (%s): not newest first", id, created, last.id, last.at)
				}
				last.at, last.id = created, id
			}
			next, more := listed["nextCursor"].(string)
			if more != listed["truncated"].(bool) || (more && next == "") {
				t.Fatalf("page %d: truncated %v but nextCursor %v", page, listed["truncated"], listed["nextCursor"])
			}
			if page == 0 && between != nil {
				between(next)
			}
			if page == 1 && atSecond != nil {
				atSecond(next)
			}
			if !more {
				return
			}
			query = "?cursor=" + url.QueryEscape(next)
		}
	}

	later := "a-later"
	sizes, flags, seen := walk(cid, func(string) {
		// A file stored now, after the first page was read: this listing's later pages leave it out.
		if _, e := h.db.Exec(ctx, "INSERT INTO artifacts(id,tenant_id,canvas_id,run_id,node_id,field_id,name,size,sha256,content) VALUES($1,$2,$3,'run','coder','file','later.bin',1,$4,'x')",
			later, tid, cid, strings.Repeat("0", 64)); e != nil {
			t.Fatal(e)
		}
	}, func(next string) {
		// The cursor reads this canvas's listing only, for its own reader only, and only as it was signed.
		refused := func(who *http.Cookie, canvas, query string) {
			if got := list(who, canvas, query, 400); got["error"].(map[string]any)["code"] != "invalid_cursor" {
				t.Fatalf("%s: %v", query, got)
			}
		}
		refused(owner, other, "?cursor="+url.QueryEscape(next))
		refused(member, cid, "?cursor="+url.QueryEscape(next))
		payload, signature, _ := strings.Cut(next, ".")
		flipped := map[bool]string{true: "B", false: "A"}[signature[:1] == "A"]
		refused(owner, cid, "?cursor="+url.QueryEscape(payload+"."+flipped+signature[1:]))
		refused(owner, cid, "?cursor=")
		refused(owner, cid, "?cursor="+url.QueryEscape(next)+"&cursor="+url.QueryEscape(next))
		// A query that does not parse is refused, not read as no cursor (which would start the listing again).
		if got := list(owner, cid, "?cursor="+url.QueryEscape(next)+"%zz", 400); got["error"].(map[string]any)["code"] != "invalid_pagination" {
			t.Fatalf("a broken query: %v", got)
		}
	})
	if len(sizes) != 3 || sizes[0] != 500 || sizes[1] != 500 || sizes[2] != 203 || !flags[0] || !flags[1] || flags[2] {
		t.Fatalf("pages %v truncated %v; want 500, 500, 203 and true, true, false", sizes, flags)
	}
	if len(seen) != 1203 || seen[later] || seen["upload-1"] || seen["snapshot-1"] || seen["elsewhere-1"] {
		t.Fatalf("listed %d files (the later one %v, an upload %v, a snapshot %v, another canvas's %v); want the 1,203 stored before the listing",
			len(seen), seen[later], seen["upload-1"], seen["snapshot-1"], seen["elsewhere-1"])
	}
	for i := 0; i < 1203; i++ {
		if id := fmt.Sprintf("a%04d", i); !seen[id] {
			t.Fatalf("%s not listed", id)
		}
	}
	// Files that fill their last page exactly: that page says nothing follows, and there is no empty page after it.
	if sizes, flags, seen := walk(full, nil, nil); len(sizes) != 2 || sizes[0] != 500 || sizes[1] != 500 || !flags[0] || flags[1] || len(seen) != 1000 {
		t.Fatalf("1,000 files: pages %v truncated %v, %d listed; want 500, 500 and true, false", sizes, flags, len(seen))
	}
	// A listing started now begins with the file stored after the first one's start, and its first page is what a
	// caller that never pages gets: the newest 500 and truncated. A member lists with a cursor of their own.
	fresh := list(owner, cid, "", 200)
	if items := fresh["items"].([]any); len(items) != 500 || items[0].(map[string]any)["id"] != later || fresh["truncated"] != true {
		t.Fatalf("a new listing's first page: %d items, first %v, truncated %v", len(items), items[0].(map[string]any)["id"], fresh["truncated"])
	}
	mine := list(member, cid, "", 200)
	if next, _ := mine["nextCursor"].(string); next == "" || len(list(member, cid, "?cursor="+url.QueryEscape(next), 200)["items"].([]any)) != 500 {
		t.Fatalf("a member's own listing does not page: %v", mine["nextCursor"])
	}
}
