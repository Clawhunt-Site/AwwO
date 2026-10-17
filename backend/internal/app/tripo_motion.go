package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Rigged and animated 3D models for games (Tripo's animation API, checked against it on 2026-10-17). A 3D node whose
// settings ask for a skeleton runs a chain once its model task succeeded: one rig task on the model, then up to three
// retarget tasks on the rig, each putting at most five of Tripo's preset clips on the skeleton. Each step is one Tripo
// task, sent once and recorded so a restart follows it instead of paying for it again, and followed like the model
// task; each file is downloaded as soon as its task succeeds (Tripo's links expire after five minutes) and the files are
// kept only when the whole chain succeeded. The first file carries the model and its first clips, a later one only
// clips, for the same skeleton. A failed step fails the node (media_motion_failed); a paid plan is then charged for the
// model and for the steps Tripo accepted and did not refund, and nothing for the rest (settleMotionCredits).

const (
	tripoRigEndpoint      = "/animations/rig"
	tripoRetargetEndpoint = "/animations/retarget"
	// Tripo's rig versions (measured by its SDK's authors, 2026-10-15): v3.0 rigs every skeleton type and takes the
	// humanoid, serpentine and aquatic presets but not the quadruped, hexapod and octopod ones; v2.5 rigs every type and
	// takes those, but not the humanoid presets.
	tripoRigV3  = "v3.0-20260909"
	tripoRigV25 = "v2.5-20260210"
	// A retarget task takes at most five presets.
	tripoRetargetBatch = 5
	// Three times Tripo's credits, like every 3D generation (model3DCredits): a rig costs Tripo 25, a retarget task 50,
	// charged only when the task succeeds.
	tripoRigCredits      = 75
	tripoRetargetCredits = 150
)

// tripoRigTypes are the skeletons a node can ask for: none, or one of Tripo's rig types ("others" is not offered).
var tripoRigTypes = []string{"none", "biped", "quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic"}

// tripoMotionChoices are the animation sets; any but none needs a skeleton that has presets (not avian).
var tripoMotionChoices = []string{"none", "locomotion", "combat", "full"}

// tripoHumanoidSets are the humanoid presets of each animation set, as the retarget tasks that send them, in order:
// the first task's file carries the model. The full set's first two tasks are the two Tripo's probe ran (2026-10-17),
// whose clips play on one skeleton; the last preset follows alone.
var tripoHumanoidSets = map[string][][]string{
	"locomotion": {{"preset:idle", "preset:walk", "preset:run", "preset:jump", "preset:fall"}},
	"combat":     {{"preset:idle", "preset:walk", "preset:run", "preset:slash", "preset:hurt"}},
	"full": {{"preset:idle", "preset:walk", "preset:run", "preset:slash", "preset:hurt"},
		{"preset:dive", "preset:climb", "preset:jump", "preset:fall", "preset:turn"}, {"preset:shoot"}},
}

// tripoCreaturePresets is the one preset each other skeleton with presets moves by; every animation set gives it.
var tripoCreaturePresets = map[string]string{"quadruped": "preset:quadruped:walk", "hexapod": "preset:hexapod:walk",
	"octopod": "preset:octopod:walk", "serpentine": "preset:serpentine:march", "aquatic": "preset:aquatic:march"}

// tripoLegged are the skeletons whose presets only Tripo's v2.5 rig takes.
var tripoLegged = map[string]bool{"quadruped": true, "hexapod": true, "octopod": true}

// tripoMotionParams are the 3D models' rig and animation settings. They drive the chain, never the model request
// (tripoWireParams has none of them), and validTripoModel accepts them only exactly as defined here.
func tripoMotionParams() []mediaParam {
	animated := []string{"biped", "quadruped", "hexapod", "octopod", "serpentine", "aquatic"}
	return []mediaParam{
		{Name: "rig", Type: "enum", Values: slices.Clone(tripoRigTypes), Default: "none", Label: [2]string{"骨骼", "Skeleton"},
			ValueLabels: [][2]string{{"无", "None"}, {"双足", "Biped"}, {"四足", "Quadruped"}, {"六足", "Hexapod"}, {"八足", "Octopod"},
				{"鸟类", "Bird"}, {"蛇形", "Serpent"}, {"水生", "Aquatic"}}},
		{Name: "motion", Type: "enum", Values: slices.Clone(tripoMotionChoices), Default: "none", Label: [2]string{"动作", "Animations"},
			ValueLabels: [][2]string{{"不加", "None"}, {"移动", "Locomotion"}, {"战斗", "Combat"}, {"全套", "Full set"}},
			Requires:    &mediaParamRequires{Param: "rig", Values: animated}},
		{Name: "inPlace", Type: "boolean", Default: true, Label: [2]string{"原地动作", "Animate in place"},
			Requires: &mediaParamRequires{Param: "motion", Values: slices.Clone(tripoMotionChoices[1:])}},
	}
}

// tripoMotion is a node's rig and animation chain, frozen with its run (mediaPlan.Motion), so a run resumed after a
// release follows the tasks it recorded and is charged what it was admitted at: the skeleton, the rig version that can
// animate it, the presets of each retarget task in order, whether the clips keep their root in place, and each step's
// credits.
type tripoMotion struct {
	Rig             string     `json:"rig"`
	Version         string     `json:"version"`
	Batches         [][]string `json:"batches,omitempty"`
	InPlace         bool       `json:"inPlace,omitempty"`
	RigCredits      int        `json:"rigCredits"`
	RetargetCredits int        `json:"retargetCredits"`
}

// tripoMotionFor is the chain a 3D node's resolved settings ask for: nil without a skeleton. An animation set without a
// skeleton, or on one that has no presets (avian), is refused.
func tripoMotionFor(params map[string]any) (*tripoMotion, error) {
	rig, motion := "none", "none"
	if v, ok := params["rig"].(string); ok {
		rig = v
	}
	if v, ok := params["motion"].(string); ok {
		motion = v
	}
	if !slices.Contains(tripoRigTypes, rig) || !slices.Contains(tripoMotionChoices, motion) {
		return nil, errMediaParams
	}
	if rig == "none" {
		if motion != "none" {
			return nil, errMediaParams
		}
		return nil, nil
	}
	t := &tripoMotion{Rig: rig, Version: tripoRigV3, RigCredits: tripoRigCredits, RetargetCredits: tripoRetargetCredits}
	if tripoLegged[rig] {
		t.Version = tripoRigV25
	}
	switch {
	case motion == "none":
		return t, nil
	case rig == "biped":
		for _, batch := range tripoHumanoidSets[motion] {
			t.Batches = append(t.Batches, slices.Clone(batch))
		}
	case tripoCreaturePresets[rig] != "":
		t.Batches = [][]string{{tripoCreaturePresets[rig]}}
	default:
		return nil, errMediaParams
	}
	t.InPlace = true
	if v, ok := params["inPlace"].(bool); ok {
		t.InPlace = v
	}
	return t, nil
}

var tripoPreset = regexp.MustCompile(`^preset:[a-z]{1,20}(?::[a-z]{1,20})?$`)

// validTripoMotion checks a chain read back from a stored snapshot: one this service could have frozen.
func validTripoMotion(t *tripoMotion) bool {
	if t == nil || t.Rig == "none" || !slices.Contains(tripoRigTypes, t.Rig) || (t.Version != tripoRigV3 && t.Version != tripoRigV25) ||
		len(t.Batches) > 3 || t.RigCredits < 0 || t.RetargetCredits < 0 || t.RigCredits > 10000 || t.RetargetCredits > 10000 {
		return false
	}
	for _, batch := range t.Batches {
		if len(batch) == 0 || len(batch) > tripoRetargetBatch {
			return false
		}
		for _, preset := range batch {
			if !tripoPreset.MatchString(preset) {
				return false
			}
		}
	}
	return true
}

// credits is what the whole chain adds to a generation's price.
func (t *tripoMotion) credits() int {
	if t == nil {
		return 0
	}
	return t.RigCredits + len(t.Batches)*t.RetargetCredits
}

// stepCredits is what one step costs: the rig (step 0) or a retarget task.
func (t *tripoMotion) stepCredits(step int) int {
	if step == 0 {
		return t.RigCredits
	}
	return t.RetargetCredits
}

// tripoRigRequest rigs the model a model task made, with the version that can animate the skeleton.
func tripoRigRequest(modelTask string, t *tripoMotion) map[string]any {
	return map[string]any{"input": modelTask, "model": t.Version, "rig_type": t.Rig, "spec": "tripo", "out_format": "glb"}
}

// tripoRetargetRequest puts one batch of presets on the rig a rig task made. The first batch's file carries the model;
// a later one carries the skeleton and its clips alone. In place keeps a clip's root where it starts, as a game moves
// its characters itself (measured 2026-10-17: without it walk, run, dive and climb carry the model out of frame).
func tripoRetargetRequest(rigTask string, t *tripoMotion, batch int) map[string]any {
	body := map[string]any{"input": rigTask, "animations": slices.Clone(t.Batches[batch]), "out_format": "glb", "export_with_geometry": batch == 0}
	if t.InPlace {
		body["animate_in_place"] = true
	}
	return body
}

// motionFailureCode is how a failed rig or retarget step ends its run: the operator's own conditions keep their codes
// (the balance, the key, a busy or unreachable service, the run's deadline, a service that could not record the step),
// anything else about the step is media_motion_failed.
func motionFailureCode(err error) string {
	switch code := mediaFailureCode(err); code {
	case "media_provider_balance", "media_provider_unauthorized", "media_provider_busy", "media_provider_unavailable", "media_timeout",
		"media_unavailable":
		return code
	}
	return "media_motion_failed"
}

// motionProgress is how far a run's chain got before a restart: the step tasks Tripo accepted, in order, and how many
// steps were sent. More sent than accepted means the answer to the last send was lost with the process.
type motionProgress struct {
	tasks []string
	sent  int
}

// followTripoMotion runs a 3D node's chain once its model task (model) succeeded, and settles the run: completed with
// the chain's files and the model's preview, or failed, cancelled or left for the next start. recorded says whether the
// model task is durable, so a shutdown can leave the run for the next start; progress is what a previous process did.
func (a *App) followTripoMotion(ctx context.Context, hub mediaProvider, tid, id, sid string, m *mediaModel, motion *tripoMotion, model rhTask, recorded bool, progress motionProgress) {
	// Until Tripo accepts a step, the plan is not charged for it; a step Tripo ended unbilled is given back too.
	unbilled := motion.credits()
	settle := func() {
		if unbilled > 0 {
			a.settleMotionCredits(tid, id, unbilled)
		}
	}
	// stopped reports a cancel or a shutdown. A run the next start resumes settles there; any other settles now.
	stopped := func() bool {
		halted, resumes := a.mediaHalted(ctx, id, recorded)
		if halted && !resumes {
			settle()
		}
		return halted
	}
	fail := func(code string) {
		if stopped() {
			return
		}
		settle()
		a.finish(tid, id, "failed", "", code)
	}
	var files []fetchedMedia
	var preview fetchedMedia
	defer func() {
		preview.discard()
		for i := range files {
			files[i].discard()
		}
	}()
	tmp := filepath.Join(a.cfg.MediaDir, ".tmp")
	if !mediaPathPart.MatchString(tid) || !mediaPathPart.MatchString(id) || os.MkdirAll(tmp, 0o750) != nil {
		fail("media_storage_failed")
		return
	}
	// The model's rendered preview first: its link expires before a long chain ends. It is a convenience beside the
	// model, so one that cannot be fetched leaves the result without it.
	glbs := max(1, len(motion.Batches))
	for _, r := range model.Results {
		if r.OutputType == "image" && strings.TrimSpace(r.URL) != "" {
			if f, err := a.fetchMediaFile(ctx, hub, tmp, m, glbs+1, r); err != nil {
				a.log.Warn("3D preview not stored", "event", "media_preview_skipped", "code", mediaFailureCode(err))
			} else {
				preview = f
			}
			break
		}
	}
	// Every retarget task starts from the rig task, the rig from the model task.
	rigTask := ""
	for step := 0; step <= len(motion.Batches); step++ {
		if stopped() {
			return
		}
		endpoint, body, status := tripoRigEndpoint, tripoRigRequest(model.TaskID, motion), "rigging"
		if step > 0 {
			endpoint, body, status = tripoRetargetEndpoint, tripoRetargetRequest(rigTask, motion, step-1), "animating"
		}
		var task rhTask
		switch {
		case step < len(progress.tasks):
			task = rhTask{TaskID: progress.tasks[step], Status: "RUNNING"}
		case step < progress.sent:
			// Sent before a restart that lost the answer: Tripo may have made, and billed, a task nothing here can find
			// again, and sending the step again could pay for it twice.
			fail("media_motion_failed")
			return
		default:
			// The step counts as sent before Tripo can bill it; one that cannot be marked so is not sent at all.
			if e := a.markMotionSent(ctx, tid, id, step+1); errors.Is(e, errMediaRunEnded) {
				settle()
				return
			} else if e != nil {
				a.log.Warn("motion step not recorded; not sent", "event", "media_motion_unrecorded")
				fail("media_unavailable")
				return
			}
			sent, err := submitMedia(ctx, hub, endpoint, body, func() { a.mediaStatus(ctx, tid, id, "queued") })
			if err == nil && sent.TaskID == "" {
				err = &rhError{Code: "media_provider_unavailable"}
			}
			if err != nil {
				// A busy answer created no task (submitMedia sends again only after one): the step was not sent after
				// all. Counting it back keeps a restart that finds the run waiting from failing it as a lost answer;
				// it sends the step again instead.
				if e, ok := asRHError(err); ok && e.RetryAfter > 0 && a.markMotionSent(ctx, tid, id, step) != nil {
					a.log.Warn("motion step not counted back after a busy answer", "event", "media_motion_unmarked")
				}
				fail(motionFailureCode(err))
				return
			}
			task = sent
			if a.recordMotionTask(ctx, tid, id, step, task.TaskID) != nil {
				// Following it still works in this process; only a restart could not, and it would not send it again.
				a.log.Warn("motion task id not recorded", "event", "media_motion_task_unrecorded")
			}
		}
		// Tripo has the task and may bill it from now on.
		unbilled -= motion.stepCredits(step)
		a.mediaStatus(ctx, tid, id, status)
		done, err := a.pollMedia(ctx, hub, task, nil)
		if err != nil {
			if e, ok := asRHError(err); ok && e.Unbilled {
				unbilled += motion.stepCredits(step)
			}
			fail(motionFailureCode(err))
			return
		}
		if step == 0 {
			rigTask = done.TaskID
			// The rig's own file is kept only when no clips follow: otherwise the first retarget task's carries the model.
			if len(motion.Batches) > 0 {
				continue
			}
		}
		var glb rhResult
		for _, r := range done.Results {
			if r.OutputType == "model" {
				glb = r
				break
			}
		}
		if strings.TrimSpace(glb.URL) == "" {
			fail("media_motion_failed")
			return
		}
		f, err := a.fetchMediaFile(ctx, hub, tmp, m, len(files)+1, glb)
		if err != nil {
			fail(mediaFailureCode(err))
			return
		}
		files = append(files, f)
	}
	if stopped() {
		return
	}
	a.mediaStatus(ctx, tid, id, "saving")
	output, err := a.keepMotionFiles(ctx, tid, id, sid, m, files, &preview)
	if err != nil {
		fail(mediaFailureCode(err))
		return
	}
	a.finish(tid, id, "completed", output, "")
}

// keepMotionFiles keeps a chain's files as the run's artifacts, the GLBs first (model-1.glb, model-2.glb, …) and then
// the model's preview, and returns the run's awwo.media record. A preview that cannot be kept is left out.
func (a *App) keepMotionFiles(ctx context.Context, tid, id, sid string, m *mediaModel, files []fetchedMedia, preview *fetchedMedia) (string, error) {
	d, err := a.mediaDestinationFor(ctx, tid, id, sid)
	if err != nil {
		return "", err
	}
	items := []mediaItem{}
	for i := range files {
		item, err := a.keepMediaFile(ctx, d, tid, id, m, i+1, &files[i])
		if err != nil {
			return "", err
		}
		items = append(items, item)
	}
	if preview.path != "" {
		if item, err := a.keepMediaFile(ctx, d, tid, id, m, len(files)+1, preview); err != nil {
			a.log.Warn("3D preview not stored", "event", "media_preview_skipped", "code", mediaFailureCode(err))
		} else {
			items = append(items, item)
		}
	}
	return mediaOutputRecord(m, items), nil
}

// markMotionSent records that the sent-th step of a run's chain is about to be sent (counting from 1), so a restart that
// lost its answer never sends it again. errMediaRunEnded: the run ended first (a cancel), and nothing more is sent.
func (a *App) markMotionSent(ctx context.Context, tid, id string, sent int) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	tag, e := a.db.Exec(ctx, "UPDATE runs SET media_task=COALESCE(media_task,'{}'::jsonb)||jsonb_build_object('motionSent',$3::int) WHERE tenant_id=$1 AND id=$2 AND status='running'", tid, id, sent)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		return errMediaRunEnded
	}
	return nil
}

