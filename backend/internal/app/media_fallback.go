package app

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
)

// X-tasy's and RunningHub's image and video models back each other up (owner 2026-10-22: 「媒体模型失败就换runninghub,
// 两个互为备选」): a generation its provider fails for a reason on the operator's side (its key, its balance, a model or
// a service it does not have now, a task it failed or lost) is made once more by the other provider's model of the
// same kind, frozen with the run as a backup when it was admitted. A backup is used only where it makes what the run
// asked for: its shape, sharpness, number of pictures, length and sound (mediaBackupParams), its reference pictures
// and voices and its words (mediaBackupFor), on a model the workspace may use. Nothing is sent to the backup while
// the first provider may still hold a task for the generation, except one it failed or lost; the run is charged
// once, at the price of the model it was admitted on.

// mediaBackupModels lists, for each X-tasy and RunningHub model with one, the other provider's models that may make
// its generation instead, in order: the same model where the other provider has it, then the nearest one of the same
// kind. One backup is tried at most: the first of these that can make the run as it stands.
var mediaBackupModels = map[string][]string{
	// Seedream 5.0 Pro; RunningHub's makes square pictures only (mediaImplied), so a picture of another shape goes to
	// Nano Banana 2.
	"xt.seedream-5-pro":         {"rh.seedream-v5-pro", "rh.nano-banana-2"},
	"xt.gemini-3-1-flash-image": {"rh.nano-banana-2"},
	"xt.gpt-image-2-5":          {"rh.gpt-image-2"},
	"xt.xtasy-3":                {"rh.nano-banana-2"},
	"xt.xtasy-3-pro":            {"rh.nano-banana-2"},
	"xt.omni-image-5-pro":       {"rh.seedream-v5-pro", "rh.nano-banana-2"},
	// A clip from words goes to Seedance 2.0's text-to-video, one from pictures to its multimodal video.
	"xt.omni-video":     {"rh.seedance-2", "rh.seedance-2-multimodal"},
	"xt.omni-video-2-5": {"rh.seedance-2", "rh.seedance-2-multimodal"},

	"rh.seedream-v5-pro":       {"xt.seedream-5-pro"},
	"rh.nano-banana-2":         {"xt.gemini-3-1-flash-image"},
	"rh.nano-banana-pro":       {"xt.gemini-3-1-flash-image"},
	"rh.gpt-image-2":           {"xt.gpt-image-2-5"},
	"rh.seedance-2":            {"xt.omni-video", "xt.omni-video-2-5"},
	"rh.seedance-2-multimodal": {"xt.omni-video", "xt.omni-video-2-5"},
}

// mediaBackup is a model frozen with a run to make its generation if the first provider fails it: the model, its
// provider and its complete parameters, carried over from the run's own (mediaBackupParams).
type mediaBackup struct {
	Provider string         `json:"provider"`
	Model    string         `json:"model"`
	Params   map[string]any `json:"params"`
}

// mediaSettingMeanings are the settings a backup must make as the run asked, by what they mean, under the names the
// catalogs give them: a picture's or a clip's shape and sharpness, how many pictures, a clip's length and its sound.
// A model's other parameters (a file format, a quality, a seed, a negative prompt) are carried by none: one the run
// left at its default leaves the backup at its own default, and one the run chose refuses every backup, since none is
// known to make it (mediaBackupParams).
var mediaSettingMeanings = map[string]string{"aspectRatio": "ratio", "ratio": "ratio", "resolution": "resolution",
	"imageNum": "count", "duration": "duration", "generateAudio": "sound", "sound": "sound"}

// mediaImplied are settings a model makes without a parameter for them: RunningHub's Seedream 5.0 Pro takes a
// resolution and no shape, and makes square pictures. A model without a count makes one picture (mediaBackupParams).
var mediaImplied = map[string]map[string]string{"rh.seedream-v5-pro": {"ratio": "1:1"}}

