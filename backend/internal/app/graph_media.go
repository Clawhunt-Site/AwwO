package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Image, video and 3D nodes in a canvas run. A media node is admitted with its graph like any other node, its model
// and parameters frozen then (mediaPlanSnapshot); its prompt is composed when its turn comes, from its own prompt and
// what its upstream nodes delivered into its context input, and cut to what its model takes. The generation is the
// same paid provider task its own Send starts: admitted under the same locks and allowances (admitMediaGeneration),
// executed by executeMedia, resumed after a restart, and published as the awwo.media record naming its stored files.
// A picture wired into the node's reference input (an upstream image node's result) is the generation's reference
// where the node's model takes one, before any picture attached to the node's own prompt (media_refs.go).

// graphMediaNode reports whether a saved node is an image, video or 3D node by its kind alone. A node of such a kind
// can still be bound to an ordinary text Agent, so what decides how a node runs is its frozen snapshot
// (frozenMediaNode) and, once it ran, whether its child run was a generation.
func graphMediaNode(n graphNode) bool {
	return n.Kind == "session" && (n.AgentKind == mediaKindImage || n.AgentKind == mediaKindVideo || n.AgentKind == mediaKindModel3D)
}

// frozenMediaNode reports whether the graph admitted node nid as a generation (its snapshot holds a media plan).
func (a *App) frozenMediaNode(ctx context.Context, tid, gid, nid string) (bool, error) {
	var media bool
	err := a.db.QueryRow(ctx, "SELECT COALESCE(execution_snapshot ? 'media',false) FROM graph_run_nodes WHERE tenant_id=$1 AND graph_id=$2 AND node_id=$3", tid, gid, nid).Scan(&media)
	return media, err
}

// graphMediaDraft is the prompt a media node's next Send would generate from: the draft of its active conversation,
// where the canvas assistant writes it too. Its file lines stay: a picture among them can be the reference, and
// admission drops the rest (freezeMediaPrompt), as a Send does.
func graphMediaDraft(n graphNode) string {
	active := "default"
	var id string
	if json.Unmarshal(n.ActiveThreadID, &id) == nil && strings.TrimSpace(id) != "" {
		active = id
	}
	var threads []struct {
		ID    any `json:"id"`
		Draft any `json:"draft"`
	}
	if json.Unmarshal(n.Threads, &threads) != nil {
		return ""
	}
	for _, thread := range threads {
		if tid, ok := thread.ID.(string); ok && tid == active {
			draft, _ := thread.Draft.(string)
			return strings.TrimSpace(draft)
		}
	}
	return ""
}

// lastMediaPrompt is what the node's latest own Send generated from, for a node whose draft is empty because that
// Send cleared it: its words and the line of the picture it started from, if any. A canvas run's own prompts are
// not read back, so their upstream text is never counted twice.
func lastMediaPrompt(ctx context.Context, q querier, tid, sid string) string {
	if sid == "" {
		return ""
	}
	var prompt string
	if q.QueryRow(ctx, `SELECT m.content FROM messages m JOIN runs r ON r.tenant_id=m.tenant_id AND r.id=m.run_id
		WHERE m.tenant_id=$1 AND m.session_id=$2 AND m.role='user' AND r.operation_id NOT LIKE 'graph:%'
		ORDER BY m.created_at DESC,m.id DESC LIMIT 1`, tid, sid).Scan(&prompt) != nil {
		return ""
	}
	return strings.TrimSpace(prompt)
}

