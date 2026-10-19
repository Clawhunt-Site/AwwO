package app

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

// The curated RunningHub catalog: image, video and audio models an image, video or audio node can run, each
// with the closed parameter choices checked against that model's OpenAPI request schema. It is
// embedded so the API and its catalog can never disagree, and parsed strictly at startup: a
// malformed entry stops the process instead of offering a model the API cannot drive.
//
//go:embed media_models.json
var mediaCatalogJSON []byte

const (
	mediaKindImage   = "image"
	mediaKindVideo   = "video"
	mediaKindModel3D = "model3d"
	mediaKindAudio   = "audio"
	maxMediaParams   = 16

	mediaProviderRunningHub = "runninghub"
	mediaProviderTripo      = "tripo"
	mediaProviderXtasy      = "xtasy"

	// mediaVendorShown is the only vendor the generators AwwO runs itself publish: users see 媒体 (media) models, never
	// which service or model family makes them (owner decisions 2026-10-11).
	mediaVendorShown = "media"
)

type mediaPrompt struct {
	MinLength int `json:"minLength"`
	MaxLength int `json:"maxLength"`
}

// mediaParam is one closed request field. Values are sent with the JSON type the model's schema
// declares: enum values are strings, integers are whole numbers, booleans are booleans.
type mediaParam struct {
	Name      string    `json:"name"`
	Type      string    `json:"type"`
	Values    []string  `json:"values,omitempty"`
	Min       *float64  `json:"min,omitempty"`
	Max       *float64  `json:"max,omitempty"`
	MaxLength int       `json:"maxLength,omitempty"`
	Default   any       `json:"default,omitempty"`
	Label     [2]string `json:"label"`
	// ValueLabels are the names users see for an enum's values, [Chinese, English] for each value in order. An enum
	// without them shows its values as they are.
	ValueLabels [][2]string `json:"valueLabels,omitempty"`
	// Requires makes the parameter depend on an earlier enum parameter of the same model: it applies only while that
	// one has one of Values, and otherwise stays at its default (resolveMediaParams refuses any other value). Clients
	// disable its control meanwhile, so no client needs to know what the parameters mean.
	Requires *mediaParamRequires `json:"requires,omitempty"`
}

// mediaParamRequires names the enum parameter, and the values of it, under which another parameter applies.
type mediaParamRequires struct {
	Param  string   `json:"param"`
	Values []string `json:"values"`
}

type mediaModel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Label is the name users see, [Chinese, English]. A model without one is shown by its Name in both languages.
	Label    [2]string    `json:"label"`
	Vendor   string       `json:"vendor"`
	Kind     string       `json:"kind"`
	Mode     string       `json:"mode"`
	Endpoint string       `json:"endpoint"`
	Prompt   mediaPrompt  `json:"prompt"`
	Params   []mediaParam `json:"params"`
	Docs     string       `json:"docs"`
	Verified string       `json:"verified"`
	// References is how many pictures a generation may start from (0: words only). The first image attached to the
	// message, or wired into the node's reference input, is uploaded to the provider for that one task (media_refs.go).
	References int `json:"references,omitempty"`
	// AudioReferences is how many voices a generation may take as well (0: none): the audio files wired into a video
	// node's audio input, which its words call @Audio 1, @Audio 2… and whose speaker's lips move to them (M-1c).
	AudioReferences int `json:"audioReferences,omitempty"`
	// Provider runs the model: RunningHub for the embedded catalog, Tripo for the 3D models (tripo.go).
	Provider string `json:"-"`
	// Version is the provider's own pinned model version, sent with every request (Tripo).
	Version string `json:"-"`
}

type mediaCatalog struct {
	Version  int          `json:"version"`
	Provider string       `json:"provider"`
	Source   string       `json:"source"`
	Notes    []string     `json:"notes"`
	Models   []mediaModel `json:"models"`
	byID     map[string]*mediaModel
	list     []*mediaModel
}

