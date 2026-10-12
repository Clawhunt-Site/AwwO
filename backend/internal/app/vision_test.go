package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A 1x1 lossless WebP (the format has no encoder in Go).
const testWebP1x1 = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="

func testPicturePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, color.NRGBA{uint8(x * 7), uint8(y * 3), uint8(x ^ y), 255})
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// testRotatedJPEG is a w x h JPEG whose EXIF says it must be turned (orientation o) to be upright.
func testRotatedJPEG(t *testing.T, w, h, o int) []byte {
	t.Helper()
	var plain bytes.Buffer
	if err := jpeg.Encode(&plain, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatal(err)
	}
	tiff := []byte{'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, byte(o), 0, 0, 0, 0, 0, 0, 0}
	segment := append([]byte("Exif\x00\x00"), tiff...)
	app1 := append([]byte{0xFF, 0xE1, byte((len(segment) + 2) >> 8), byte(len(segment) + 2)}, segment...)
	data := plain.Bytes()
	return append(append(append([]byte{}, data[:2]...), app1...), data[2:]...)
}

func TestModelInputKindsAreReadOrDropped(t *testing.T) {
	for raw, want := range map[string]string{
		`["text","image"]`: "text,image", `["text"]`: "text", `["image","text"]`: "image,text",
		`["image"]`: "", `["text","text"]`: "", `["text","audio"]`: "", `"text"`: "", `[]`: "", `null`: "", ``: "", `{"a":1}`: "",
	} {
		if got := strings.Join(modelInputKinds(json.RawMessage(raw)), ","); got != want {
			t.Errorf("%s: got %q, want %q", raw, got, want)
		}
	}
}

func TestImageInputClaimNeverFailsTheCatalog(t *testing.T) {
	var h piHealth
	body := `{"ready":true,"model":"m","imageInput":"yes","models":[{"id":"m","provider":"bedrock","input":"text,image"},{"id":"v","provider":"bedrock","input":["text","image"]}]}`
	if err := json.Unmarshal([]byte(body), &h); err != nil {
		t.Fatal("a malformed claim failed the health decode", err)
	}
	if h.ImageInput || h.Models[0].Input != nil || strings.Join(h.Models[1].Input, ",") != "text,image" {
		t.Fatal("malformed values were believed", h.ImageInput, h.Models)
	}
	if h.modelSeesImages("v") {
		t.Fatal("a worker that does not claim images was sent pictures")
	}
	if err := json.Unmarshal([]byte(strings.Replace(body, `"yes"`, "true", 1)), &h); err != nil || !h.ImageInput {
		t.Fatal("a literal true claim was not read", err)
	}
	if !h.modelSeesImages("v") || h.modelSeesImages("m") || h.modelSeesImages("missing") {
		t.Fatal("per-model gate", h.Models)
	}
	// A snapshot keeps the claim and the lists exactly.
	raw, _ := json.Marshal(h)
	var again piHealth
	if err := json.Unmarshal(raw, &again); err != nil || !again.modelSeesImages("v") || again.modelSeesImages("m") {
		t.Fatal("round trip", err, string(raw))
	}
	// A catalog without the fields encodes as it did before.
	if raw, _ := json.Marshal(piHealth{Model: "m", Models: []piModel{{ID: "m"}}}); strings.Contains(string(raw), "imageInput") || strings.Contains(string(raw), `"input"`) {
		t.Fatal("new fields encoded when absent", string(raw))
	}
}

func TestOnlySingleModelTextRunsShowPictures(t *testing.T) {
	seeing := piHealth{ImageInput: true, Models: []piModel{{ID: "v", Input: []string{"text", "image"}}}}
	if !(executionSnapshot{Model: "v", Health: seeing}).seesImages() {
		t.Fatal("a seeing model was not shown pictures")
	}
	for name, s := range map[string]executionSnapshot{
		"team":      {Model: "v", Health: seeing, Team: &nodeTeam{}},
		"workspace": {Model: "v", Health: seeing, Workspace: &workspacePlan{}},
		"computer":  {Model: "v", Health: seeing, Computer: &computerPlan{}},
		"media":     {Model: "v", Health: seeing, Media: &mediaPlan{}},
		"text":      {Model: "t", Health: seeing},
	} {
		if s.seesImages() {
			t.Errorf("%s run shows pictures", name)
		}
	}
}

func TestFreezeVisionImagesMarksWhatIsShown(t *testing.T) {
	picture := func(id, contentType string, pixels int64) uploadAttachment {
		return uploadAttachment{Reference: artifactRefPrefix + id, Name: id + ".png", Kind: uploadKindImage, ContentType: contentType,
			Size: 100, SHA256: strings.Repeat("a", 64), storagePath: "t/uploads/" + strings.Repeat("a", 64) + ".bin", pixels: pixels}
	}
	attached := &uploadAttachments{Items: []uploadAttachment{
		{Reference: artifactRefPrefix + "anotes0001", Name: "notes.md", Kind: uploadKindText, ContentType: "text/markdown", Text: "hi"},
		picture("apng000001", "image/png", 100), picture("asvg000001", "image/svg+xml", 100), picture("ahuge00001", "image/jpeg", maxVisionDecodePixels+1),
		picture("ajpg000001", "image/jpeg", 100), picture("agif000001", "image/gif", 100), picture("awebp00001", "image/webp", 100),
		picture("apng000002", "image/png", 100), picture("apng000003", "image/png", 100), picture("apng000004", "image/png", 100),
	}}
	text := executionSnapshot{Model: "t", Health: piHealth{ImageInput: true, Models: []piModel{{ID: "t", Input: []string{"text"}}}}}
	freezeVisionImages(&text, attached)
	if text.Vision != nil || strings.Contains(attachmentUserPrompt("p", attached), attachmentShownPolicy) {
		t.Fatal("a text model was shown pictures")
	}
	seeing := executionSnapshot{Model: "v", Health: piHealth{ImageInput: true, Models: []piModel{{ID: "v", Input: []string{"text", "image"}}}}}
	freezeVisionImages(&seeing, attached)
	if seeing.Vision == nil || len(seeing.Vision.Images) != maxVisionImages {
		t.Fatal("pictures frozen", seeing.Vision)
	}
	got := []string{}
	for _, ref := range seeing.Vision.Images {
		got = append(got, ref.ArtifactID)
	}
	if strings.Join(got, ",") != "apng000001,ajpg000001,agif000001,awebp00001,apng000002,apng000003" {
		t.Fatal("chosen pictures", got)
	}
	shown := 0
	for _, item := range attached.Items {
		if item.Shown {
			shown++
		}
	}
	if shown != maxVisionImages || attached.Items[2].Shown || attached.Items[3].Shown || attached.Items[9].Shown {
		t.Fatal("shown marks", attached.Items)
	}
	prompt := attachmentUserPrompt("p", attached)
	if !strings.Contains(prompt, attachmentShownPolicy) || !strings.Contains(prompt, `"shown":true`) || strings.Contains(prompt, "storagePath") || strings.Contains(prompt, "pixels") {
		t.Fatal("the block tells the model what it sees, and nothing of the store", prompt)
	}
}

func TestVisionPicturePassesSmallOnesAndScalesTheRest(t *testing.T) {
	ctx := context.Background()
	small := testPicturePNG(t, 64, 40)
	if mime, out, err := visionPicture(ctx, "image/png", small); err != nil || mime != "image/png" || !bytes.Equal(out, small) {
		t.Fatal("a small picture was not sent as it is", mime, err)
	}
	// Stored as JPEG but its bytes are a PNG: re-encoded, so the type sent is the type of what is sent.
	if mime, out, err := visionPicture(ctx, "image/jpeg", small); err != nil || mime != "image/jpeg" || !bytes.HasPrefix(out, []byte{0xFF, 0xD8}) {
		t.Fatal("a mislabelled picture was passed through", mime, err)
	}
	wide := testPicturePNG(t, 3000, 1000)
	mime, out, err := visionPicture(ctx, "image/png", wide)
	if err != nil || mime != "image/jpeg" || len(out) > maxVisionImageBytes {
		t.Fatal("a wide picture was not scaled", mime, len(out), err)
	}
	if c, _, err := image.DecodeConfig(bytes.NewReader(out)); err != nil || c.Width != visionMaxSide || c.Height != 682 {
		t.Fatal("scaled size", c, err)
	}
	// A phone photo stored sideways is turned upright.
	mime, out, err = visionPicture(ctx, "image/jpeg", testRotatedJPEG(t, 40, 20, 6))
	if err != nil || mime != "image/jpeg" {
		t.Fatal("rotated photo", err)
	}
	if c, _, err := image.DecodeConfig(bytes.NewReader(out)); err != nil || c.Width != 20 || c.Height != 40 {
		t.Fatal("not turned upright", c, err)
	}
	if o := jpegOrientation(testRotatedJPEG(t, 8, 8, 3)); o != 3 {
		t.Fatal("orientation read", o)
	}
	if o := jpegOrientation(small); o != 1 {
		t.Fatal("a PNG has no orientation", o)
	}
	webp, _ := base64.StdEncoding.DecodeString(testWebP1x1)
	if mime, out, err := visionPicture(ctx, "image/webp", webp); err != nil || mime != "image/webp" || !bytes.Equal(out, webp) {
		t.Fatal("a small WebP was not sent as it is", mime, err)
	}
	if _, _, err := visionPicture(ctx, "image/png", []byte("<svg/>")); err == nil {
		t.Fatal("bytes that are no picture were shown")
	}
}

func TestVisionImagesReadBackTheFrozenBytes(t *testing.T) {
	a := &App{cfg: Config{MediaDir: t.TempDir()}}
	data := testPicturePNG(t, 16, 16)
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	if err := os.MkdirAll(filepath.Join(a.cfg.MediaDir, "tid", "uploads"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a.cfg.MediaDir, "tid", "uploads", digest+".bin"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	ref := mediaReference{ArtifactID: "apic0000001", Name: "  a\nb  ", ContentType: "image/png", Size: int64(len(data)), SHA256: digest, Path: "tid/uploads/" + digest + ".bin"}
	images, chars, err := a.visionImages(context.Background(), "tid", &visionPlan{Images: []mediaReference{ref}})
	if err != nil || len(images) != 1 || images[0].Name != "a b" || images[0].MimeType != "image/png" || images[0].Data != base64.StdEncoding.EncodeToString(data) || chars != len(images[0].Data) {
		t.Fatal("read back", err, images)
	}
	changed := ref
	changed.SHA256 = strings.Repeat("0", 64)
	if _, _, err := a.visionImages(context.Background(), "tid", &visionPlan{Images: []mediaReference{changed}}); err == nil {
		t.Fatal("a changed picture was sent")
	}
	if _, _, err := a.visionImages(context.Background(), "other", &visionPlan{Images: []mediaReference{ref}}); err == nil {
		t.Fatal("another workspace's picture was read")
	}
}