// mediaBackupParams carries a run's settings over to a backup model: each setting the run made (mediaSettingMeanings, and
// what its model makes without a parameter, mediaImplied) must be one the backup makes, under the backup's own name
// and spelling (2K and 2k are one resolution); the backup's other parameters keep their defaults. It returns the
// backup's complete parameters, or false when the backup cannot make the run as it was asked.
func mediaBackupParams(from, to *mediaModel, params map[string]any) (map[string]any, bool) {
	want := map[string]string{}
	for meaning, value := range mediaImplied[from.ID] {
		want[meaning] = value
	}
	for i := range from.Params {
		p := &from.Params[i]
		meaning := mediaSettingMeanings[p.Name]
		value, ok := params[p.Name]
		if !ok || !p.applies(params) {
			continue
		}
		text := mediaSettingText(value)
		// A setting no backup is known to make refuses them all once the run chose it (a quality that also sets the
		// price, the user's own negative prompt, a lossless format, a seed).
		if meaning == "" {
			if text == "" || text != mediaSettingText(p.Default) {
				return nil, false
			}
			continue
		}
		if text == "" {
			return nil, false
		}
		// An automatic shape lets the model choose one: the backup's own default is as good.
		if meaning == "ratio" && strings.EqualFold(text, "auto") {
			continue
		}
		want[meaning] = text
	}
	given := map[string]any{}
	for i := range to.Params {
		p := &to.Params[i]
		meaning := mediaSettingMeanings[p.Name]
		text, ok := want[meaning]
		if meaning == "" || !ok {
			continue
		}
		value, fits := p.settingValue(text)
		if !fits {
			return nil, false
		}
		given[p.Name] = value
		delete(want, meaning)
	}
	// What the backup has no parameter for, it must make anyway: one picture, or what it makes without one.
	for meaning, text := range want {
		if implied, ok := mediaImplied[to.ID][meaning]; ok && strings.EqualFold(implied, text) {
			continue
		}
		if meaning == "count" && text == "1" {
			continue
		}
		return nil, false
	}
	raw, err := json.Marshal(given)
	if err != nil {
		return nil, false
	}
	resolved, err := to.resolveMediaParams(raw)
	if err != nil {
		return nil, false
	}
	return resolved, true
}

// mediaSettingText is a resolved setting's value as text, the way mediaParam.settingValue reads it ("" for a type no
// setting has).
func mediaSettingText(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(x, 10)
	case int:
		return strconv.Itoa(x)
	}
	return ""
}

// settingValue is a setting's value under this parameter's own spelling and type, if the parameter takes it: an
// enum's value whatever its case (2K, 2k), a number within its range (an integer a whole one), a boolean.
func (p *mediaParam) settingValue(text string) (any, bool) {
	switch p.Type {
	case "enum":
		for _, v := range p.Values {
			if strings.EqualFold(v, text) {
				return v, true
			}
		}
	case "integer", "number":
		n, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || p.Min == nil || p.Max == nil || n < *p.Min || n > *p.Max ||
			(p.Type == "integer" && n != math.Trunc(n)) {
			return nil, false
		}
		return n, true
	case "boolean":
		if text == "true" || text == "false" {
			return text == "true", true
		}
	}
	return nil, false
}

// mediaBackupsFor are the backups frozen with a run of model m at params: each model mediaBackupModels lists for it
// that makes the same kind of output at the other provider, which this deployment runs and the workspace may use, and
// that makes the run's settings. A canvas run's words and pictures are known only when its node's turn comes, so
// those are checked when a backup is about to be used (mediaBackupFor).
func (a *App) mediaBackupsFor(m *mediaModel, params map[string]any, entitlement modelEntitlement) []mediaBackup {
	var out []mediaBackup
	for _, id := range mediaBackupModels[m.ID] {
		b, ok := builtinMediaCatalog.model(id)
		if !ok || b.Kind != m.Kind || b.Provider == m.Provider || !a.cfg.mediaProviderConfigured(b.Provider) || !a.mediaEntitled(entitlement, id) {
			continue
		}
		if p, ok := mediaBackupParams(m, b, params); ok {
			out = append(out, mediaBackup{Provider: b.Provider, Model: b.ID, Params: p})
		}
	}
	return out
}