// recordMotionTask records the task Tripo accepted for a step (counting from 0) as the step's own, so a restart follows
// it: only in its place, after every earlier step's.
func (a *App) recordMotionTask(ctx context.Context, tid, id string, step int, taskID string) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	tag, e := a.db.Exec(ctx, `UPDATE runs SET media_task=jsonb_set(COALESCE(media_task,'{}'::jsonb),'{motionTasks}',COALESCE(media_task->'motionTasks','[]'::jsonb)||to_jsonb($3::text))
		WHERE tenant_id=$1 AND id=$2 AND status='running' AND jsonb_array_length(COALESCE(media_task->'motionTasks','[]'::jsonb))=$4`, tid, id, taskID, step)
	if e == nil && tag.RowsAffected() == 0 {
		return errors.New("run is no longer running")
	}
	return e
}

// settleMotionCredits takes off a paid generation's price (credit_points, admitted for the model and the whole chain)
// what its steps that never ran, never got a task, or that Tripo ended unbilled would have cost. Once per run: a
// resumed chain settling again changes nothing. The free plan's generations have no price to settle.
func (a *App) settleMotionCredits(tid, id string, credits int) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, e := a.db.Exec(ctx, `WITH settled AS (
		UPDATE runs SET media_task=COALESCE(media_task,'{}'::jsonb)||'{"motionSettled":true}'::jsonb
		WHERE tenant_id=$1 AND id=$2 AND NOT COALESCE(media_task ? 'motionSettled',false) RETURNING tenant_id,id)
		UPDATE media_generations g SET credit_points=GREATEST(0,g.credit_points-$3) FROM settled s
		WHERE g.tenant_id=s.tenant_id AND g.run_id=s.id AND g.credit_points IS NOT NULL`, tid, id, credits); e != nil {
		a.log.Warn("motion credits not settled", "event", "media_motion_unsettled")
	}
}
