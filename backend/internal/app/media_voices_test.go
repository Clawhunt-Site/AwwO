package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// A canvas run's speaking shot (M-1c): a picture wired into the video's reference input and a voice wired into its
// audio input are uploaded to RunningHub in canvas order, and the video's task names the picture in imageUrls and the
// voice in audioUrls, with the node's real-person switch, its words alone as the prompt. A voice with no picture beside
// it, one wired into a video whose model takes none, or one whose node failed, stops the video before it is sent.
func TestPostgresGraphRunSendsAVoiceWithItsPicture(t *testing.T) {
	h, rh := newMediaHarness(t)
	voice := testVoice(3)
	rh.content["/out.mp3"] = voice
	results := map[string]string{}
	rh.set(func(n int) (int, any) {
		task := fmt.Sprintf("task-%d", n)
		switch s := rh.submits[n-1]; {
		case strings.Contains(fmt.Sprint(s.body), "This line fails."):
			results[task] = "fail"
		case strings.Contains(s.path, "speech"):
			results[task] = "/out.mp3"
		case strings.Contains(s.path, "video"):
			results[task] = "/out.mp4"
		default:
			results[task] = "/out.png"
		}
		return 200, map[string]any{"taskId": task, "status": "QUEUED"}
	}, func(task string, n int) (int, any) {
		if results[task] == "fail" {
			return 200, map[string]any{"taskId": task, "status": "FAILED", "errorCode": "1501", "errorMessage": "refused"}
		}
		return 200, mediaSuccess(task, "https://files.runninghub.ai"+results[task])
	})
	c, tid, _ := h.register(t, "media-voices@example.test")
	base := "/tenants/" + tid
	draft := func(node map[string]any, words string) map[string]any {
		node["threads"] = []any{map[string]any{"id": "default", "title": "Session 1", "issueId": nil, "preview": "", "draft": words, "createdAt": 0}}
		return node
	}
	wire := func(from, to, port, kind string) map[string]any {
		return map[string]any{"id": from + "-" + to + "-" + port, "fromNode": from, "fromPort": "result", "toNode": to, "toPort": port, "dataType": kind}
	}
	words := "@Image 1 looks up at the sky and says the line in @Audio 1, lips in sync"
	run := func(nodes []any, edges []any, want string) map[string]map[string]any {
		t.Helper()
		v := h.request(t, c, "POST", base+"/canvases", map[string]any{"name": "Voices", "document": map[string]any{"nodes": nodes, "edges": edges}}, 201)
		cid := v["id"].(string)
		canvas := h.request(t, c, "POST", base+"/canvases/"+cid+"/initialize", map[string]any{"documentVersion": 1}, 200)
		graph := h.request(t, c, "POST", base+"/canvases/"+cid+"/graph-runs", map[string]any{"operationId": randomID(), "documentVersion": canvas["version"]}, 202)
		out := map[string]map[string]any{}
		for _, raw := range awaitGraph(t, h, c, base+"/canvases/"+cid+"/graph-runs/"+graph["id"].(string), want, 20*time.Second)["nodes"].([]any) {
			n := raw.(map[string]any)
			out[n["nodeId"].(string)] = n
		}
		return out
	}
	hero := func() map[string]any {
		return draft(mediaNode("hero", mediaKindImage, "rh.seedream-v5-pro", nil), "a heavyset bald man on a basalt column")
	}
	line := func(words string) map[string]any {
		node := draft(mediaNode("line", mediaKindAudio, "rh.minimax-speech-2-8-hd", map[string]any{"voice": "Patient_Man"}), words)
		node["y"] = 300
		return node
	}
	shot := func(model string, params map[string]any) map[string]any {
		node := draft(mediaNode("shot", mediaKindVideo, model, params), words)
		node["x"] = 500
		return node
	}
	videos := func() int {
		submitted, _ := rh.counts()
		count := 0
		for i := 0; i < submitted; i++ {
			if strings.Contains(rh.submission(i).path, "video") {
				count++
			}
		}
		return count
	}

	nodes := run([]any{hero(), line("Nothing is louder here."), shot("rh.seedance-2-multimodal", map[string]any{"duration": "6", "realPersonMode": true})},
		[]any{wire("hero", "shot", "reference", "image"), wire("line", "shot", "audio", "audio")}, "completed")
	if nodes["shot"]["state"] != "done" {
		t.Fatalf("the speaking shot %v", nodes["shot"])
	}
	ups := rh.uploaded()
	if len(ups) != 2 || ups[0].contentType != "image/png" || ups[0].name != "reference.png" || ups[1].contentType != "audio/mpeg" || ups[1].name != "reference.mp3" ||
		!bytes.Equal(ups[1].data, voice) {
		t.Fatal("the picture, then the voice, are uploaded", len(ups))
	}
	var video *fakeSubmit
	for i := 0; i < 3; i++ {
		if s := rh.submission(i); strings.Contains(s.path, "multimodal") {
			video = &s
		}
	}
	if video == nil {
		t.Fatal("no video task was submitted")
	}
	images, _ := video.body["imageUrls"].([]any)
	voices, _ := video.body["audioUrls"].([]any)
	if len(images) != 1 || images[0] != fakeReferenceURL(1) || len(voices) != 1 || voices[0] != fakeReferenceURL(2) || video.body["realPersonMode"] != true ||
		video.body["prompt"] != words || video.uploads != 2 {
		t.Fatalf("the video's task %+v", video.body)
	}
	// The stored prompt names both files the shot was made from, the voice included.
	var stored string
	if e := h.db.QueryRow(t.Context(), "SELECT prompt FROM runs WHERE tenant_id=$1 AND id=$2", tid, nodes["shot"]["runId"]).Scan(&stored); e != nil ||
		!strings.Contains(stored, "image-1.png") || !strings.Contains(stored, "audio-1.mp3") {
		t.Fatal("the stored prompt", stored, e)
	}
	var record mediaOutput
	if json.Unmarshal([]byte(nodes["shot"]["output"].(string)), &record) != nil || record.Kind != mediaKindVideo || len(record.Items) != 1 {
		t.Fatal("the shot's delivery", nodes["shot"]["output"])
	}

	// A voice alone, with no picture beside it, is refused before the video is sent: RunningHub reads a voice only
	// beside a picture. The refusal names the voice (media_voice_unavailable), not a picture.
	failed := run([]any{hero(), line("Nothing is louder here."), shot("rh.seedance-2-multimodal", nil)}, []any{wire("line", "shot", "audio", "audio")}, "failed")
	if n := failed["shot"]; n["state"] != "failed" || !strings.HasPrefix(fmt.Sprint(n["detail"]), "media_voice_unavailable") {
		t.Fatalf("a voice without a picture: %v", failed["shot"])
	}
	// A voice wired into a video whose model takes none (the run's frozen model, the text-only video) fails the node
	// the same way, before its run is even made.
	failed = run([]any{hero(), line("Nothing is louder here."), shot("rh.seedance-2", nil)},
		[]any{wire("hero", "shot", "reference", "image"), wire("line", "shot", "audio", "audio")}, "failed")
	if n := failed["shot"]; n["state"] != "failed" || fmt.Sprint(n["detail"]) != "media_voice_unavailable" || n["runId"] != nil {
		t.Fatalf("a voice into a video that takes none: %v", failed["shot"])
	}
	// A voice whose node failed holds the video back: it is never made without its line.
	failed = run([]any{hero(), line("This line fails."), shot("rh.seedance-2-multimodal", nil)},
		[]any{wire("hero", "shot", "reference", "image"), wire("line", "shot", "audio", "audio")}, "failed")
	if failed["line"]["state"] != "failed" || failed["shot"]["state"] != "blocked" || failed["shot"]["runId"] != nil {
		t.Fatalf("a voice that was not made: %v %v", failed["line"], failed["shot"])
	}
	if got := videos(); got != 1 {
		t.Fatal("only the first shot was sent", got)
	}
}

