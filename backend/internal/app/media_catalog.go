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
	"strings"
	"unicode/utf8"
)

// The curated RunningHub catalog: image and video models an image or video node can run, each
// with the closed parameter choices checked against that model's OpenAPI request schema. It is
// embedded so the API and its catalog can never disagree, and parsed strictly at startup: a
// malformed entry stops the process instead of offering a model the API cannot drive.
//
//go:embed media_models.json
var mediaCatalogJSON []byte

const (
	mediaKindImage = "image"
	mediaKindVideo = "video"
	maxMediaParams = 16
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
}

type mediaModel struct {
	ID       string       `json:"id"`
	Name     string       `json:"name"`
	Vendor   string       `json:"vendor"`
	Kind     string       `json:"kind"`
	Mode     string       `json:"mode"`
	Endpoint string       `json:"endpoint"`
	Prompt   mediaPrompt  `json:"prompt"`
	Params   []mediaParam `json:"params"`
	Docs     string       `json:"docs"`
	Verified string       `json:"verified"`
}

type mediaCatalog struct {
	Version  int          `json:"version"`
	Provider string       `json:"provider"`
	Source   string       `json:"source"`
	Notes    []string     `json:"notes"`
	Models   []mediaModel `json:"models"`
	byID     map[string]*mediaModel
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
		c.byID[m.ID] = m
		endpoints[m.Endpoint] = true
	}
	return &c, nil
}

func validMediaModel(m *mediaModel) error {
	if !mediaModelID.MatchString(m.ID) || !cleanCatalogText(m.Name, 80) || !mediaVendor.MatchString(m.Vendor) || !mediaEndpoint.MatchString(m.Endpoint) || !mediaDate.MatchString(m.Verified) {
		return errors.New("identity")
	}
	if (m.Kind != mediaKindImage && m.Kind != mediaKindVideo) || m.Mode != "text-to-"+m.Kind {
		return errors.New("kind")
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
	for i := range m.Params {
		p := &m.Params[i]
		if !mediaParamName.MatchString(p.Name) || reservedMediaParams[p.Name] || names[p.Name] || !cleanCatalogText(p.Label[0], 40) || !cleanCatalogText(p.Label[1], 40) {
			return fmt.Errorf("parameter %q", p.Name)
		}
		names[p.Name] = true
		if err := validMediaParamSpec(p); err != nil {
			return fmt.Errorf("parameter %q: %w", p.Name, err)
		}
	}
	return nil
}

func validMediaParamSpec(p *mediaParam) error {
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

var builtinMediaCatalog = mustMediaCatalog(mediaCatalogJSON)

func mustMediaCatalog(raw []byte) *mediaCatalog {
	c, err := parseMediaCatalog(raw)
	if err != nil {
		panic(err)
	}
	return c
}

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
// the provider key or endpoint host.
func (a *App) mediaCatalogue(w http.ResponseWriter, r *http.Request) {
	entitlement, e := tenantModelEntitlement(r.Context(), a.db, r.PathValue("tenantId"))
	if e != nil {
		a.dbError(w, e)
		return
	}
	configured := a.cfg.mediaConfigured()
	models := []map[string]any{}
	if configured {
		for i := range builtinMediaCatalog.Models {
			m := &builtinMediaCatalog.Models[i]
			if !a.mediaEntitled(entitlement, m.ID) {
				continue
			}
			models = append(models, map[string]any{"id": m.ID, "name": m.Name, "vendor": m.Vendor, "kind": m.Kind, "mode": m.Mode,
				"prompt": m.Prompt, "params": m.Params, "verified": m.Verified})
		}
	}
	writeJSON(w, 200, map[string]any{"provider": "runninghub", "configured": configured, "available": configured && len(models) > 0, "models": models,
		"limits": map[string]any{"runsPerDay": a.cfg.MediaRunsPerDay, "timeoutSeconds": int(a.cfg.MediaTimeout.Seconds())}})
}
