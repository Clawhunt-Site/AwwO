package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// slotUploader takes references and counts the uploads in flight at once; it refuses every upload when failing is set.
type slotUploader struct {
	fakeMediaProvider
	mu          sync.Mutex
	now, most   int
	calls       int
	holdForEach time.Duration
	failing     bool
}

func (u *slotUploader) uploadReference(_ context.Context, ref mediaReference, _ []byte, _ string) (string, error) {
	u.mu.Lock()
	u.now, u.calls = u.now+1, u.calls+1
	u.most = max(u.most, u.now)
	failing := u.failing
	u.mu.Unlock()
	time.Sleep(u.holdForEach)
	u.mu.Lock()
	u.now--
	u.mu.Unlock()
	if failing {
		return "", &rhError{Code: "media_reference_unavailable"}
	}
	return "ref-" + ref.ArtifactID, nil
}

// takeAllSlots fills referenceUploadSlots within a second, or fails the test: a slot that was never given back shows
// as a failure here, not as a hung test.
func takeAllSlots(t *testing.T) func() {
	t.Helper()
	for i := 0; i < maxReferenceUploadsInFlight; i++ {
		select {
		case referenceUploadSlots <- struct{}{}:
		case <-time.After(time.Second):
			for ; i > 0; i-- {
				<-referenceUploadSlots
			}
			t.Fatal("an upload slot was not given back")
		}
	}
	return func() {
		for i := 0; i < maxReferenceUploadsInFlight; i++ {
			<-referenceUploadSlots
		}
	}
}

// The runs uploading references are bounded across the API (2026-10-20, after 37 videos from references started at once
// took it past its memory cap): twelve runs of two references each, all at once, never have more than
// maxReferenceUploadsInFlight files read and sent together, and every run gets its ids in order. A run that fails gives
// its slot back; a run whose context ends while it waits for a slot stops there, reading and sending nothing.
func TestReferenceUploadsAreBoundedAcrossRuns(t *testing.T) {
	a := &App{cfg: testConfig()}
	a.cfg.MediaDir = t.TempDir()
	sum := sha256.Sum256(testPNG)
	digest := hex.EncodeToString(sum[:])
	if e := os.MkdirAll(filepath.Join(a.cfg.MediaDir, "t1", "r1"), 0o750); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(a.cfg.MediaDir, "t1", "r1", digest+".png"), testPNG, 0o640); e != nil {
		t.Fatal(e)
	}
	ref := func(id string) mediaReference {
		return mediaReference{ArtifactID: id, Name: "image-1.png", ContentType: "image/png", Size: int64(len(testPNG)), SHA256: digest,
			Path: "t1/r1/" + digest + ".png"}
	}
	u := &slotUploader{holdForEach: 30 * time.Millisecond}
	runs := func(n int) []error {
		var wg sync.WaitGroup
		errs := make([]error, n)
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				first, second := fmt.Sprintf("aref%02dfirst0", i), fmt.Sprintf("aref%02dsecond", i)
				ids, err := a.uploadMediaReferences(context.Background(), u, "t1", fmt.Sprintf("run%d", i), []mediaReference{ref(first), ref(second)})
				if err == nil && (len(ids) != 2 || ids[0] != "ref-"+first || ids[1] != "ref-"+second) {
					err = fmt.Errorf("run %d: ids %v", i, ids)
				}
				errs[i] = err
			}(i)
		}
		wg.Wait()
		return errs
	}
	for _, err := range runs(12) {
		if err != nil {
			t.Fatal(err)
		}
	}
	if u.calls != 24 || u.most != maxReferenceUploadsInFlight {
		t.Fatal("uploads", u.calls, "of which at most", u.most, "in flight at once, want", maxReferenceUploadsInFlight)
	}
	takeAllSlots(t)()

	// Failing runs give their slots back.
	u.failing = true
	for _, err := range runs(6) {
		if mediaFailureCode(err) != "media_reference_unavailable" {
			t.Fatal("a refused upload", err)
		}
	}
	u.failing = false
	release := takeAllSlots(t)
	defer release()

	// Every slot taken: a run whose context ends while it waits reads and sends nothing.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	before := u.calls
	if _, err := a.uploadMediaReferences(ctx, u, "t1", "run-late", []mediaReference{ref("areflate00001")}); !errors.Is(err, context.DeadlineExceeded) ||
		u.calls != before {
		t.Fatal("a run waiting for a slot past its context", err, u.calls-before)
	}
}

// A run that waited for its uploads until less than half of the media timeout is left does not send its task
// (mediaSendTooLate): a task sent then could outlast the run, be charged and still fail.
func TestMediaSendTooLateLeavesHalfTheTimeout(t *testing.T) {
	timeout := 20 * time.Minute
	if mediaSendTooLate(context.Background(), timeout) {
		t.Fatal("a run without a deadline")
	}
	for left, late := range map[time.Duration]bool{19 * time.Minute: false, 11 * time.Minute: false, 9 * time.Minute: true, time.Minute: true} {
		ctx, cancel := context.WithTimeout(context.Background(), left)
		if got := mediaSendTooLate(ctx, timeout); got != late {
			t.Error(left, "left: too late", got)
		}
		cancel()
	}
}
