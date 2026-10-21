package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // WebP sizes and pixels, next to the standard library's PNG, JPEG and GIF
)

// Pictures a model sees (owner request 2026-10-12: 让模型直接看懂上传的图片). A message's attached pictures used to
// reach the model as a name and a pixel size only. Now, where the run's model takes images, they go with the message
// as images: a worker claims the capability in its /health ("imageInput": true) and lists, per model, the input the
// model takes ("input": ["text","image"], from the Bedrock catalog or the worker's own model settings). Anything less
// than both, or a value that cannot be read, is a text model, so a run never sends a picture to a worker or a model
// that would refuse it, in either release order.
//
// The pictures are chosen when the run is admitted and frozen with it (stored path, size, SHA-256), and the attachment
// block marks them "shown". When the run starts they are read back, checked against that digest, and sent as they are
// when small enough (at most 1.5 MiB and 2048 px on the long edge), or else decoded, turned upright, scaled to fit
// 2048 px and sent as a JPEG. A picture that cannot be read back fails the run before any call is reserved, so it
// costs nothing (image_input_unavailable). Only this message's own attachments, which already belong to this canvas,
// can be shown; the bytes go to no one but the run's own worker.

const (
	maxVisionImages = 6
	// Bedrock Converse takes a picture of at most 3.75 MB and 8000 px a side. AWS does not say whether its MB are
	// decimal, so the smaller reading bounds what is sent; the workers accept up to 3.75 MiB.
	maxVisionImageBytes = 3_750_000
	// A picture is sent unchanged when it is at most this large, at most visionMaxSide on its long edge and upright.
	// Claude scales anything past 1568 px down itself and GPT reads at most 2048, so 2048 loses nothing a model would
	// see and bounds what one picture costs.
	visionPassBytes = 1536 << 10
	visionMaxSide   = 2048
	// What is decoded is bounded: a larger file, or one of more pixels, is described by name and size, not shown.
	maxVisionSourceBytes  = 32 << 20
	maxVisionDecodePixels = 40_000_000
	visionJPEGQuality     = 85
	// What one picture counts as when a call's input is estimated from its size: 1,600 tokens, about what Claude
	// spends on a picture of 1568 px, at estimateBytesPerToken.
	visionImageEstimateBytes = 1600 * estimateBytesPerToken
	maxVisionNameRunes       = 100
)

// The picture types the workers and Bedrock take.
var visionTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// Two pictures are decoded and scaled at a time in this process.
var visionSlots = make(chan struct{}, 2)

var errVisionPicture = errors.New("picture cannot be shown")

// visionPlan is the pictures a run's model is shown, frozen at admission.
type visionPlan struct {
	Images []mediaReference `json:"images"`
}