// graphMediaPrompt is what a media node generates from in a canvas run: the pictures wired into its reference input
// (as file lines, in canvas order), its own prompt (its draft, or else its latest own Send), then each upstream
// delivery into its context input in canvas order, separated by blank lines. Upstream deliveries never contribute a
// file line. The model's length limits and which pictures it takes are applied at admission (admitGraphMedia).
func (a *App) graphMediaPrompt(ctx context.Context, tid, sid string, n graphNode, d graphDocument, outputs map[string]string) (string, error) {
	nodes := map[string]graphNode{}
	for _, v := range d.Nodes {
		nodes[v.ID] = v
	}
	deps, refs := []graphEdge{}, []graphEdge{}
	for _, e := range d.Edges {
		switch {
		case e.ToNode == n.ID && e.ToPort == "context":
			deps = append(deps, e)
		case e.ToNode == n.ID && e.ToPort == "reference":
			refs = append(refs, e)
		}
	}
	inCanvasOrder := func(edges []graphEdge) {
		sort.SliceStable(edges, func(i, j int) bool {
			x, y := nodes[edges[i].FromNode], nodes[edges[j].FromNode]
			if x.Y != y.Y {
				return x.Y < y.Y
			}
			if x.X != y.X {
				return x.X < y.X
			}
			return edges[i].ID < edges[j].ID
		})
	}
	inCanvasOrder(deps)
	inCanvasOrder(refs)
	parts := []string{}
	if lines := wiredReferenceLines(refs, outputs); lines != "" {
		parts = append(parts, lines)
	}
	own := graphMediaDraft(n)
	if own == "" {
		own = lastMediaPrompt(ctx, a.db, tid, sid)
	}
	if own != "" {
		parts = append(parts, own)
	}
	for _, e := range deps {
		src := nodes[e.FromNode]
		out := stripReasoningPreamble(outputs[e.FromNode])
		if src.Contract != nil {
			v, err := graphOutput(src, out)
			if err != nil {
				return "", err
			}
			out = v[strings.TrimPrefix(e.FromPort, "out:")]
		}
		if out = strings.TrimSpace(stripAttachmentLines(out)); out != "" {
			parts = append(parts, out)
		}
	}
	return strings.Join(parts, "\n\n"), nil
}

// wiredReferenceLines are the file lines of the pictures upstream image nodes delivered into a reference input,
// read from their awwo.media records (any other delivery has no picture to offer and adds nothing).
func wiredReferenceLines(edges []graphEdge, outputs map[string]string) string {
	lines := []string{}
	for _, e := range edges {
		var record struct {
			Type  string      `json:"type"`
			Items []mediaItem `json:"items"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(outputs[e.FromNode])), &record) != nil || record.Type != mediaOutputType {
			continue
		}
		for _, item := range record.Items {
			if strings.HasPrefix(item.ContentType, "image/") && uploadRefPattern.MatchString(artifactRefPrefix+item.ArtifactID) {
				lines = append(lines, mediaReferenceLines([]mediaReference{{ArtifactID: item.ArtifactID, Name: item.Name}}))
			}
		}
	}
	return strings.Join(lines, "\n")
}

func firstRunes(text string, max int) string {
	if max < 0 || utf8.RuneCountInString(text) <= max {
		return text
	}
	return string([]rune(text)[:max])
}

// mediaDeliveryText is how a media node's delivery reads in a downstream node's prompt: the files it stored, by the
// path a page can name them with (<node id>/<file name>, which AwwO's previews resolve), never the raw record.
func mediaDeliveryText(n graphNode, output string) string {
	var record struct {
		Type  string      `json:"type"`
		Kind  string      `json:"kind"`
		Items []mediaItem `json:"items"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(output)), &record) != nil || record.Type != mediaOutputType || len(record.Items) == 0 {
		return output
	}
	title := strings.TrimSpace(n.Title)
	if title == "" {
		title = n.ID
	}
	lines := []string{fmt.Sprintf("「%s」生成的%s文件（存放在这张画布的成果里，这里只列文件，不含内容）：", title, map[string]string{mediaKindImage: "图片", mediaKindVideo: "视频", mediaKindModel3D: "3D 模型"}[record.Kind])}
	for _, item := range record.Items {
		lines = append(lines, fmt.Sprintf("- %s/%s（%s，%d 字节）", n.ID, item.Name, item.ContentType, item.Size))
	}
	lines = append(lines, "网页可以用上面的相对路径引用这些文件，AwwO 的预览会换成真实文件；不要编造其他文件名。")
	return strings.Join(lines, "\n")
}

// mediaMissingText is what a downstream input reads from a media node that made no file this time (it failed, was
// refused or cancelled, or never ran): the node goes on without it (softMediaEdge), told that no path exists.
func mediaMissingText(n graphNode) string {
	title := strings.TrimSpace(n.Title)
	if title == "" {
		title = n.ID
	}
	kind := map[string]string{mediaKindImage: "图片", mediaKindVideo: "视频", mediaKindModel3D: "3D 模型"}[n.AgentKind]
	if kind == "" {
		kind = "媒体"
	}
	return fmt.Sprintf("「%s」这次没有生成出%s文件，没有可以引用的路径：网页里不要引用它的任何文件，也不要编造文件名，用不依赖它的设计完成。", title, kind)
}