// mediaBackupFor is the first backup frozen with plan that can make the generation as it stands: a model the release
// still lists for the run's (mediaBackupModels) and still has, its parameters valid for it, the run's words within its
// bounds and every reference picture and voice of the run one it takes, read as the run's own model reads them: a
// video model reads a single picture as its first frame (X-tasy's) or as the subject to keep (RunningHub's multimodal
// video, subjectReferenceModel), so a single picture goes only to a backup that reads it the same way. It returns the
// backup's model and the run's plan on it.
func mediaBackupFor(plan *mediaPlan, text string) (*mediaModel, *mediaPlan, bool) {
	from, _ := builtinMediaCatalog.model(plan.Model)
	pictures := 0
	for _, ref := range plan.References {
		if !strings.HasPrefix(ref.ContentType, "audio/") {
			pictures++
		}
	}
	for _, b := range plan.Backups {
		m, ok := builtinMediaCatalog.model(b.Model)
		if !ok || m.Provider != b.Provider || m.Kind != plan.Kind || m.Provider == plan.Provider || !slices.Contains(mediaBackupModels[plan.Model], b.Model) {
			continue
		}
		if plan.Kind == mediaKindVideo && pictures == 1 && subjectReferenceModel(m) != subjectReferenceModel(from) {
			continue
		}
		raw, err := json.Marshal(b.Params)
		if err != nil {
			continue
		}
		params, err := m.resolveMediaParams(raw)
		if err != nil || !mediaPromptAccepted(m, text, plan.References) || !mediaReferencesFit(m, plan.References) {
			continue
		}
		route := *plan
		route.Provider, route.Model, route.Params, route.Backups = m.Provider, m.ID, params, nil
		return m, &route, true
	}
	return nil, nil, false
}

// mediaResumedBackup is the backup of plan whose task a restart finds the run waiting on (markMediaBackup), for the
// restart to follow it on that provider: its model and the run's plan on it.
func mediaResumedBackup(plan *mediaPlan, model string) (*mediaModel, *mediaPlan, bool) {
	for _, b := range plan.Backups {
		if b.Model != model {
			continue
		}
		m, ok := builtinMediaCatalog.model(b.Model)
		if !ok || m.Provider != b.Provider || m.Kind != plan.Kind {
			return nil, nil, false
		}
		route := *plan
		route.Provider, route.Model, route.Params, route.Backups = m.Provider, m.ID, b.Params, nil
		return m, &route, true
	}
	return nil, nil, false
}

// mediaReferencesFit reports whether model m takes every frozen reference of a run: no more pictures and voices than
// it takes, each of a type and size its provider reads, and a voice only beside a picture (RunningHub reads one only
// there).
func mediaReferencesFit(m *mediaModel, refs []mediaReference) bool {
	pictures, voices := 0, 0
	for _, ref := range refs {
		if ref.Size > mediaReferenceLimit(m.Provider) {
			return false
		}
		if strings.HasPrefix(ref.ContentType, "audio/") {
			voices++
			if !mediaAudioReferenceTypes[m.Provider][ref.ContentType] {
				return false
			}
			continue
		}
		pictures++
		if !mediaReferenceTypes[m.Provider][ref.ContentType] {
			return false
		}
	}
	return pictures <= m.References && voices <= m.AudioReferences && (voices == 0 || pictures > 0)
}