// visionImage is one picture as a worker receives it: standard base64, no data: prefix.
type visionImage struct {
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

// modelInputKinds is a catalog model's input list when it is a well-formed one ("text", and optionally "image", each
// once) and nil otherwise: a model whose list cannot be read is a text model, never a runtime outage.
func modelInputKinds(raw json.RawMessage) []string {
	var kinds []string
	if len(bytes.TrimSpace(raw)) == 0 || json.Unmarshal(raw, &kinds) != nil || len(kinds) == 0 || len(kinds) > 2 {
		return nil
	}
	seen := map[string]bool{}
	for _, kind := range kinds {
		if (kind != "text" && kind != "image") || seen[kind] {
			return nil
		}
		seen[kind] = true
	}
	if !seen["text"] {
		return nil
	}
	return kinds
}

// modelSeesImages reports whether the worker behind h accepts pictures and its catalog says model takes them.
func (h piHealth) modelSeesImages(model string) bool {
	if !h.ImageInput {
		return false
	}
	for _, m := range h.Models {
		if m.ID == model {
			return slices.Contains(m.Input, "image")
		}
	}
	return false
}

// modelDisplayName is what a person sees for model: its catalog label, else its name, else its id.
func (h piHealth) modelDisplayName(model string) string {
	for _, m := range h.Models {
		if m.ID == model {
			for _, name := range []string{m.Label, m.Name} {
				if name = strings.TrimSpace(name); name != "" && utf8.RuneCountInString(name) <= 80 {
					return name
				}
			}
		}
	}
	return model
}

// seesImages: the single-model text runs (a node's message, a canvas run's node, the assistant's plan) whose model
// takes pictures. A team, a workspace, managed execution and a media generation carry their files their own way.
func (s executionSnapshot) seesImages() bool {
	return s.Team == nil && s.Workspace == nil && s.Computer == nil && s.Media == nil && s.Health.modelSeesImages(s.Model)
}

// freezeVisionImages picks, from a message's attachments, the pictures its run's model is shown: the first
// maxVisionImages of a type the workers take whose size and pixels can be decoded. They are marked "shown" in the
// attachment block, which must therefore be written after this.
func freezeVisionImages(snapshot *executionSnapshot, attached *uploadAttachments) {
	if attached == nil || !snapshot.seesImages() {
		return
	}
	images := []mediaReference{}
	for i := range attached.Items {
		if len(images) >= maxVisionImages {
			break
		}
		item := &attached.Items[i]
		if !showablePicture(item) {
			continue
		}
		images = append(images, mediaReference{ArtifactID: strings.TrimPrefix(item.Reference, artifactRefPrefix), Name: item.Name,
			ContentType: item.ContentType, Size: item.Size, SHA256: item.SHA256, Path: item.storagePath})
		item.Shown = true
		if snapshot.VisionFrom != "" {
			item.SeenBy = snapshot.Health.modelDisplayName(snapshot.Model)
		}
	}
	if len(images) > 0 {
		snapshot.Vision = &visionPlan{Images: images}
	}
}

// showablePicture: an attachment of a type the workers take, of a size and pixel count a run's model can be shown.
func showablePicture(item *uploadAttachment) bool {
	return item.Kind == uploadKindImage && visionTypes[item.ContentType] && item.storagePath != "" && item.Size > 0 &&
		item.Size <= maxVisionSourceBytes && len(item.SHA256) == 64 && item.pixels > 0 && item.pixels <= maxVisionDecodePixels
}

// switchToSeeingModel (owner request 2026-10-12: 附图时自动换成能看图的模型): a single-model text run whose message
// carries a picture its model cannot see runs, this once, on a model of the same worker that can. Only the run moves:
// the node keeps its model, a message without pictures stays where it was, and the snapshot remembers the model it
// left (VisionFrom). The model is taken from the worker's catalog as this workspace may use it (the entitlement is
// already applied to the snapshot's health), the free models first, then the planner's model, then catalog order. For
// a workspace with route limits (routes non-nil: a free one) a model whose route has no call left today, or is closed
// to it, is passed over, asked without locks, so the switch does not turn the message into a premium_quota_exceeded
// refusal; so is a plan-only model for a workspace without a paid plan that no platform administrator owns
// (plan_only_models.go). A model only a user may choose (userChosenProvider) is never one this moves a run to
// (seeingModels). The reservation still decides. With no such model nothing changes and the pictures are described
// in words.
// It must run before freezeVisionImages.
func (a *App) switchToSeeingModel(ctx context.Context, tx pgx.Tx, tid string, routes []byte, s *executionSnapshot, attached *uploadAttachments) error {
	if attached == nil || s.Team != nil || s.Workspace != nil || s.Computer != nil || s.Media != nil ||
		!s.Health.ImageInput || s.Health.modelSeesImages(s.Model) || !slices.ContainsFunc(attached.Items, func(item uploadAttachment) bool {
		return showablePicture(&item)
	}) {
		return nil
	}
	limits := readRouteLimits(routes)
	// A plan-only model (plan_only_models.go) is passed over the same way for a workspace without a paid plan that no
	// platform administrator owns; whether that holds is read once, only if such a model is a candidate.
	planOnlyKnown, planOnlyOutside := false, false
	for _, model := range a.seeingModels(s.Health, s.Model) {
		if a.cfg.planOnlyModel(model) {
			if !planOnlyKnown {
				plan, e := ownerPlan(ctx, tx, tid, false)
				if e == nil {
					planOnlyOutside, e = a.planOnlyClosed(ctx, tx, tid, plan)
				}
				if e != nil {
					return e
				}
				planOnlyKnown = true
			}
			if planOnlyOutside {
				continue
			}
		}
		if routes != nil {
			switch e := a.routeLimit(ctx, tx, tid, model, limits, false); {
			case errors.Is(e, errRouteQuota) || errors.Is(e, errRouteCapacity) || errors.Is(e, errFreeCapacity):
				continue
			case e != nil:
				return e
			}
		}
		budget, overhead, _ := s.Health.modelLimits(model)
		s.VisionFrom, s.Model, s.Budget, s.Overhead, s.ProseRate = s.Model, model, budget, overhead, frozenRate(s.Health.modelRate(model))
		if !s.Health.supportsEffort(model, s.Effort) {
			s.Effort = ""
		}
		return nil
	}
	return nil
}

// seeingModels are the models of h, other than current, that a run with pictures may move to, in the order tried.
func (a *App) seeingModels(h piHealth, current string) []string {
	var free, planner, rest []string
	for _, m := range h.Models {
		// A model only a user may choose (userChosenProvider) is never one a run is moved to.
		if m.ID == current || !h.modelSeesImages(m.ID) || h.userChosenOnly(m.ID) {
			continue
		}
		if _, _, ok := h.modelLimits(m.ID); !ok {
			continue
		}
		switch {
		case a.cfg.modelRoute(m.ID) == routeFree:
			free = append(free, m.ID)
		case m.ID == a.cfg.PlannerModel:
			planner = append(planner, m.ID)
		default:
			rest = append(rest, m.ID)
		}
	}
	return slices.Concat(free, planner, rest)
}

// visionImages reads a run's frozen pictures back, refusing any whose stored bytes are gone or changed, and makes
// each one a picture its worker can send. It also returns how many base64 characters they add to the request.
func (a *App) visionImages(ctx context.Context, tid string, plan *visionPlan) ([]visionImage, int, error) {
	out := make([]visionImage, 0, len(plan.Images))
	encoded := 0
	for _, ref := range plan.Images {
		if ref.Size <= 0 || ref.Size > maxVisionSourceBytes || !visionTypes[ref.ContentType] {
			return nil, 0, errVisionPicture
		}
		data, err := a.readMediaReference(tid, ref)
		if err != nil {
			return nil, 0, errVisionPicture
		}
		mimeType, picture, err := visionPicture(ctx, ref.ContentType, data)
		if err != nil {
			return nil, 0, errVisionPicture
		}
		value := base64.StdEncoding.EncodeToString(picture)
		encoded += len(value)
		out = append(out, visionImage{Name: visionName(ref.Name), MimeType: mimeType, Data: value})
	}
	return out, encoded, nil
}

// visionName is a picture's name for the worker: one line, at most maxVisionNameRunes characters.
func visionName(name string) string {
	name = strings.Join(strings.Fields(name), " ")
	if utf8.RuneCountInString(name) > maxVisionNameRunes {
		name = string([]rune(name)[:maxVisionNameRunes])
	}
	if name == "" {
		return "picture"
	}
	return name
}

// visionPicture is a picture as it is sent: data itself when it is small, upright and of the type it was stored as,
// or else decoded, turned upright, scaled to fit visionMaxSide and encoded as a JPEG on white.
func visionPicture(ctx context.Context, contentType string, data []byte) (string, []byte, error) {
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > maxVisionDecodePixels {
		return "", nil, errVisionPicture
	}
	orientation := 1
	if format == "jpeg" {
		orientation = jpegOrientation(data)
	}
	if len(data) <= visionPassBytes && max(config.Width, config.Height) <= visionMaxSide && "image/"+format == contentType && orientation == 1 {
		return contentType, data, nil
	}
	select {
	case visionSlots <- struct{}{}:
	case <-ctx.Done():
		return "", nil, ctx.Err()
	}
	defer func() { <-visionSlots }()
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", nil, errVisionPicture
	}
	bounds := src.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if long := max(w, h); long > visionMaxSide {
		w, h = max(1, w*visionMaxSide/long), max(1, h*visionMaxSide/long)
	}
	scaled := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(scaled, scaled.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.CatmullRom.Scale(scaled, scaled.Bounds(), src, bounds, draw.Over, nil)
	upright := oriented(scaled, orientation)
	for quality := visionJPEGQuality; quality >= 55; quality -= 15 {
		var out bytes.Buffer
		if err := jpeg.Encode(&out, upright, &jpeg.Options{Quality: quality}); err != nil {
			return "", nil, errVisionPicture
		}
		if out.Len() <= maxVisionImageBytes {
			return "image/jpeg", out.Bytes(), nil
		}
	}
	return "", nil, errVisionPicture
}

// jpegOrientation is a JPEG's EXIF orientation (1 to 8), or 1 when it records none: phones store most photos
// sideways and say so only here.
func jpegOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	for i := 2; i+4 <= len(data); {
		if data[i] != 0xFF {
			return 1
		}
		marker := data[i+1]
		switch {
		case marker == 0xFF: // a fill byte
			i++
			continue
		case marker == 0x01 || marker >= 0xD0 && marker <= 0xD8: // markers without a length
			i += 2
			continue
		case marker == 0xDA || marker == 0xD9: // the image data starts: no orientation before it
			return 1
		}
		size := int(data[i+2])<<8 | int(data[i+3])
		if size < 2 || i+2+size > len(data) {
			return 1
		}
		segment := data[i+4 : i+2+size]
		if marker == 0xE1 && len(segment) >= 14 && string(segment[:6]) == "Exif\x00\x00" {
			return tiffOrientation(segment[6:])
		}
		i += 2 + size
	}
	return 1
}