// admitGraphMedia admits a media node's generation inside admitGraphChild's transaction, after the workspace's runs
// at once (and an entitled plan's slot) were counted there. Any refusal settles the node failed with its code; only
// a session still busy with another run waits. op is the run's operation (graphChildOperationID): a retried node's
// next generation is admitted here like its first, on the same allowances.
func (a *App) admitGraphMedia(ctx context.Context, tx pgx.Tx, tid, gid, nid, sid, actor, op, prompt string, snap executionSnapshot, entitlement modelEntitlement, paid bool, routes routeLimits, own workspaceLimits) error {
	plan := snap.Media
	m, ok := builtinMediaCatalog.model(plan.Model)
	if !ok || m.Kind != plan.Kind || m.Provider != plan.Provider {
		return errors.New("snapshot_invalid")
	}
	// Frozen when the graph was admitted, which can be long before now: the provider and the workspace's allowlist
	// are read again, as restamp does for a text node.
	if !a.cfg.mediaProviderConfigured(m.Provider) {
		return errors.New("media_unavailable")
	}
	if !a.mediaEntitled(entitlement, plan.Model) {
		return errors.New("model_not_allowed")
	}
	var canvasID string
	if e := tx.QueryRow(ctx, "SELECT canvas_id FROM node_sessions WHERE tenant_id=$1 AND id=$2", tid, sid).Scan(&canvasID); e != nil {
		return e
	}
	var e error
	if prompt, e = a.freezeMediaPrompt(ctx, tx, tid, canvasID, prompt, plan, true); e != nil {
		var input setupError
		if errors.As(e, &input) {
			return errors.New(input.code)
		}
		return e
	}
	if e := a.mediaStorageReady(); e != nil {
		var input setupError
		if errors.As(e, &input) {
			return errors.New(input.code)
		}
		return e
	}
	var busy bool
	if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM runs WHERE tenant_id=$1 AND session_id=$2 AND status IN ('queued','running'))", tid, sid).Scan(&busy); e != nil {
		return e
	}
	if busy {
		return errGraphCapacity
	}
	// A free workspace's daily runs hold its generations too, as a Send's admission counts them (createRun).
	if !paid && own.today >= own.daily {
		return errors.New("quota_exceeded")
	}
	billing, e := a.admitMediaGeneration(ctx, tx, tid, snap, routes, paid, true, own)
	var refusal *mediaRefusal
	if errors.As(e, &refusal) {
		return errors.New(refusal.code)
	}
	if e != nil {
		return e
	}
	rid := randomID()
	task, _ := json.Marshal(map[string]string{"provider": plan.Provider, "model": plan.Model})
	if _, e = tx.Exec(ctx, "INSERT INTO runs(id,tenant_id,session_id,operation_id,request_hash,prompt,status,media_task) VALUES($1,$2,$3,$4,$5,$6,'queued',$7)", rid, tid, sid, op, tokenHash(prompt), prompt, task); e != nil {
		return e
	}
	if e = saveRunSnapshot(ctx, tx, tid, rid, actor, snap); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO media_generations(run_id,tenant_id,model,created_at,credit_points,billed_user_id,billed_period_start) VALUES($1,$2,$3,clock_timestamp(),$4,$5,$6)", rid, tid, plan.Model, billing.credits, billing.billedUser, billing.billedPeriod); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO messages(id,tenant_id,session_id,run_id,role,content) VALUES($1,$2,$3,$4,'user',$5)", randomID(), tid, sid, rid, prompt); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO run_events(tenant_id,run_id,data) VALUES($1,$2,$3)", tid, rid, `{"type":"queued"}`); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, graphNodeAdmittedSQL, tid, gid, nid, rid); e != nil {
		return e
	}
	if e = audit(ctx, tx, actor, tid, "graph.node.accepted", rid); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	a.notifyRunEvent(rid)
	a.observeGraphNodeState("running")
	a.dispatchFor(a.cfg.MediaTimeout, tid, rid, "graph", func(ctx context.Context) {
		a.execute(ctx, tid, rid, sid, prompt, "", "graph", 0, 0)
	}, ctx)
	return nil
}

// workspaceRunsToday counts the workspace's model calls and generations today, as a Send's admission does (createRun).
func (a *App) workspaceRunsToday(ctx context.Context, q querier, tid string) (int, error) {
	var today int
	err := q.QueryRow(ctx, "SELECT (SELECT "+dailyCalls("$2", "true")+" FROM model_invocations mi WHERE mi.tenant_id=$1 AND mi.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+(SELECT count(*) FROM media_generations g WHERE g.tenant_id=$1 AND g.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND "+generationCounts+")", tid, a.cfg.PlannerModel).Scan(&today)
	return today, err
}