// mediaBackupCodes are the failures a backup may make good: the provider's own (its key, its balance, a model or a
// service it does not have now or that was busy, a request it could not take, a task it failed, lost or let expire)
// and a provider this deployment does not run. A refusal of the request's content is final (media_content_rejected,
// media_real_person_rejected): another provider is not asked to make what one refused. So is a reference that could
// not be used (media_reference_unavailable): its stored file is gone or changed, or the provider rejected the picture
// itself, which a backup would be sent the same. The callers allow a backup only where the first provider holds no
// task that could still be charged: before any task existed (a reference upload, a submission answered with no task),
// or after the provider said the task ended (rhError.Ended), not when it only failed to say how the task is doing.
var mediaBackupCodes = map[string]bool{"media_unavailable": true, "media_provider_unauthorized": true, "media_provider_balance": true,
	"media_provider_unavailable": true, "media_provider_busy": true, "media_request_invalid": true, "media_credit_ceiling": true,
	"media_params_invalid": true, "media_failed": true, "media_task_missing": true, "media_result_unavailable": true, "media_timeout": true}

// markMediaBackup records, before a backup is sent, that a run's generation moves to it after its first route ended as
// first, and returns what that route leaves the backup's (mediaPrior). The run's media task names the backup's
// provider and model, so a restart resumes the backup's task (resumeMedia), with the first route's code, task id and
// charge beside them, and keeps the time the generation was first sent (or the run began), so the backup runs within
// the run's own deadline. The generation is one logical one, however many providers try it (generationCounts,
// creditsSpentSQL), and it never stops counting or holding its plan's credits on the way (settleMedia):
//   - first sent to no provider that took it (refused, an upload refused, no client): it is again one not yet sent,
//     which markMediaSubmitted marks sent: a cancel before the backup's send, or the backup's refusal, gives the free
//     attempt back and costs nothing, and the backup's acceptance charges the plan;
//   - taken by the first provider (its row says so, or its submission's answer named a task that ended: first.taken):
//     it keeps counting, as one its provider accepted does even when refunded; a charge that provider made stands
//     (prior.charged), and one it refunded (first.unbilled, not yet written) becomes the backup's to make.
//
// The run's row is locked while it is checked and marked, as markMediaSubmitted does: a cancel either comes first,
// and nothing is sent (errMediaRunEnded), or after.
func (a *App) markMediaBackup(ctx context.Context, tid, id, from string, to *mediaPlan, first mediaOutcome) (mediaPrior, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return mediaPrior{}, e
	}
	defer tx.Rollback(context.Background())
	var status string
	if e = tx.QueryRow(ctx, "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, id).Scan(&status); e != nil {
		return mediaPrior{}, e
	}
	if status != "queued" && status != "running" {
		return mediaPrior{}, errMediaRunEnded
	}
	var accepted *bool
	if e = tx.QueryRow(ctx, "SELECT provider_accepted FROM media_generations WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE", tid, id).Scan(&accepted); noRows(e) {
		return mediaPrior{}, errors.New("generation row missing")
	} else if e != nil {
		return mediaPrior{}, e
	}
	prior := mediaPrior{accepted: accepted != nil || first.taken, charged: accepted != nil && *accepted && !first.unbilled, backup: true}
	if _, e = tx.Exec(ctx, `UPDATE runs SET media_task=jsonb_strip_nulls(jsonb_build_object('provider',$3::text,'model',$4::text,
		'backupFrom',$5::text,'backupFor',$6::text,'firstTaskId',media_task->>'taskId','firstCharged',CASE WHEN $7::boolean THEN true END,
		'submittedAt',COALESCE(media_task->>'submittedAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))))
		WHERE tenant_id=$1 AND id=$2`, tid, id, to.Provider, to.Model, from, first.code, prior.charged); e != nil {
		return mediaPrior{}, e
	}
	if _, e = tx.Exec(ctx, `UPDATE media_generations SET provider_refused=false,
		submitted_at=CASE WHEN $3::boolean THEN submitted_at END,
		provider_accepted=CASE WHEN $4::boolean THEN true END WHERE tenant_id=$1 AND run_id=$2`, tid, id, prior.accepted, prior.charged); e != nil {
		return mediaPrior{}, e
	}
	return prior, tx.Commit(ctx)
}
