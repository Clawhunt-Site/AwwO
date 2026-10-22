package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"
)

// X-tasy refusing its key (as from 2026-10-21 05:19Z) no longer fails a picture: RunningHub's Seedream makes it, from
// the same words at the same size, charged once, within the run's own time, and its record says a backup made it.
func TestPostgresMediaBackupMakesAGenerationItsProviderRefused(t *testing.T) {
	h, rh := newMediaHarness(t)
	xt := newFakeXtasy(t, h.a)
	xt.set(xtasyRefusal, nil)
	c, tid, _ := h.register(t, "media-backup@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("pic", mediaKindImage, "xt.seedream-5-pro", nil))
	run := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a quiet mountain lake", 202)
	rid := run["id"].(string)
	done := h.awaitRun(t, c, tid, rid, "completed")
	if model, backup := mediaRecord(t, done["output"].(string)); model != "rh.seedream-v5-pro" || !backup {
		t.Fatal("output", done["output"])
	}
	if sent, _ := xt.sent(); len(sent) != 1 {
		t.Fatal("X-tasy sends", len(sent))
	}
	if submits, _ := rh.counts(); submits != 1 {
		t.Fatal("RunningHub submissions", submits)
	}
	if s := rh.submission(0); s.path != "/openapi/v2/seedream-v5-pro/text-to-image" || s.body["resolution"] != "2k" || s.body["outputFormat"] != "jpeg" || s.body["prompt"] != "a quiet mountain lake" {
		t.Fatal("RunningHub's request", s.path, s.body)
	}
	task, refused, accepted := mediaGenerationState(t, h, tid, rid)
	if task["provider"] != "runninghub" || task["model"] != "rh.seedream-v5-pro" || task["backupFrom"] != "xt.seedream-5-pro" ||
		task["backupFor"] != "media_provider_unauthorized" || task["taskId"] != "task-1" || task["firstTaskId"] != nil || task["firstCharged"] != nil {
		t.Fatal("media task", task)
	}
	if refused || accepted == nil || !*accepted {
		t.Fatal("the generation is charged once, for the backup's task", refused, accepted)
	}
	if !sentWhenItsRunBegan(t, h, tid, rid) {
		t.Fatal("the backup's task did not keep the run's own deadline")
	}
	if n := backupStatuses(t, h, tid, rid); n != 1 {
		t.Fatal("backup statuses", n)
	}
	var model string
	if e := h.db.QueryRow(t.Context(), "SELECT model FROM media_generations WHERE tenant_id=$1 AND run_id=$2", tid, rid).Scan(&model); e != nil || model != "xt.seedream-5-pro" {
		t.Fatal("the generation keeps the model it was admitted (and priced) on", model, e)
	}
}

// The other way round: RunningHub refusing its key, or answering busy with no task, sends Nano Banana 2 to X-tasy's, at
// the node's shape and size, under the run's own idempotency key.
func TestPostgresMediaBackupGoesToXtasyWhenRunningHubRefuses(t *testing.T) {
	for _, code := range []string{"806", "421"} {
		h, rh := newMediaHarness(t)
		xt := newFakeXtasy(t, h.a)
		rh.set(rhFlatRefusal(code), nil)
		c, tid, _ := h.register(t, "media-backup-rh-"+code+"@example.test")
		_, canvas := mediaCanvas(t, h, c, tid, mediaNode("pic", mediaKindImage, "rh.nano-banana-2", map[string]any{"aspectRatio": "16:9", "resolution": "2k"}))
		run := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a quiet mountain lake", 202)
		rid := run["id"].(string)
		done := h.awaitRun(t, c, tid, rid, "completed")
		if model, backup := mediaRecord(t, done["output"].(string)); model != "xt.gemini-3-1-flash-image" || !backup {
			t.Fatal(code, "output", done["output"])
		}
		sent, keys := xt.sent()
		if len(sent) != 1 || keys[0] != "awwo-run-"+rid {
			t.Fatal(code, "X-tasy sends", len(sent), keys)
		}
		parameters, _ := sent[0]["parameters"].(map[string]any)
		if sent[0]["model_id"] != "model_740b5a45-d90d-531f-9dba-f51dd4e71254" || parameters["aspect_ratio"] != "16:9" || parameters["resolution"] != "2K" || sent[0]["prompt"] != "a quiet mountain lake" {
			t.Fatal(code, "X-tasy's request", sent[0])
		}
		if task, refused, accepted := mediaGenerationState(t, h, tid, rid); task["model"] != "xt.gemini-3-1-flash-image" || task["taskId"] != "xt_1" || refused || accepted == nil || !*accepted {
			t.Fatal(code, "media task", task, refused, accepted)
		}
	}
}

// A task X-tasy took and failed on its side (and so does not charge), or one its submission's answer already names as
// failed, is made by the backup; one it refused for its content is not sent anywhere else.
func TestPostgresMediaBackupAfterAFailedTaskButNotARefusedContent(t *testing.T) {
	h, rh := newMediaHarness(t)
	rh.set(nil, func(task string, n int) (int, any) {
		return 200, mediaSuccess(task, "https://files.runninghub.ai/out.mp4")
	})
	xt := newFakeXtasy(t, h.a)
	xt.set(nil, xtasyFailed)
	c, tid, _ := h.register(t, "media-backup-failed@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("clip", mediaKindVideo, "xt.omni-video", map[string]any{"duration": 6, "resolution": "480p"}))
	sid := setupNodeAt(canvas, 0)["issueId"].(string)
	run := h.mediaRun(t, c, tid, sid, "waves on a pier", 202)
	rid := run["id"].(string)
	h.awaitRun(t, c, tid, rid, "completed")
	if s := rh.submission(0); s.path != "/openapi/v2/rhart-video/sparkvideo-2.0/text-to-video" || s.body["duration"] != "6" || s.body["resolution"] != "480p" || s.body["ratio"] != "16:9" {
		t.Fatal("RunningHub's request", s.path, s.body)
	}
	if task, refused, accepted := mediaGenerationState(t, h, tid, rid); task["firstTaskId"] != "xt_1" || task["backupFor"] != "media_failed" || task["firstCharged"] != nil ||
		refused || accepted == nil || !*accepted {
		t.Fatal("media task", task, refused, accepted)
	}

	xt.set(func(n int) (int, map[string]any, http.Header) {
		return 202, map[string]any{"task_id": fmt.Sprintf("xt_%d", n), "status": "failed", "billing": map[string]any{"status": "released", "charged": "0"}}, nil
	}, nil)
	run = h.mediaRun(t, c, tid, sid, "waves on a pier", 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	if submits, _ := rh.counts(); submits != 2 {
		t.Fatal("a task the submission's answer names as failed did not go to the backup", submits)
	}
	if _, refused, accepted := mediaGenerationState(t, h, tid, run["id"].(string)); refused || accepted == nil || !*accepted {
		t.Fatal("the backup's task is the one charged", refused, accepted)
	}

	// One it names as failed and charged stays the generation's, as it is: nothing goes to the backup.
	xt.set(func(n int) (int, map[string]any, http.Header) {
		return 202, map[string]any{"task_id": fmt.Sprintf("xt_%d", n), "status": "failed", "billing": map[string]any{"status": "settled", "charged": "12"}}, nil
	}, nil)
	run = h.mediaRun(t, c, tid, sid, "waves on a pier", 202)
	if _, code := awaitRunRow(t, h, tid, run["id"].(string), "failed"); code != "media_failed" {
		t.Fatal("a charged task the submission named as failed", code)
	}
	if submits, _ := rh.counts(); submits != 2 {
		t.Fatal("a charged task the submission named as failed went to the backup", submits)
	}

	xt.set(func(n int) (int, map[string]any, http.Header) {
		return 202, map[string]any{"task_id": fmt.Sprintf("xt_%d", n), "status": "running"}, nil
	}, func(task string) (int, any) {
		return 200, map[string]any{"task_id": task, "status": "moderated", "billing": map[string]any{"status": "released", "charged": "0"}}
	})
	run = h.mediaRun(t, c, tid, sid, "waves on a pier", 202)
	if _, code := awaitRunRow(t, h, tid, run["id"].(string), "failed"); code != "media_content_rejected" {
		t.Fatal("refused content", code)
	}
	if submits, _ := rh.counts(); submits != 2 {
		t.Fatal("refused content went to the backup", submits)
	}
	if n := backupStatuses(t, h, tid, run["id"].(string)); n != 0 {
		t.Fatal("backup statuses", n)
	}
}

// A provider that took a task and then stops answering about it, refuses the key while it runs, or answers about
// another task, may still make and charge it: the run fails, charged as before, and nothing goes to the backup.
func TestPostgresMediaBackupNotWhileTheFirstProviderMayStillMakeIt(t *testing.T) {
	for _, c := range []struct {
		name  string
		query func(task string) (int, any)
		code  string
	}{
		{"silent", func(string) (int, any) {
			return 503, map[string]any{"error": map[string]any{"code": "UNAVAILABLE", "retryable": true}}
		}, "media_provider_unavailable"},
		{"refusing", func(string) (int, any) {
			return 401, map[string]any{"error": map[string]any{"code": "API_KEY_CREDENTIALS_CHANGED"}}
		}, "media_provider_unauthorized"},
		{"another", func(string) (int, any) { return xtasyFailed("xt_other") }, "media_provider_unavailable"},
		// Ended, and charged: the generation's as it is.
		{"charged", func(task string) (int, any) {
			return 200, map[string]any{"task_id": task, "status": "expired", "billing": map[string]any{"status": "settled", "charged": "12"}}
		}, "media_result_unavailable"},
	} {
		h, rh := newMediaHarness(t)
		xt := newFakeXtasy(t, h.a)
		xt.set(nil, c.query)
		user, tid, _ := h.register(t, "media-backup-"+c.name+"@example.test")
		_, canvas := mediaCanvas(t, h, user, tid, mediaNode("pic", mediaKindImage, "xt.seedream-5-pro", nil))
		run := h.mediaRun(t, user, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a quiet mountain lake", 202)
		if _, code := awaitRunRow(t, h, tid, run["id"].(string), "failed"); code != c.code {
			t.Fatal(c.name, code)
		}
		if submits, _ := rh.counts(); submits != 0 {
			t.Fatal(c.name, "a task the first provider may still make went to the backup", submits)
		}
		if task, _, accepted := mediaGenerationState(t, h, tid, run["id"].(string)); task["model"] != "xt.seedream-5-pro" || task["taskId"] != "xt_1" || accepted == nil || !*accepted {
			t.Fatal(c.name, "the first provider's task stays the run's, charged", task, accepted)
		}
	}
}

// A refusal that answered a resend is not followed by a backup (the first send may have made, and charged, the task).
// When the backup fails too, the run fails with what went wrong first, and a backup refused before the first provider
// ever took the task gives the free attempt back, for its own key or for the request built for it.
func TestPostgresMediaBackupNotAfterAResendAndTheFirstFailureIsTheRuns(t *testing.T) {
	h, rh := newMediaHarness(t)
	xt := newFakeXtasy(t, h.a)
	xt.set(func(n int) (int, map[string]any, http.Header) {
		if n%2 == 1 {
			return 429, map[string]any{"error": map[string]any{"code": "RATE_LIMITED", "retryable": true}}, http.Header{"Retry-After": {"1"}}
		}
		return xtasyRefusal(n)
	}, nil)
	c, tid, _ := h.register(t, "media-backup-resend@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("pic", mediaKindImage, "xt.seedream-5-pro", nil))
	sid := setupNodeAt(canvas, 0)["issueId"].(string)
	run := h.mediaRun(t, c, tid, sid, "a quiet mountain lake", 202)
	if _, code := awaitRunRow(t, h, tid, run["id"].(string), "failed"); code != "media_provider_unauthorized" {
		t.Fatal("refused resend", code)
	}
	if submits, _ := rh.counts(); submits != 0 {
		t.Fatal("a refusal of a resend went to the backup", submits)
	}
	if _, refused, _ := mediaGenerationState(t, h, tid, run["id"].(string)); refused {
		t.Fatal("a refusal of a resend gave its attempt back")
	}

	xt.set(xtasyRefusal, nil)
	for _, refusal := range []string{"416", "1001"} {
		rh.set(rhFlatRefusal(refusal), nil)
		run = h.mediaRun(t, c, tid, sid, "a quiet mountain lake", 202)
		rid := run["id"].(string)
		if _, code := awaitRunRow(t, h, tid, rid, "failed"); code != "media_provider_unauthorized" {
			t.Fatal(refusal, "both refused", code)
		}
		if task, refused, accepted := mediaGenerationState(t, h, tid, rid); task["model"] != "rh.seedream-v5-pro" || !refused || accepted != nil {
			t.Fatal(refusal, "a backup refused before any task gives the attempt back", task, refused, accepted)
		}
	}
}

// A task the first provider took stays the generation's whatever its backup does: one it charged for stays charged
// when the backup is refused, and one it refunded keeps counting against the free generations.
func TestPostgresMediaBackupKeepsWhatTheFirstProviderTook(t *testing.T) {
	h, rh := newMediaHarness(t)
	xt := newFakeXtasy(t, h.a)
	xt.set(xtasyRefusal, nil)
	rh.set(nil, func(task string, n int) (int, any) {
		return 200, map[string]any{"taskId": task, "status": "FAILED", "results": nil}
	})
	c, tid, _ := h.register(t, "media-backup-charged@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("pic", mediaKindImage, "rh.nano-banana-2", map[string]any{"aspectRatio": "16:9", "resolution": "2k"}),
		mediaNode("pic2", mediaKindImage, "xt.seedream-5-pro", nil))
	run := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a quiet mountain lake", 202)
	rid := run["id"].(string)
	if _, code := awaitRunRow(t, h, tid, rid, "failed"); code != "media_failed" {
		t.Fatal("charged first task", code)
	}
	if task, refused, accepted := mediaGenerationState(t, h, tid, rid); task["model"] != "xt.gemini-3-1-flash-image" || task["firstCharged"] != true ||
		refused || accepted == nil || !*accepted {
		t.Fatal("a charge the first provider made stands", task, refused, accepted)
	}

	xt.set(func(n int) (int, map[string]any, http.Header) {
		return 202, map[string]any{"task_id": fmt.Sprintf("xt_%d", n), "status": "running"}, nil
	}, xtasyFailed)
	rh.set(rhFlatRefusal("416"), nil)
	run = h.mediaRun(t, c, tid, setupNodeAt(canvas, 1)["issueId"].(string), "a quiet mountain lake", 202)
	rid = run["id"].(string)
	if _, code := awaitRunRow(t, h, tid, rid, "failed"); code != "media_failed" {
		t.Fatal("refunded first task", code)
	}
	var sent bool
	if e := h.db.QueryRow(t.Context(), "SELECT submitted_at IS NOT NULL FROM media_generations WHERE tenant_id=$1 AND run_id=$2", tid, rid).Scan(&sent); e != nil || !sent {
		t.Fatal("a generation the first provider took is no longer counted", e)
	}
	// Refunded as before: not charged, and a canvas may run the node again (mediaRunUnbilled).
	if task, refused, accepted := mediaGenerationState(t, h, tid, rid); task["firstCharged"] != nil || refused || accepted == nil || *accepted {
		t.Fatal("a refunded first task, then a refused backup: counted, not charged", task, refused, accepted)
	}
	if !h.a.mediaRunUnbilled(t.Context(), tid, rid) {
		t.Fatal("a refunded first task, then a refused backup, reads as charged")
	}

	// The same when the backup never got as far as its send: its upload failed.
	h.a.cfg.UploadMaxBytes, h.a.cfg.UploadsPerDay, h.a.cfg.UploadWorkspaceBytes, h.a.cfg.MediaMinFreeBytes = 64<<10, 20, 1<<20, 0
	rh.setUpload(func(int) (int, any) { return 400, nil })
	cid, clip := mediaCanvas(t, h, c, tid, mediaNode("clip", mediaKindVideo, "xt.omni-video", nil))
	first := h.upload(t, c, tid, cid, "ref.png", testPNG, 201)
	other := h.upload(t, c, tid, cid, "ref2.png", append(append([]byte(nil), testPNG...), 1), 201)
	pictures := "\n[附件] ref.png · " + first["reference"].(string) + "\n[附件] ref2.png · " + other["reference"].(string)
	run = h.mediaRun(t, c, tid, setupNodeAt(clip, 0)["issueId"].(string), "the same cat, walking"+pictures, 202)
	rid = run["id"].(string)
	if _, code := awaitRunRow(t, h, tid, rid, "failed"); code != "media_failed" {
		t.Fatal("a backup whose upload failed", code)
	}
	if task, refused, accepted := mediaGenerationState(t, h, tid, rid); task["model"] != "rh.seedance-2-multimodal" || refused || accepted == nil || *accepted {
		t.Fatal("a refunded first task, then a backup never sent: counted, not charged", task, refused, accepted)
	}
	if !h.a.mediaRunUnbilled(t.Context(), tid, rid) {
		t.Fatal("a refunded first task, then a backup never sent, reads as charged")
	}
}

// A backup whose own submission's answer names a task it already ended uncharged leaves the generation refunded, as a
// polled one would: not charged, and a canvas may run the node again.
func TestPostgresMediaBackupRefundedAtItsSubmission(t *testing.T) {
	h, rh := newMediaHarness(t)
	xt := newFakeXtasy(t, h.a)
	rh.set(rhFlatRefusal("421"), nil)
	xt.set(func(n int) (int, map[string]any, http.Header) {
		return 202, map[string]any{"task_id": fmt.Sprintf("xt_%d", n), "status": "failed", "billing": map[string]any{"status": "released", "charged": "0"}}, nil
	}, nil)
	c, tid, _ := h.register(t, "media-backup-refunded@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("pic", mediaKindImage, "rh.nano-banana-2", map[string]any{"aspectRatio": "16:9", "resolution": "2k"}))
	rid := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a quiet mountain lake", 202)["id"].(string)
	if _, code := awaitRunRow(t, h, tid, rid, "failed"); code != "media_provider_busy" {
		t.Fatal("both failed", code)
	}
	if task, refused, accepted := mediaGenerationState(t, h, tid, rid); task["model"] != "xt.gemini-3-1-flash-image" || refused || accepted == nil || *accepted {
		t.Fatal("a backup refunded at its submission", task, refused, accepted)
	}
	if !h.a.mediaRunUnbilled(t.Context(), tid, rid) {
		t.Fatal("a backup refunded at its submission reads as charged")
	}
}

// So is a run's own task named so in its submission's answer when no backup is sent: not charged, still counted (it
// was sent), and a canvas may run the node again, as after a polled task that ended so.
func TestPostgresMediaRefundedAtItsSubmissionWithoutABackup(t *testing.T) {
	h, _ := newMediaHarness(t)
	xt := newFakeXtasy(t, h.a)
	h.a.cfg.RunningHubAPIKey = ""
	xt.set(func(n int) (int, map[string]any, http.Header) {
		return 202, map[string]any{"task_id": fmt.Sprintf("xt_%d", n), "status": "failed", "billing": map[string]any{"status": "released", "charged": "0"}}, nil
	}, nil)
	c, tid, _ := h.register(t, "media-refunded-alone@example.test")
	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("pic", mediaKindImage, "xt.gemini-3-1-flash-image", nil))
	rid := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a quiet mountain lake", 202)["id"].(string)
	if _, code := awaitRunRow(t, h, tid, rid, "failed"); code != "media_failed" {
		t.Fatal("a task its submission named as failed", code)
	}
	if task, refused, accepted := mediaGenerationState(t, h, tid, rid); task["backupFor"] != nil || refused || accepted == nil || *accepted {
		t.Fatal("a task refunded at its submission, no backup", task, refused, accepted)
	}
	var sent bool
	if e := h.db.QueryRow(t.Context(), "SELECT submitted_at IS NOT NULL FROM media_generations WHERE tenant_id=$1 AND run_id=$2", tid, rid).Scan(&sent); e != nil || !sent {
		t.Fatal("a generation X-tasy took is no longer counted", e)
	}
	if !h.a.mediaRunUnbilled(t.Context(), tid, rid) {
		t.Fatal("a task refunded at its submission reads as charged")
	}
}

// A picture whose reference RunningHub's image models cannot take stays X-tasy's failure, and so does a video from one
// picture, which X-tasy animates and RunningHub would only keep as a subject; a video from two pictures goes to the
// multimodal video, which gets both.
func TestPostgresMediaBackupTakesTheRunsReferences(t *testing.T) {
	h, rh := newMediaHarness(t)
	xt := newFakeXtasy(t, h.a)
	xt.setUpload(func(int) (int, any) {
		return 401, map[string]any{"error": map[string]any{"code": "API_KEY_CREDENTIALS_CHANGED"}}
	})
	rh.set(nil, func(task string, n int) (int, any) {
		return 200, mediaSuccess(task, "https://files.runninghub.ai/out.mp4")
	})
	h.a.cfg.UploadMaxBytes, h.a.cfg.UploadsPerDay, h.a.cfg.UploadWorkspaceBytes, h.a.cfg.MediaMinFreeBytes = 64<<10, 20, 1<<20, 0
	c, tid, _ := h.register(t, "media-backup-refs@example.test")
	cid, canvas := mediaCanvas(t, h, c, tid, mediaNode("pic", mediaKindImage, "xt.seedream-5-pro", nil), mediaNode("clip", mediaKindVideo, "xt.omni-video", nil))
	second := append(append([]byte(nil), testPNG...), 1)
	first := h.upload(t, c, tid, cid, "ref.png", testPNG, 201)
	other := h.upload(t, c, tid, cid, "ref2.png", second, 201)
	one := "\n[附件] ref.png · " + first["reference"].(string)
	two := one + "\n[附件] ref2.png · " + other["reference"].(string)
	run := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "the same cat, in a hat"+one, 202)
	if _, code := awaitRunRow(t, h, tid, run["id"].(string), "failed"); code != "media_provider_unauthorized" {
		t.Fatal("picture from a reference", code)
	}
	run = h.mediaRun(t, c, tid, setupNodeAt(canvas, 1)["issueId"].(string), "the same cat, walking"+one, 202)
	if _, code := awaitRunRow(t, h, tid, run["id"].(string), "failed"); code != "media_provider_unauthorized" {
		t.Fatal("video from one picture", code)
	}
	if submits, _ := rh.counts(); submits != 0 || len(rh.uploaded()) != 0 {
		t.Fatal("a generation RunningHub's model would make otherwise went to it")
	}
	run = h.mediaRun(t, c, tid, setupNodeAt(canvas, 1)["issueId"].(string), "the same cat, walking"+two, 202)
	h.awaitRun(t, c, tid, run["id"].(string), "completed")
	if ups := rh.uploaded(); len(ups) != 2 || !bytes.Equal(ups[0].data, testPNG) || !bytes.Equal(ups[1].data, second) {
		t.Fatal("the backup's uploads", len(ups))
	}
	if s := rh.submission(0); s.path != "/openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video" || fmt.Sprint(s.body["imageUrls"]) != "["+fakeReferenceURL(1)+" "+fakeReferenceURL(2)+"]" {
		t.Fatal("RunningHub's request", s.path, s.body)
	}
}

// A canvas run's media node moves to its backup the same way, and its delivery says so; a model whose provider is not
// configured is refused at admission as before (a backup makes a generation its provider fails, not one it never
// had).
func TestPostgresMediaBackupInACanvasRunAndNotForAnUnconfiguredProvider(t *testing.T) {
	h, rh := newMediaHarness(t)
	xt := newFakeXtasy(t, h.a)
	xt.set(xtasyRefusal, nil)
	c, tid, _ := h.register(t, "media-backup-graph@example.test")
	base := "/tenants/" + tid
	doc := map[string]any{"nodes": []any{mediaDraftNode("img", "xt.seedream-5-pro", "poster style, warm light")}, "edges": []any{}}
	v := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Media graph", "document": doc}, 201)
	cid := v["id"].(string)
	graphCanvas := h.request(t, c, "POST", base+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
	graph := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": graphCanvas["version"]}, 202)
	done := awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+graph["id"].(string), "completed", 15*time.Second)
	for _, raw := range done["nodes"].([]any) {
		n := raw.(map[string]any)
		if model, backup := mediaRecord(t, fmt.Sprint(n["output"])); n["state"] != "done" || model != "rh.seedream-v5-pro" || !backup {
			t.Fatal("canvas run's media node", n)
		}
	}
	if submits, _ := rh.counts(); submits != 1 || rh.submission(0).body["prompt"] != "poster style, warm light" {
		t.Fatal("RunningHub submissions", submits)
	}

	_, canvas := mediaCanvas(t, h, c, tid, mediaNode("pic", mediaKindImage, "xt.seedream-5-pro", nil))
	h.a.cfg.XtasyAPIKey, h.a.xtasy = "", nil
	if got := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a quiet mountain lake", 503); errorCode(got) != "media_unavailable" {
		t.Fatal("an unconfigured provider's model", got)
	}
}

// A restart while the backup's task runs follows that task on the backup's provider, without sending it again; one
// while the run's own task runs follows that, and moves to the backup when it fails then.
func TestPostgresMediaBackupResumesAfterRestart(t *testing.T) {
	// restart stops the API, lets the stand-ins answer differently (release), and starts it again.
	restart := func(t *testing.T, h *harness, rh *fakeRunningHub, xt *fakeXtasy, release func()) *App {
		t.Helper()
		h.a.Close()
		release()
		next := New(h.db, h.a.cfg)
		rh.configure(next)
		xt.configure(next)
		if e := next.Start(t.Context()); e != nil {
			t.Fatal(e)
		}
		t.Cleanup(next.Close)
		return next
	}
	recorded := func(t *testing.T, h *harness, tid, rid, task string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			if got, _, _ := mediaGenerationState(t, h, tid, rid); got["taskId"] == task {
				return
			}
			if time.Now().After(deadline) {
				t.Fatal("task id never recorded", task)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}

	t.Run("backup", func(t *testing.T) {
		h, rh := newMediaHarness(t)
		xt := newFakeXtasy(t, h.a)
		xt.set(xtasyRefusal, nil)
		finish := make(chan struct{})
		rh.set(nil, func(task string, n int) (int, any) {
			select {
			case <-finish:
				return 200, mediaSuccess(task, "https://files.runninghub.ai/out.png")
			default:
				return 200, map[string]any{"taskId": task, "status": "RUNNING"}
			}
		})
		c, tid, _ := h.register(t, "media-backup-resume@example.test")
		_, canvas := mediaCanvas(t, h, c, tid, mediaNode("pic", mediaKindImage, "xt.seedream-5-pro", nil))
		rid := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a lighthouse at dusk", 202)["id"].(string)
		recorded(t, h, tid, rid, "task-1")
		restart(t, h, rh, xt, func() { close(finish) })
		if status, code := awaitRunRow(t, h, tid, rid, "completed", "failed"); status != "completed" {
			t.Fatal("resumed backup did not complete", code)
		}
		var output string
		if e := h.db.QueryRow(t.Context(), "SELECT output FROM runs WHERE tenant_id=$1 AND id=$2", tid, rid).Scan(&output); e != nil {
			t.Fatal(e)
		}
		if model, backup := mediaRecord(t, output); model != "rh.seedream-v5-pro" || !backup {
			t.Fatal("resumed output", output)
		}
		if submits, _ := rh.counts(); submits != 1 {
			t.Fatal("restart sent the backup again", submits)
		}
		if sent, _ := xt.sent(); len(sent) != 1 {
			t.Fatal("restart sent the first provider again", len(sent))
		}
	})

	t.Run("own task", func(t *testing.T) {
		h, rh := newMediaHarness(t)
		xt := newFakeXtasy(t, h.a)
		fail := make(chan struct{})
		xt.set(nil, func(task string) (int, any) {
			select {
			case <-fail:
				return xtasyFailed(task)
			default:
				return 200, map[string]any{"task_id": task, "status": "running"}
			}
		})
		c, tid, _ := h.register(t, "media-backup-resume-own@example.test")
		_, canvas := mediaCanvas(t, h, c, tid, mediaNode("pic", mediaKindImage, "xt.seedream-5-pro", nil))
		rid := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a lighthouse at dusk", 202)["id"].(string)
		recorded(t, h, tid, rid, "xt_1")
		restart(t, h, rh, xt, func() { close(fail) })
		if status, code := awaitRunRow(t, h, tid, rid, "completed", "failed"); status != "completed" {
			t.Fatal("a resumed task that failed was not made by its backup", code)
		}
		if task, _, _ := mediaGenerationState(t, h, tid, rid); task["model"] != "rh.seedream-v5-pro" || task["firstTaskId"] != "xt_1" {
			t.Fatal("media task", task)
		}
		if submits, _ := rh.counts(); submits != 1 {
			t.Fatal("RunningHub submissions", submits)
		}
		if sent, _ := xt.sent(); len(sent) != 1 {
			t.Fatal("restart sent the first provider again", len(sent))
		}
	})

	t.Run("backup fails", func(t *testing.T) {
		h, rh := newMediaHarness(t)
		xt := newFakeXtasy(t, h.a)
		xt.set(xtasyRefusal, nil)
		fail := make(chan struct{})
		rh.set(nil, func(task string, n int) (int, any) {
			select {
			case <-fail:
				return 200, map[string]any{"taskId": task, "status": "FAILED", "errorCode": "1001"}
			default:
				return 200, map[string]any{"taskId": task, "status": "RUNNING"}
			}
		})
		c, tid, _ := h.register(t, "media-backup-resume-fail@example.test")
		_, canvas := mediaCanvas(t, h, c, tid, mediaNode("pic", mediaKindImage, "xt.seedream-5-pro", nil))
		rid := h.mediaRun(t, c, tid, setupNodeAt(canvas, 0)["issueId"].(string), "a lighthouse at dusk", 202)["id"].(string)
		recorded(t, h, tid, rid, "task-1")
		restart(t, h, rh, xt, func() { close(fail) })
		// As without the restart: what went wrong first, not the backup's settings.
		if _, code := awaitRunRow(t, h, tid, rid, "failed"); code != "media_provider_unauthorized" {
			t.Fatal("a resumed backup that failed", code)
		}
		if submits, _ := rh.counts(); submits != 1 {
			t.Fatal("restart sent the backup again", submits)
		}
	})
}

// The record a backup made reads as a media record on the canvas, whatever else it says.
func TestMediaBackupRecordIsAMediaRecord(t *testing.T) {
	m, _ := builtinMediaCatalog.model("rh.seedream-v5-pro")
	items := []mediaItem{{ArtifactID: "a0123456789", Name: "image-1.png", ContentType: "image/png", Size: 10}}
	var plain, backed map[string]any
	if json.Unmarshal([]byte(mediaOutputRecord(m, items)), &plain) != nil || json.Unmarshal([]byte(mediaBackupRecord(m, items)), &backed) != nil {
		t.Fatal("records")
	}
	if plain["backup"] != nil || backed["backup"] != true || backed["type"] != mediaOutputType || backed["model"] != m.ID {
		t.Fatal("records", plain, backed)
	}
}