var (
	mediaModelID   = regexp.MustCompile(`^rh\.[a-z0-9][a-z0-9-]{0,62}$`)
	mediaVendor    = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	mediaEndpoint  = regexp.MustCompile(`^/openapi/v2(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,80}){1,4}$`)
	mediaParamName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]{0,40}$`)
	mediaDate      = regexp.MustCompile(`^(?:\d{4}-\d{2}-\d{2})?$`)
	errMediaParams = errors.New("media parameters are invalid")
)

// The fields the API owns: a parameter may never shadow the prompt or an input the API fills in.
var reservedMediaParams = map[string]bool{"prompt": true, "imageUrl": true, "imageUrls": true, "firstImageUrl": true, "lastImageUrl": true,
	"firstFrameUrl": true, "lastFrameUrl": true, "webhookUrl": true, "callbackUrl": true}

func parseMediaCatalog(raw []byte) (*mediaCatalog, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var c mediaCatalog
	if decoder.Decode(&c) != nil || c.Version != 1 || c.Provider != "runninghub" || len(c.Models) == 0 || len(c.Models) > 200 {
		return nil, errors.New("media catalog is invalid")
	}
	c.byID = map[string]*mediaModel{}
	endpoints := map[string]bool{}
	for i := range c.Models {
		m := &c.Models[i]
		if err := validMediaModel(m); err != nil {
			return nil, fmt.Errorf("media catalog entry %q is invalid: %w", m.ID, err)
		}
		if c.byID[m.ID] != nil || endpoints[m.Endpoint] {
			return nil, errors.New("media catalog ids and endpoints must be unique")
		}
		m.Provider = mediaProviderRunningHub
		c.byID[m.ID] = m
		endpoints[m.Endpoint] = true
	}
	return &c, nil
}

func validMediaModel(m *mediaModel) error {
	if !mediaModelID.MatchString(m.ID) || !cleanCatalogText(m.Name, 80) || !mediaVendor.MatchString(m.Vendor) || !mediaEndpoint.MatchString(m.Endpoint) || !mediaDate.MatchString(m.Verified) {
		return errors.New("identity")
	}
	if m.Label != ([2]string{}) && !validMediaLabel(m) {
		return errors.New("label")
	}
	if !validMediaKindMode(m.Kind, m.Mode) {
		return errors.New("kind")
	}
	// A model takes reference pictures only where its request names the field they go in (runningHubReferenceField),
	// and a model with such a field takes some: a field for a model that takes none would never be used.
	reference := runningHubReferenceField[m.ID]
	if m.References < 0 || m.References > maxRunningHubReferences || (m.References > 0) != (reference != "") {
		return errors.New("references")
	}
	// Voices the same way, and only beside pictures: RunningHub takes a voice only with a picture (or a video) given too.
	voices := runningHubAudioField[m.ID]
	if m.AudioReferences < 0 || m.AudioReferences > maxRunningHubAudioReferences || (m.AudioReferences > 0) != (voices != "") || (voices != "" && reference == "") {
		return errors.New("audio references")
	}
	if m.Prompt.MinLength < 1 || m.Prompt.MaxLength < m.Prompt.MinLength || m.Prompt.MaxLength > 32768 {
		return errors.New("prompt")
	}
	if !strings.HasPrefix(m.Docs, "https://www.runninghub.ai/runninghub-api-doc-en/") || len(m.Docs) > 200 {
		return errors.New("docs")
	}
	if len(m.Params) > maxMediaParams {
		return errors.New("too many parameters")
	}
	names := map[string]bool{}
	// Every field the request carries is sent once: a parameter's field (its own name, or its wire name) is never the
	// prompt's field, a fixed field, the reference pictures' field or another parameter's field, and the reference
	// pictures' field is neither the prompt's nor a fixed one.
	fields := map[string]bool{runningHubPromptFieldOf(m.ID): true}
	for field := range runningHubFixed[m.ID] {
		fields[field] = true
	}
	if reference != "" {
		if fields[reference] {
			return errors.New("reference field")
		}
		fields[reference] = true
	}
	if voices != "" {
		if fields[voices] {
			return errors.New("audio reference field")
		}
		fields[voices] = true
	}
	for i := range m.Params {
		p := &m.Params[i]
		field := runningHubWireName(m.ID, p.Name)
		if !mediaParamName.MatchString(p.Name) || reservedMediaParams[p.Name] || names[p.Name] || fields[field] || !cleanCatalogText(p.Label[0], 40) || !cleanCatalogText(p.Label[1], 40) {
			return fmt.Errorf("parameter %q", p.Name)
		}
		names[p.Name], fields[field] = true, true
		if err := validMediaParamSpec(p); err != nil {
			return fmt.Errorf("parameter %q: %w", p.Name, err)
		}
	}
	// A wire name for a parameter the model does not have would never be used: the mapping is stale.
	for name := range runningHubWireParams[m.ID] {
		if !names[name] {
			return fmt.Errorf("wire name for unknown parameter %q", name)
		}
	}
	return validMediaParamRequires(m.Params)
}

// mediaAudioModes are what an audio node generates from its text: speech read from it, or music it describes.
var mediaAudioModes = map[string]bool{"text-to-speech": true, "text-to-music": true}

// validMediaKindMode: an image or video model makes its kind from words (text-to-image, text-to-video); an audio model
// reads its words aloud or makes music from them.
func validMediaKindMode(kind, mode string) bool {
	switch kind {
	case mediaKindImage, mediaKindVideo:
		return mode == "text-to-"+kind
	case mediaKindAudio:
		return mediaAudioModes[mode]
	}
	return false
}

// validMediaParamRequires checks every dependency between a model's parameters: it names an enum parameter declared
// earlier (so a client resolving them in order never looks ahead), by some of that parameter's own values, each once,
// and the dependent parameter is an enum or a boolean with a default, the value it keeps while it does not apply.
func validMediaParamRequires(params []mediaParam) error {
	for i := range params {
		r := params[i].Requires
		if r == nil {
			continue
		}
		if t := params[i].Type; (t != "enum" && t != "boolean") || params[i].Default == nil || len(r.Values) == 0 {
			return fmt.Errorf("parameter %q: requires", params[i].Name)
		}
		var on *mediaParam
		for j := range params[:i] {
			if params[j].Name == r.Param {
				on = &params[j]
			}
		}
		if on == nil || on.Type != "enum" {
			return fmt.Errorf("parameter %q: requires an earlier enum", params[i].Name)
		}
		seen := map[string]bool{}
		for _, v := range r.Values {
			if seen[v] || !slices.Contains(on.Values, v) {
				return fmt.Errorf("parameter %q: requires values", params[i].Name)
			}
			seen[v] = true
		}
	}
	return nil
}

// applies reports whether a parameter with a dependency applies under the resolved values of the others.
func (p *mediaParam) applies(values map[string]any) bool {
	if p.Requires == nil {
		return true
	}
	v, ok := values[p.Requires.Param].(string)
	return ok && slices.Contains(p.Requires.Values, v)
}

func validMediaParamSpec(p *mediaParam) error {
	if len(p.ValueLabels) > 0 {
		if p.Type != "enum" || len(p.ValueLabels) != len(p.Values) {
			return errors.New("value labels")
		}
		for _, label := range p.ValueLabels {
			if !cleanCatalogText(label[0], 40) || !cleanCatalogText(label[1], 40) {
				return errors.New("value labels")
			}
		}
	}
	switch p.Type {
	case "enum":
		if len(p.Values) == 0 || len(p.Values) > 32 || p.Min != nil || p.Max != nil || p.MaxLength != 0 {
			return errors.New("enum shape")
		}
		seen := map[string]bool{}
		for _, v := range p.Values {
			if !cleanCatalogText(v, 40) || seen[v] {
				return errors.New("enum values")
			}
			seen[v] = true
		}
		if d, ok := p.Default.(string); !ok || !seen[d] {
			return errors.New("enum default")
		}
	case "integer", "number":
		if p.Min == nil || p.Max == nil || *p.Min > *p.Max || len(p.Values) != 0 || p.MaxLength != 0 {
			return errors.New("range")
		}
		if p.Type == "integer" && (*p.Min != math.Trunc(*p.Min) || *p.Max != math.Trunc(*p.Max)) {
			return errors.New("integer range")
		}
		if p.Default != nil {
			d, ok := p.Default.(float64)
			if !ok || d < *p.Min || d > *p.Max || (p.Type == "integer" && d != math.Trunc(d)) {
				return errors.New("number default")
			}
		}
	case "boolean":
		if _, ok := p.Default.(bool); !ok || len(p.Values) != 0 || p.Min != nil || p.Max != nil || p.MaxLength != 0 {
			return errors.New("boolean")
		}
	case "text":
		if p.MaxLength < 1 || p.MaxLength > 8000 || p.Default != nil || len(p.Values) != 0 || p.Min != nil || p.Max != nil {
			return errors.New("text")
		}
	default:
		return errors.New("type")
	}
	return nil
}

func cleanCatalogText(s string, max int) bool {
	if s == "" || utf8.RuneCountInString(s) > max || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f || (r >= 0x2028 && r <= 0x2029) {
			return false
		}
	}
	return true
}

// validMediaLabel: both names are set and short enough for a picker, and the Chinese one is the model's Name, which a
// client that predates labels shows instead.
func validMediaLabel(m *mediaModel) bool {
	return cleanCatalogText(m.Label[0], 40) && cleanCatalogText(m.Label[1], 40) && m.Name == m.Label[0]
}

// shownLabel is the [Chinese, English] name a client shows for the model.
func (m *mediaModel) shownLabel() [2]string {
	if m.Label == ([2]string{}) {
		return [2]string{m.Name, m.Name}
	}
	return m.Label
}

var builtinMediaCatalog = withProviderModels(mustMediaCatalog(mediaCatalogJSON))

func mustMediaCatalog(raw []byte) *mediaCatalog {
	c, err := parseMediaCatalog(raw)
	if err != nil {
		panic(err)
	}
	return c
}

// withProviderModels adds the Jimeng (jimeng.go) and X-tasy (xtasy.go) image and video models and the 3D models
// (tripo.go) to a parsed catalog, refusing to start on one that does not validate or that collides with an existing
// id, as the embedded catalog itself is refused. Jimeng's come first, then X-tasy's: a new image or video node starts
// on the first one its workspace is offered (Jimeng's only where the operator granted them, X-tasy's elsewhere).
// RunningHub's embedded models follow, each renamed to its generic name (runningHubLabels), then the 3D models.
func withProviderModels(c *mediaCatalog) *mediaCatalog {
	c.list = nil
	add := func(m *mediaModel, err error) {
		if err != nil {
			panic(fmt.Errorf("%s model %q is invalid: %w", m.Provider, m.ID, err))
		}
		if c.byID[m.ID] != nil {
			panic(fmt.Errorf("%s model %q collides with a catalog id", m.Provider, m.ID))
		}
		c.byID[m.ID] = m
		c.list = append(c.list, m)
	}
	for _, m := range jimengModels() {
		add(m, validJimengModel(m))
	}
	for _, m := range xtasyModels() {
		add(m, validXtasyModel(m))
	}
	for i := range c.Models {
		m := &c.Models[i]
		// RunningHub's models are shown like everyone else's: a generic name under the generic vendor.
		label, ok := runningHubLabels[m.ID]
		if !ok {
			panic(fmt.Errorf("runninghub model %q has no generic name", m.ID))
		}
		m.Name, m.Label, m.Vendor = label[0], label, mediaVendorShown
		if !validMediaLabel(m) {
			panic(fmt.Errorf("runninghub model %q has an invalid generic name", m.ID))
		}
		c.list = append(c.list, m)
	}
	for _, m := range tripoModels() {
		add(m, validTripoModel(m))
	}
	return c
}

// List is every model in catalog order: Jimeng's, X-tasy's, RunningHub's, then the 3D models.
func (c *mediaCatalog) List() []*mediaModel { return c.list }

func (c *mediaCatalog) model(id string) (*mediaModel, bool) {
	m, ok := c.byID[id]
	return m, ok
}

// resolveMediaParams validates a node's saved parameter values against the model and returns the
// complete request values: every parameter the model defines, with the node's choice or the
// catalog default, typed as the model's schema expects. Unknown keys, wrong types and values
// outside the closed choices are refused rather than dropped or clamped.
func (m *mediaModel) resolveMediaParams(raw json.RawMessage) (map[string]any, error) {
	given := map[string]json.RawMessage{}
	if trimmed := bytes.TrimSpace(raw); len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) {
		if len(trimmed) > 16384 || json.Unmarshal(trimmed, &given) != nil {
			return nil, errMediaParams
		}
	}
	known := map[string]bool{}
	values := map[string]any{}
	for i := range m.Params {
		p := &m.Params[i]
		known[p.Name] = true
		value, present := given[p.Name]
		if !present || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			if p.Default != nil {
				values[p.Name] = p.Default
			}
			continue
		}
		resolved, err := p.resolve(value)
		if err != nil {
			return nil, err
		}
		if resolved != nil {
			values[p.Name] = resolved
		}
	}
	for name := range given {
		if !known[name] {
			return nil, errMediaParams
		}
	}
	// A parameter that does not apply under the others' values keeps its default: a choice the generation would
	// ignore, or could not honour, is refused rather than dropped.
	for i := range m.Params {
		if p := &m.Params[i]; !p.applies(values) && values[p.Name] != p.Default {
			return nil, errMediaParams
		}
	}
	return values, nil
}

func (p *mediaParam) resolve(raw json.RawMessage) (any, error) {
	switch p.Type {
	case "enum":
		var v string
		if json.Unmarshal(raw, &v) != nil {
			return nil, errMediaParams
		}
		for _, allowed := range p.Values {
			if v == allowed {
				return v, nil
			}
		}
	case "integer", "number":
		var v float64
		if json.Unmarshal(raw, &v) != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < *p.Min || v > *p.Max {
			return nil, errMediaParams
		}
		if p.Type == "integer" {
			if v != math.Trunc(v) {
				return nil, errMediaParams
			}
			return int64(v), nil
		}
		return v, nil
	case "boolean":
		var v bool
		if json.Unmarshal(raw, &v) == nil {
			return v, nil
		}
	case "text":
		var v string
		if json.Unmarshal(raw, &v) != nil || utf8.RuneCountInString(v) > p.MaxLength || strings.ContainsRune(v, 0) {
			return nil, errMediaParams
		}
		if strings.TrimSpace(v) == "" {
			// An empty optional text field is simply not sent.
			return nil, nil
		}
		return v, nil
	}
	return nil, errMediaParams
}

// validMediaPrompt applies the model's documented prompt length (in characters).
func (m *mediaModel) validMediaPrompt(prompt string) bool {
	n := utf8.RuneCountInString(strings.TrimSpace(prompt))
	return n >= m.Prompt.MinLength && n <= m.Prompt.MaxLength && !strings.ContainsRune(prompt, 0)
}

// mediaCatalogue answers GET /tenants/{tenantId}/media: whether media generation is configured,
// and the catalog models this workspace may use, with their closed parameters. It never names
// the provider key or endpoint host, nor which provider runs a model (owner decision 2026-10-11).
func (a *App) mediaCatalogue(w http.ResponseWriter, r *http.Request) {
	entitlement, e := tenantModelEntitlement(r.Context(), a.db, r.PathValue("tenantId"))
	if e != nil {
		a.dbError(w, e)
		return
	}
	configured := a.cfg.mediaConfigured()
	models := []map[string]any{}
	if configured {
		for _, m := range builtinMediaCatalog.List() {
			if !a.cfg.mediaProviderConfigured(m.Provider) || !a.mediaEntitled(entitlement, m.ID) {
				continue
			}
			entry := map[string]any{"id": m.ID, "name": m.Name, "label": m.shownLabel(), "vendor": m.Vendor, "kind": m.Kind,
				"mode": m.Mode, "prompt": m.Prompt, "params": m.Params, "verified": m.Verified, "references": m.References}
			// Every picture such a model starts from is a subject reference, a single one included (never a first frame),
			// so a client says so instead of what a model that starts from one picture does.
			if subjectReferenceModel(m) {
				entry["referenceMode"] = "subjects"
			}
			if m.AudioReferences > 0 {
				entry["audioReferences"] = m.AudioReferences
			}
			models = append(models, entry)
		}
	}
	writeJSON(w, 200, map[string]any{"configured": configured, "available": configured && len(models) > 0, "models": models,
		"limits": map[string]any{"runsPerDay": a.cfg.MediaRunsPerDay, "timeoutSeconds": int(a.cfg.MediaTimeout.Seconds())}})
}