// voiceTestQuerier answers freezeMediaReferences' lookup from a table of this canvas's files by id: any other id is
// not this canvas's.
type voiceTestQuerier map[string]mediaReference

func (voiceTestQuerier) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, pgx.ErrNoRows
}
func (q voiceTestQuerier) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	ref, ok := q[fmt.Sprint(args[2])]
	return voiceTestRow{ref, ok}
}

type voiceTestRow struct {
	ref mediaReference
	ok  bool
}

func (r voiceTestRow) Scan(dest ...any) error {
	if !r.ok {
		return pgx.ErrNoRows
	}
	*dest[0].(*string), *dest[1].(*int64), *dest[2].(*string) = r.ref.Name, r.ref.Size, r.ref.SHA256
	rel, contentType := r.ref.Path, r.ref.ContentType
	*dest[3].(**string), *dest[4].(**string) = &rel, &contentType
	return nil
}

// Voices are frozen apart from pictures (M-1c): in the text's order, up to the model's own count of them, each kind
// numbered on its own. On a model that takes voices, one more than it takes, one it cannot read (its type, size or
// length: 2-15 s each, 15 s in all) or any without a picture beside it refuses the generation (media_voice_unavailable),
// so a speaking shot is never made without its line. To any other model an audio file (one attached to its message) is
// not a picture and is left out, as before; a voice WIRED into such a video is refused by the canvas run
// (TestGraphVideoTakesWiredVoices).
func TestVoicesAreFrozenApartFromPictures(t *testing.T) {
	a := &App{cfg: testConfig()}
	a.cfg.MediaDir = t.TempDir()
	extension := map[string]string{"image/png": ".png", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/ogg": ".bin"}
	file := func(id, name, contentType string, data []byte) mediaReference {
		sum := sha256.Sum256(data)
		digest := hex.EncodeToString(sum[:])
		rel := "t1/r1/" + digest + extension[contentType]
		if e := os.MkdirAll(filepath.Join(a.cfg.MediaDir, "t1", "r1"), 0o750); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(filepath.Join(a.cfg.MediaDir, filepath.FromSlash(rel)), data, 0o640); e != nil {
			t.Fatal(e)
		}
		return mediaReference{ArtifactID: id, Name: name, ContentType: contentType, Size: int64(len(data)), SHA256: digest, Path: rel}
	}
	q := voiceTestQuerier{
		"avoice00000001": file("avoice00000001", "audio-1.mp3", "audio/mpeg", testVoice(3)),
		"avoice00000002": file("avoice00000002", "audio-1.mp3", "audio/mpeg", testVoice(4)),
		"avoice00000003": file("avoice00000003", "audio-1.wav", "audio/wav", testVoiceWAV(3)),
		"avoice00000004": file("avoice00000004", "audio-1.mp3", "audio/mpeg", testVoice(2.5)),
		"aoggvoice00001": file("aoggvoice00001", "audio-1.ogg", "audio/ogg", []byte("OggS\x00\x02 an Ogg voice")),
		"ashortvoice001": file("ashortvoice001", "audio-1.mp3", "audio/mpeg", testVoice(1.5)),
		"aedgevoice0001": file("aedgevoice0001", "audio-1.mp3", "audio/mpeg", testVoice(2.05)),
		"aedgevoice0002": file("aedgevoice0002", "audio-1.mp3", "audio/mpeg", testVoice(2.2)),
		"alongvoice0001": file("alongvoice0001", "audio-1.mp3", "audio/mpeg", testVoice(16)),
		"aeightvoice001": file("aeightvoice001", "audio-1.mp3", "audio/mpeg", testVoice(8)),
		"aeightvoice002": file("aeightvoice002", "audio-1.mp3", "audio/mpeg", testVoice(8.2)),
		"ajunkvoice0001": file("ajunkvoice0001", "audio-1.mp3", "audio/mpeg", testMP3),
	}
	big := file("abigvoice00001", "audio-1.mp3", "audio/mpeg", testVoice(3))
	big.Size = rhMaxReferenceBytes + 1
	q["abigvoice00001"] = big
	for i := 1; i <= 9; i++ {
		id := fmt.Sprintf("apicture00000%d", i)
		q[id] = file(id, "image-1.png", "image/png", append(append([]byte{}, testPNG...), byte(i)))
	}
	line := func(id string) string {
		name := "audio-1.mp3"
		if ref, ok := q[id]; ok {
			name = ref.Name
		}
		return "[附件] " + name + " · awwo-file:" + id
	}
	lines := func(ids ...string) string {
		out := make([]string, len(ids))
		for i, id := range ids {
			out[i] = line(id)
		}
		return strings.Join(out, "\n")
	}
	model := func(id string) *mediaModel {
		m, ok := builtinMediaCatalog.model(id)
		if !ok {
			t.Fatal("no model", id)
		}
		return m
	}
	freeze := func(text, id string) ([]mediaReference, error) {
		return a.freezeMediaReferences(t.Context(), q, "t1", "c1", text, model(id))
	}
	ids := func(refs []mediaReference) string {
		out := make([]string, len(refs))
		for i, ref := range refs {
			out[i] = ref.ArtifactID
		}
		return strings.Join(out, ",")
	}
	if m := model("rh.seedance-2-multimodal"); m.AudioReferences != 3 || model("xt.omni-video").AudioReferences != 0 {
		t.Fatal("which video takes voices", m.AudioReferences)
	}

	refs, err := freeze("@Image 1 says @Audio 1\n"+lines("avoice00000001", "apicture000001"), "rh.seedance-2-multimodal")
	if err != nil || ids(refs) != "avoice00000001,apicture000001" || refs[0].ContentType != "audio/mpeg" || refs[0].Path != q["avoice00000001"].Path ||
		refs[1].ContentType != "image/png" {
		t.Fatal("a voice and a picture, in the text's order", refs, err)
	}
	// Each kind keeps its own order among the other's: picture, voice, picture is @Image 1, @Audio 1, @Image 2.
	if refs, err := freeze(lines("apicture000001", "avoice00000001", "apicture000002"), "rh.seedance-2-multimodal"); err != nil ||
		ids(refs) != "apicture000001,avoice00000001,apicture000002" {
		t.Fatal("picture, voice, picture", ids(refs), err)
	}
	// A voice a little past the margin above 2 s is taken (an MP3's reading runs about 50 ms long).
	if refs, err := freeze(lines("apicture000001", "aedgevoice0002"), "rh.seedance-2-multimodal"); err != nil || len(refs) != 2 {
		t.Fatal("a 2.2 s voice", ids(refs), err)
	}
	// Three voices, 10 s in all, a WAV among them.
	if refs, err := freeze(lines("apicture000001", "avoice00000001", "avoice00000002", "avoice00000003"), "rh.seedance-2-multimodal"); err != nil || len(refs) != 4 ||
		refs[3].ArtifactID != "avoice00000003" || refs[3].ContentType != "audio/wav" {
		t.Fatal("three voices", ids(refs), err)
	}
	var refusal setupError
	for name, text := range map[string]string{
		"a voice without a picture":           "@Audio 1\n" + line("avoice00000001"),
		"a fourth voice":                      lines("apicture000001", "avoice00000001", "avoice00000002", "avoice00000003", "avoice00000004"),
		"a type it does not read":             lines("apicture000001", "aoggvoice00001"),
		"a voice too large for RunningHub":    lines("apicture000001", "abigvoice00001"),
		"a voice under 2 seconds":             lines("apicture000001", "ashortvoice001"),
		"a voice within 0.1 s of 2 seconds":   lines("apicture000001", "aedgevoice0001"),
		"a voice over 15 seconds":             lines("apicture000001", "alongvoice0001"),
		"voices over 15 seconds in all":       lines("apicture000001", "aeightvoice001", "aeightvoice002"),
		"an MP3 whose length cannot be found": lines("apicture000001", "ajunkvoice0001"),
	} {
		if _, err := freeze(text, "rh.seedance-2-multimodal"); !errors.As(err, &refusal) || refusal != errVoiceReferenceUnusable || refusal.code != "media_voice_unavailable" {
			t.Error(name, err)
		}
	}
	// A file that is not this canvas's cannot be told from a missing picture: the reference video refuses it as one,
	// while it could take the place of one of its pictures; past its ninth, it is left out as before.
	if _, err := freeze(lines("apicture000001", "aelsewhere0001"), "rh.seedance-2-multimodal"); !errors.As(err, &refusal) || refusal != errSubjectReferenceUnusable {
		t.Error("another canvas's file", err)
	}
	nine := []string{}
	for i := 1; i <= 9; i++ {
		nine = append(nine, fmt.Sprintf("apicture00000%d", i))
	}
	if refs, err := freeze(lines(append(nine, "aelsewhere0001", "avoice00000001")...), "rh.seedance-2-multimodal"); err != nil || len(refs) != 10 ||
		refs[9].ArtifactID != "avoice00000001" {
		t.Fatal("a missing file past the ninth picture", ids(refs), err)
	}
	// A video model that takes no voices leaves an attached one out, keeping its picture, as it leaves out any file it
	// does not read (a song attached for the mood never refused a video before M-1c, and does not now).
	if refs, err := freeze(lines("apicture000001", "avoice00000001", "alongvoice0001"), "xt.omni-video"); err != nil || ids(refs) != "apicture000001" {
		t.Fatal("voices attached to a video that takes none", ids(refs), err)
	}
	if refs, err := freeze(lines("avoice00000001", "aoggvoice00001"), "xt.omni-video"); err != nil || refs != nil {
		t.Fatal("sounds alone attached to a video that takes none", refs, err)
	}
	// A video model that takes no files still leaves them all out as before, and an image model leaves an audio file
	// out (it is not a picture) and keeps its picture.
	if refs, err := freeze(lines("apicture000001", "avoice00000001"), "rh.seedance-2"); err != nil || refs != nil {
		t.Fatal("files named to a text-only video", refs, err)
	}
	if refs, err := freeze(lines("avoice00000001", "apicture000001"), "xt.xtasy-3"); err != nil || ids(refs) != "apicture000001" {
		t.Fatal("an audio file named to an image model", ids(refs), err)
	}
}

// A video node's voices come by its audio input (M-1c), its pictures by its reference input: each becomes a reference
// line in canvas order before its words, and each input lends only its own kind. The graph takes an audio result into
// a video node's audio input and nothing else there, and a canvas run refuses a node whose frozen model takes no voices
// when one is wired in, or whose wired voice node delivered none.
func TestGraphVideoTakesWiredVoices(t *testing.T) {
	record := func(kind, id, name, contentType string) string {
		raw, _ := json.Marshal(map[string]any{"type": mediaOutputType, "version": 1, "kind": kind, "items": []mediaItem{
			{ArtifactID: id, Name: name, ContentType: contentType, Size: 10}}})
		return string(raw)
	}
	threads, _ := json.Marshal([]map[string]any{{"id": "default", "draft": "@Image 1 says the line in @Audio 1."}})
	shot := graphNode{ID: "shot", Kind: "session", AgentKind: mediaKindVideo, Title: "Shot", Threads: threads, X: 500}
	d := graphDocument{Nodes: []graphNode{shot,
		{ID: "line", Kind: "session", AgentKind: mediaKindAudio, Title: "Line", Y: 300},
		{ID: "hero", Kind: "session", AgentKind: mediaKindImage, Title: "Hero", Y: 0}},
		Edges: []graphEdge{{ID: "e1", FromNode: "line", FromPort: "result", ToNode: "shot", ToPort: "audio", DataType: "audio"},
			{ID: "e2", FromNode: "hero", FromPort: "result", ToNode: "shot", ToPort: "reference", DataType: "image"}}}
	outputs := map[string]string{"hero": record("image", "ahero000000001", "image-1.png", "image/png"), "line": record("audio", "aline000000001", "audio-1.mp3", "audio/mpeg")}
	prompt, err := (&App{}).graphMediaPrompt(t.Context(), "t1", "", shot, d, outputs)
	want := "[附件] image-1.png · awwo-file:ahero000000001\n[附件] audio-1.mp3 · awwo-file:aline000000001\n\n@Image 1 says the line in @Audio 1."
	if err != nil || prompt != want {
		t.Fatalf("prompt %q %v", prompt, err)
	}
	// Each input lends only its own kind: a voice's record read through the reference input, or a picture's through
	// the audio input, names no file.
	swapped := map[string]string{"hero": outputs["line"], "line": outputs["hero"]}
	if prompt, err := (&App{}).graphMediaPrompt(t.Context(), "t1", "", shot, d, swapped); err != nil || prompt != "@Image 1 says the line in @Audio 1." {
		t.Fatalf("a kind through the other input %q %v", prompt, err)
	}
	if lines := wiredReferenceLines([]graphEdge{{FromNode: "line", ToPort: "audio"}}, outputs); lines != "[附件] audio-1.mp3 · awwo-file:aline000000001" {
		t.Fatal("a voice's line", lines)
	}
	// The refusal reads the model the run froze (the bound agent's), not the document's copy of it.
	shot.Model = "rh.seedance-2-multimodal"
	for model, refused := range map[string]bool{"rh.seedance-2-multimodal": false, "xt.omni-video": true, "rh.seedance-2": true, "rh.unknown-video": false} {
		err := wiredVoicesUsable(shot, d, model, outputs)
		if refused != (err != nil) || (err != nil && err.Error() != "media_voice_unavailable") {
			t.Error("a voice wired into", model, err)
		}
	}
	// A wired voice node that delivered no voice (an audio node bound to a text agent answers in words; a picture's
	// record is no voice) refuses the video too.
	for name, delivered := range map[string]string{"words": "Nothing is louder here.", "a picture": outputs["hero"], "nothing": ""} {
		if err := wiredVoicesUsable(shot, d, "rh.seedance-2-multimodal", map[string]string{"hero": outputs["hero"], "line": delivered}); err == nil ||
			err.Error() != "media_voice_unavailable" {
			t.Error("a voice node that delivered", name, err)
		}
	}
	pictureOnly := graphDocument{Nodes: d.Nodes, Edges: d.Edges[1:]}
	if err := wiredVoicesUsable(shot, pictureOnly, "xt.omni-video", outputs); err != nil {
		t.Fatal("no voice wired", err)
	}
	other := graphDocument{Nodes: d.Nodes, Edges: []graphEdge{{ID: "e3", FromNode: "line", FromPort: "result", ToNode: "elsewhere", ToPort: "audio", DataType: "audio"}}}
	if err := wiredVoicesUsable(shot, other, "xt.omni-video", outputs); err != nil {
		t.Fatal("a voice wired into another node", err)
	}

	bound := func(id, kind string) map[string]any {
		return map[string]any{"id": id, "kind": "session", "agentKind": kind, "title": id, "binding": map[string]any{"agentId": "agent-" + id}, "runtime": "pi"}
	}
	doc := func(edge map[string]any) []byte {
		raw, _ := json.Marshal(map[string]any{"nodes": []any{bound("line", "audio"), bound("hero", "image"), bound("shot", "video")}, "edges": []any{edge}})
		return raw
	}
	wire := func(from, to, port, kind string) map[string]any {
		return map[string]any{"id": "e", "fromNode": from, "fromPort": "result", "toNode": to, "toPort": port, "dataType": kind}
	}
	if _, _, err := parseGraph(doc(wire("line", "shot", "audio", "audio")), nil); err != nil {
		t.Fatal("a voice into a video's audio input", err)
	}
	for name, bad := range map[string]map[string]any{
		"a picture into the audio input":     wire("hero", "shot", "audio", "image"),
		"a voice into the reference input":   wire("line", "shot", "reference", "audio"),
		"a voice into an image node's audio": wire("line", "hero", "audio", "audio"),
		"a voice typed as a picture":         wire("line", "shot", "audio", "image"),
	} {
		if _, _, err := parseGraph(doc(bad), nil); err == nil {
			t.Error("accepted", name)
		}
	}
}

// RunningHub's real-person refusal (1505) has a code of its own (M-1c), so the reader is told to turn the switch on;
// its other content refusals stay as they were.
func TestRunningHubRealPersonRefusalHasItsOwnCode(t *testing.T) {
	for code, want := range map[string]string{"1505": "media_real_person_rejected", "1501": "media_content_rejected", "433": "media_content_rejected"} {
		if e, ok := asRHError(rhCodeError(code)); !ok || e.Code != want || e.Transient {
			t.Error(code, e)
		}
	}
}