// tiffOrientation reads tag 0x0112 from the first directory of an EXIF TIFF block.
func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	if order.Uint16(t[2:]) != 42 {
		return 1
	}
	dir := int(order.Uint32(t[4:]))
	if dir < 8 || dir+2 > len(t) {
		return 1
	}
	for k, n := 0, int(order.Uint16(t[dir:])); k < n; k++ {
		entry := dir + 2 + 12*k
		if entry+12 > len(t) {
			return 1
		}
		if order.Uint16(t[entry:]) != 0x0112 {
			continue
		}
		if order.Uint16(t[entry+2:]) != 3 { // a SHORT
			return 1
		}
		if v := int(order.Uint16(t[entry+8:])); v >= 1 && v <= 8 {
			return v
		}
		return 1
	}
	return 1
}

// oriented is img turned upright for EXIF orientation o: 2 to 8 mirror and/or rotate it, anything else leaves it.
func oriented(img *image.RGBA, o int) *image.RGBA {
	if o < 2 || o > 8 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	ow, oh := w, h
	if o >= 5 {
		ow, oh = h, w
	}
	out := image.NewRGBA(image.Rect(0, 0, ow, oh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var nx, ny int
			switch o {
			case 2:
				nx, ny = w-1-x, y
			case 3:
				nx, ny = w-1-x, h-1-y
			case 4:
				nx, ny = x, h-1-y
			case 5:
				nx, ny = y, x
			case 6:
				nx, ny = h-1-y, x
			case 7:
				nx, ny = h-1-y, w-1-x
			case 8:
				nx, ny = y, w-1-x
			}
			out.SetRGBA(nx, ny, img.RGBAAt(b.Min.X+x, b.Min.Y+y))
		}
	}
	return out
}
