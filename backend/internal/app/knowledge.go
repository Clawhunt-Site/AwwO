package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const maxKnowledgeContent = 256 << 10
const maxKnowledgeSnapshotBytes = 4 << 20
const maxKnowledgeHistoryBytes = 2 << 20
const knowledgeOriginJSON = `jsonb_build_object('id',o.id::text,'title',o.title,'sourceUri',o.source_uri,'provenance',o.provenance,'createdAt',o.created_at)`
const knowledgeDocumentJSON = `jsonb_build_object('id',d.id,'kind',d.kind,'title',d.title,'content',v.content,'version',d.version,'currentRevisionId',v.id,'contentHash',v.content_hash,'sourceUri',v.source_uri,'provenance',v.provenance || CASE WHEN d.kind='source' THEN jsonb_build_object(
 'origins',COALESCE((SELECT jsonb_agg(x.value) FROM (SELECT ` + knowledgeOriginJSON + ` AS value FROM knowledge_source_origins o WHERE o.tenant_id=d.tenant_id AND o.document_id=d.id ORDER BY o.id DESC LIMIT 32) x),'[]'::jsonb),
 'originCount',(SELECT count(*) FROM knowledge_source_origins o WHERE o.tenant_id=d.tenant_id AND o.document_id=d.id),
 'originsTruncated',(SELECT count(*)>32 FROM knowledge_source_origins o WHERE o.tenant_id=d.tenant_id AND o.document_id=d.id)) ELSE '{}'::jsonb END,'createdAt',d.created_at,'updatedAt',d.updated_at)`
const knowledgeRevisionJSON = `jsonb_build_object('id',v.id,'documentId',v.document_id,'version',v.version,'parentRevisionId',v.parent_revision_id,'title',v.title,'content',v.content,'contentHash',v.content_hash,'sourceUri',v.source_uri,'provenance',v.provenance,'links',v.links,'createdAt',v.created_at)`
const knowledgeProposalJSON = `jsonb_build_object('id',p.id,'documentId',p.document_id,'kind',p.kind,'title',p.title,'content',p.content,'baseVersion',p.base_version,'status',p.status,'sourceIds',p.source_ids,'links',p.links,'sourceUri',p.source_uri,'provenance',p.provenance,'acceptedDocumentId',p.accepted_document_id,'createdAt',p.created_at,'resolvedAt',p.resolved_at)`
const knowledgeLinkJSON = `jsonb_build_object('id',id,'fromDocumentId',from_document_id,'toDocumentId',to_document_id,'relation',relation,'revisionId',revision_id)`

type knowledgeLinkInput struct {
	ToDocumentID string `json:"toDocumentId"`
	Relation     string `json:"relation"`
}
type knowledgeSourceInput struct {
	Title       string `json:"title"`
	Content     string `json:"content"`
	SourceURI   string `json:"sourceUri"`
	ArtifactID  string `json:"artifactId"`
	OperationID string `json:"operationId"`
}
type knowledgeProposalInput struct {
	DocumentID        string               `json:"documentId"`
	Kind              string               `json:"kind"`
	Title             string               `json:"title"`
	Content           string               `json:"content"`
	SourceURI         string               `json:"sourceUri"`
	ArtifactID        string               `json:"artifactId"`
	BaseVersion       int64                `json:"baseVersion"`
	SourceIDs         []string             `json:"sourceIds"`
	SourceRevisionIDs []string             `json:"sourceRevisionIds"`
	Links             []knowledgeLinkInput `json:"links"`
	OperationID       string               `json:"operationId"`
}
type knowledgeError struct {
	status        int
	code, message string
}

func (e knowledgeError) Error() string      { return e.message }
func knowledgeInvalid(message string) error { return knowledgeError{400, "invalid_knowledge", message} }
func knowledgeMissing() error {
	return knowledgeError{404, "not_found", "Knowledge resource not found"}
}
func knowledgeConflict() error {
	return knowledgeError{409, "version_conflict", "Knowledge changed; review the latest version before retrying"}
}
func (a *App) knowledgeFailure(w http.ResponseWriter, e error) {
	var input knowledgeError
	if errors.As(e, &input) {
		fail(w, input.status, input.code, input.message)
		return
	}
	if noRows(e) {
		e = knowledgeMissing()
		a.knowledgeFailure(w, e)
		return
	}
	a.dbError(w, e)
}

// Serializing on the tenant row makes operation replay and content deduplication
// atomic with authorization, revision publication, links and audit records.
func (a *App) knowledgeMutation(w http.ResponseWriter, r *http.Request, op, action string, input any, change func(pgx.Tx) (json.RawMessage, int, error)) {
	if len(op) < 8 || len(op) > 200 {
		a.knowledgeFailure(w, knowledgeInvalid("operationId must contain 8–200 bytes"))
		return
	}
	raw, e := json.Marshal(input)
	if e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	hash := tokenHash(action + "\x00" + r.PathValue("id") + "\x00" + string(raw))
	tid := r.PathValue("tenantId")
	tx, e := a.db.Begin(r.Context())
	if e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	if _, ok := a.mutationRole(w, r, tx, tid, 2); !ok {
		return
	}
	var previousHash string
	var previous json.RawMessage
	var previousStatus int
	e = tx.QueryRow(r.Context(), "SELECT request_hash,response,status FROM knowledge_operations WHERE tenant_id=$1 AND operation_id=$2", tid, op).Scan(&previousHash, &previous, &previousStatus)
	if e == nil {
		if previousHash != hash {
			fail(w, 409, "idempotency_conflict", "operationId was used for a different knowledge change")
			return
		}
		writeJSON(w, previousStatus, previous)
		return
	}
	if !noRows(e) {
		a.knowledgeFailure(w, e)
		return
	}
	result, status, e := change(tx)
	if e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	var identity struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(result, &identity)
	if _, e = tx.Exec(r.Context(), "INSERT INTO knowledge_operations(tenant_id,operation_id,request_hash,response,status) VALUES($1,$2,$3,$4,$5)", tid, op, hash, result, status); e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	if _, e = tx.Exec(r.Context(), "INSERT INTO knowledge_events(tenant_id,actor_id,operation_id,action,resource_id) VALUES($1,$2,$3,$4,$5)", tid, currentUser(r).ID, op, action, identity.ID); e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	if e = audit(r.Context(), tx, currentUser(r).ID, tid, action, identity.ID); e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	writeJSON(w, status, result)
}

func knowledgeDocument(ctx context.Context, q querier, tid, id string) (json.RawMessage, error) {
	return oneJSON(ctx, q, "SELECT "+knowledgeDocumentJSON+" FROM knowledge_documents d JOIN knowledge_revisions v ON v.tenant_id=d.tenant_id AND v.id=d.current_revision_id WHERE d.tenant_id=$1 AND d.id=$2", tid, id)
}
func knowledgeProposal(ctx context.Context, q querier, tid, id string) (json.RawMessage, error) {
	return oneJSON(ctx, q, "SELECT "+knowledgeProposalJSON+" FROM knowledge_proposals p WHERE p.tenant_id=$1 AND p.id=$2", tid, id)
}

// Read complete records under a serialized-byte budget, rather than first
// materializing hundreds of full-size documents. Reserve framing separately.
func knowledgeRows(ctx context.Context, q querier, budget, limit int, sql string, args ...any) ([]json.RawMessage, bool, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := []json.RawMessage{}
	for rows.Next() {
		var raw json.RawMessage
		if err = rows.Scan(&raw); err != nil {
			return nil, false, err
		}
		// Match writeJSON's HTML escaping, including adversarial '<' content.
		encoded, err := json.Marshal(raw)
		if err != nil {
			return nil, false, err
		}
		if len(items) == limit || len(encoded)+1 > budget {
			return items, true, nil
		}
		budget -= len(encoded) + 1
		items = append(items, encoded)
	}
	return items, false, rows.Err()
}

func recordKnowledgeOrigin(ctx context.Context, tx pgx.Tx, tid, id, title, uri string, provenance map[string]any, actor string) error {
	raw, err := json.Marshal(provenance)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO knowledge_source_origins(tenant_id,document_id,title,source_uri,provenance,origin_hash,actor_id)
 VALUES($1,$2,$3,$4,$5,md5(jsonb_build_array($3::text,$4::text,$5::jsonb)::text),$6) ON CONFLICT(tenant_id,document_id,origin_hash) DO NOTHING`, tid, id, title, uri, raw, actor)
	return err
}

func (a *App) listKnowledge(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) > 500 {
		a.knowledgeFailure(w, knowledgeInvalid("Search is limited to 500 bytes"))
		return
	}
	tid := r.PathValue("tenantId")
	// A single snapshot prevents a page revision, link set and proposal verdict
	// from describing different commits in the same response.
	tx, e := a.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	docs, docsMore, e := knowledgeRows(r.Context(), tx, maxKnowledgeSnapshotBytes/2-(128<<10), 500, "SELECT "+knowledgeDocumentJSON+" FROM knowledge_documents d JOIN knowledge_revisions v ON v.tenant_id=d.tenant_id AND v.id=d.current_revision_id WHERE d.tenant_id=$1 AND ($2='' OR strpos(lower(d.title||E'\\n'||v.content),lower($2))>0) ORDER BY d.updated_at DESC,d.id LIMIT 501", tid, query)
	if e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	links, linksMore, e := knowledgeRows(r.Context(), tx, 128<<10, 5000, "SELECT "+knowledgeLinkJSON+" FROM knowledge_links WHERE tenant_id=$1 ORDER BY id LIMIT 5001", tid)
	if e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	proposals, proposalsMore, e := knowledgeRows(r.Context(), tx, maxKnowledgeSnapshotBytes/2-(128<<10), 500, "SELECT "+knowledgeProposalJSON+" FROM knowledge_proposals p WHERE p.tenant_id=$1 AND ($2='' OR strpos(lower(p.title||E'\\n'||p.content),lower($2))>0) ORDER BY (p.status='draft') DESC,p.created_at DESC,p.id LIMIT 501", tid, query)
	if e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	events, eventsMore, e := knowledgeRows(r.Context(), tx, 64<<10, 100, "SELECT jsonb_build_object('id',id,'action',action,'resourceId',resource_id,'createdAt',created_at) FROM knowledge_events WHERE tenant_id=$1 ORDER BY id DESC LIMIT 101", tid)
	if e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	sections := []string{}
	for _, section := range []struct {
		name string
		more bool
	}{{"documents", docsMore}, {"links", linksMore}, {"proposals", proposalsMore}, {"events", eventsMore}} {
		if section.more {
			sections = append(sections, section.name)
		}
	}
	if e = tx.Commit(r.Context()); e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"documents": docs, "links": links, "proposals": proposals, "events": events, "truncated": len(sections) > 0, "truncatedSections": sections})
}

func (a *App) getKnowledgeDocument(w http.ResponseWriter, r *http.Request) {
	value, e := knowledgeDocument(r.Context(), a.db, r.PathValue("tenantId"), r.PathValue("id"))
	if e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	writeJSON(w, 200, value)
}
func (a *App) knowledgeRevisions(w http.ResponseWriter, r *http.Request) {
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	if _, e := knowledgeDocument(r.Context(), a.db, tid, id); e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	before, e := knowledgeBefore(r, "beforeVersion")
	if e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	revision := r.URL.Query().Get("revisionId")
	if len(revision) > 200 || (revision != "" && before != 0) {
		a.knowledgeFailure(w, knowledgeInvalid("Choose a revisionId or beforeVersion"))
		return
	}
	items, more, e := knowledgeRows(r.Context(), a.db, maxKnowledgeHistoryBytes-1024, 500, "SELECT "+knowledgeRevisionJSON+" FROM knowledge_revisions v WHERE v.tenant_id=$1 AND v.document_id=$2 AND ($3::bigint=0 OR v.version<$3) AND ($4='' OR v.id=$4) ORDER BY v.version DESC LIMIT 501", tid, id, before, revision)
	if e != nil {
		a.knowledgeFailure(w, e)
		return
	}
	if revision != "" && len(items) == 0 {
		a.knowledgeFailure(w, knowledgeMissing())
		return
	}
	var next any
	if more && len(items) > 0 {
		var last struct {
			Version int64 `json:"version"`
		}
		if e = json.Unmarshal(items[len(items)-1], &last); e != nil {
			a.knowledgeFailure(w, e)
			return
		}
		next = last.Version
	}
	writeJSON(w, 200, map[string]any{"items": items, "truncated": more, "nextBeforeVersion": next})
}

func knowledgeBefore(r *http.Request, key string) (int64, error) {
	value := r.URL.Query().Get(key)
	if value == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 1 {
		return 0, knowledgeInvalid("Invalid history cursor")
	}
	return n, nil
}

func (a *App) knowledgeOrigins(w http.ResponseWriter, r *http.Request) {
	tid, id := r.PathValue("tenantId"), r.PathValue("id")
	var found bool
	if err := a.db.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM knowledge_documents WHERE tenant_id=$1 AND id=$2 AND kind='source')", tid, id).Scan(&found); err != nil {
		a.knowledgeFailure(w, err)
		return
	}
	if !found {
		a.knowledgeFailure(w, knowledgeMissing())
		return
	}
	before, err := knowledgeBefore(r, "beforeId")
	if err != nil {
		a.knowledgeFailure(w, err)
		return
	}
	items, more, err := knowledgeRows(r.Context(), a.db, 512<<10, 64, "SELECT "+knowledgeOriginJSON+" FROM knowledge_source_origins o WHERE tenant_id=$1 AND document_id=$2 AND ($3::bigint=0 OR id<$3) ORDER BY id DESC LIMIT 65", tid, id, before)
	if err != nil {
		a.knowledgeFailure(w, err)
		return
	}
	var next any
	if more && len(items) > 0 {
		var last struct {
			ID string `json:"id"`
		}
		if err = json.Unmarshal(items[len(items)-1], &last); err != nil {
			a.knowledgeFailure(w, err)
			return
		}
		next = last.ID
	}
	writeJSON(w, 200, map[string]any{"items": items, "truncated": more, "nextBeforeId": next})
}

func validKnowledgeText(title, content, uri string) error {
	if !cleanName(title) || !utf8.ValidString(title) || strings.IndexByte(title, 0) >= 0 {
		return knowledgeInvalid("A title of at most 200 bytes is required")
	}
	if strings.TrimSpace(content) == "" || len(content) > maxKnowledgeContent || !utf8.ValidString(content) || strings.IndexByte(content, 0) >= 0 {
		return knowledgeInvalid("Content must be nonempty UTF-8 text or Markdown, at most 256 KiB")
	}
	if len(uri) > 2000 || strings.ContainsAny(uri, "\x00\r\n") || !utf8.ValidString(uri) {
		return knowledgeInvalid("Invalid source URI")
	}
	return nil
}

// Artifact bytes and their provenance are read together under the tenant bound.
// No artifact FK is retained: deleting its old canvas cannot remove a knowledge source.
func knowledgeInputContent(ctx context.Context, q querier, tid, content, artifactID string) (string, map[string]any, error) {
	provenance := map[string]any{"origin": "user"}
	if artifactID == "" {
		return content, provenance, nil
	}
	if content != "" {
		return "", nil, knowledgeInvalid("Provide content or artifactId, not both")
	}
	var raw []byte
	var name, hash, run, node, canvas string
	e := q.QueryRow(ctx, "SELECT name,content,sha256,run_id,node_id,canvas_id FROM artifacts WHERE tenant_id=$1 AND id=$2 AND field_id<>'__workspace_snapshot' AND size<=$3", tid, artifactID, maxKnowledgeContent).Scan(&name, &raw, &hash, &run, &node, &canvas)
	if noRows(e) {
		return "", nil, knowledgeMissing()
	}
	if e != nil {
		return "", nil, e
	}
	if tokenHash(string(raw)) != hash {
		return "", nil, knowledgeInvalid("Artifact content hash does not match its stored bytes")
	}
	provenance = map[string]any{"origin": "artifact", "artifactId": artifactID, "artifactName": name, "artifactHash": hash, "runId": run, "nodeId": node, "canvasId": canvas}
	return string(raw), provenance, nil
}

func (a *App) createKnowledgeSource(w http.ResponseWriter, r *http.Request) {
	var b knowledgeSourceInput
	if !a.decode(w, r, &b) {
		return
	}
	a.knowledgeMutation(w, r, b.OperationID, "knowledge.source.created", b, func(tx pgx.Tx) (json.RawMessage, int, error) {
		tid := r.PathValue("tenantId")
		content, provenance, e := knowledgeInputContent(r.Context(), tx, tid, b.Content, b.ArtifactID)
		if e != nil {
			return nil, 0, e
		}
		if e = validKnowledgeText(b.Title, content, b.SourceURI); e != nil {
			return nil, 0, e
		}
		hash := tokenHash(content)
		var old string
		e = tx.QueryRow(r.Context(), "SELECT id FROM knowledge_documents WHERE tenant_id=$1 AND source_hash=$2", tid, hash).Scan(&old)
		if e == nil {
			if e = recordKnowledgeOrigin(r.Context(), tx, tid, old, b.Title, b.SourceURI, provenance, currentUser(r).ID); e != nil {
				return nil, 0, e
			}
			value, err := knowledgeDocument(r.Context(), tx, tid, old)
			return value, 200, err
		}
		if !noRows(e) {
			return nil, 0, e
		}
		id := randomID()
		if _, e = tx.Exec(r.Context(), "INSERT INTO knowledge_documents(id,tenant_id,kind,title,source_hash) VALUES($1,$2,'source',$3,$4)", id, tid, b.Title, hash); e != nil {
			return nil, 0, e
		}
		if _, e = publishKnowledgeRevision(r.Context(), tx, tid, id, 1, "", b.Title, content, b.SourceURI, provenance, []knowledgeLinkInput{}, currentUser(r).ID); e != nil {
			return nil, 0, e
		}
		if e = recordKnowledgeOrigin(r.Context(), tx, tid, id, b.Title, b.SourceURI, provenance, currentUser(r).ID); e != nil {
			return nil, 0, e
		}
		value, e := knowledgeDocument(r.Context(), tx, tid, id)
		return value, 201, e
	})
}

func normalizeKnowledgeLinks(sourceIDs []string, links []knowledgeLinkInput) ([]string, []knowledgeLinkInput, error) {
	if len(sourceIDs) > 64 || len(links) > 128 {
		return nil, nil, knowledgeInvalid("A proposal supports at most 64 sources and 128 links")
	}
	sources := []string{}
	normalized := []knowledgeLinkInput{}
	seenSources := map[string]bool{}
	seen := map[string]bool{}
	for _, id := range sourceIDs {
		if id == "" || len(id) > 200 {
			return nil, nil, knowledgeInvalid("Invalid source identity")
		}
		if !seenSources[id] {
			sources = append(sources, id)
			seenSources[id] = true
			links = append(links, knowledgeLinkInput{id, "cites"})
		}
	}
	for _, link := range links {
		if link.ToDocumentID == "" || len(link.ToDocumentID) > 200 {
			return nil, nil, knowledgeInvalid("Invalid link target")
		}
		switch link.Relation {
		case "links_to", "cites", "supports", "contradicts", "derived_from":
		default:
			return nil, nil, knowledgeInvalid("Unsupported knowledge relation")
		}
		key := link.ToDocumentID + "\x00" + link.Relation
		if !seen[key] {
			seen[key] = true
			normalized = append(normalized, link)
		}
	}
	return sources, normalized, nil
}

func validateKnowledgeTargets(ctx context.Context, q querier, tid string, links []knowledgeLinkInput) error {
	seen := map[string]bool{}
	for _, link := range links {
		if seen[link.ToDocumentID] {
			continue
		}
		seen[link.ToDocumentID] = true
		var found bool
		e := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM knowledge_documents WHERE tenant_id=$1 AND id=$2)", tid, link.ToDocumentID).Scan(&found)
		if e != nil {
			return e
		}
		if !found {
			return knowledgeMissing()
		}
	}
	return nil
}

func (a *App) createKnowledgeProposal(w http.ResponseWriter, r *http.Request) {
	var b knowledgeProposalInput
	if !a.decode(w, r, &b) {
		return
	}
	a.knowledgeMutation(w, r, b.OperationID, "knowledge.proposal.created", b, func(tx pgx.Tx) (json.RawMessage, int, error) {
		tid := r.PathValue("tenantId")
		if b.Kind != "page" && b.Kind != "decision" {
			return nil, 0, knowledgeInvalid("Proposals must be pages or decisions")
		}
		if (b.DocumentID == "" && b.BaseVersion != 0) || (b.DocumentID != "" && b.BaseVersion < 1) {
			return nil, 0, knowledgeInvalid("New pages use baseVersion 0; edits require the current version")
		}
		content, provenance, e := knowledgeInputContent(r.Context(), tx, tid, b.Content, b.ArtifactID)
		if e != nil {
			return nil, 0, e
		}
		if e = validKnowledgeText(b.Title, content, b.SourceURI); e != nil {
			return nil, 0, e
		}
		if b.DocumentID != "" {
			var kind string
			var version int64
			if e = tx.QueryRow(r.Context(), "SELECT kind,version FROM knowledge_documents WHERE tenant_id=$1 AND id=$2", tid, b.DocumentID).Scan(&kind, &version); e != nil {
				return nil, 0, e
			}
			if kind == "source" || kind != b.Kind {
				return nil, 0, knowledgeInvalid("Original sources and document kinds cannot be changed")
			}
			if version != b.BaseVersion {
				return nil, 0, knowledgeConflict()
			}
		}
		refs, e := knowledgeRevisionReferences(r.Context(), tx, tid, b.SourceRevisionIDs)
		if e != nil {
			return nil, 0, e
		}
		sourceIDs := append([]string{}, b.SourceIDs...)
		fixedDocuments := map[string]bool{}
		for _, ref := range refs {
			sourceIDs = append(sourceIDs, ref.DocumentID)
			fixedDocuments[ref.DocumentID] = true
		}
		sources, links, e := normalizeKnowledgeLinks(sourceIDs, b.Links)
		if e != nil {
			return nil, 0, e
		}
		if e = validateKnowledgeTargets(r.Context(), tx, tid, links); e != nil {
			return nil, 0, e
		}
		// Record exact citation versions when the draft is made, not after approval.
		currentSources := []string{}
		for _, id := range sources {
			if !fixedDocuments[id] {
				currentSources = append(currentSources, id)
			}
		}
		currentRefs, e := freezeKnowledgeDocuments(r.Context(), tx, tid, currentSources)
		if e != nil {
			return nil, 0, e
		}
		refs = append(refs, currentRefs...)
		provenance["sourceRevisions"] = refs
		pr, _ := json.Marshal(provenance)
		src, _ := json.Marshal(sources)
		lk, _ := json.Marshal(links)
		id := randomID()
		_, e = tx.Exec(r.Context(), "INSERT INTO knowledge_proposals(id,tenant_id,document_id,kind,title,content,base_version,source_ids,links,provenance,source_uri,actor_id) VALUES($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8,$9,$10,$11,$12)", id, tid, b.DocumentID, b.Kind, b.Title, content, b.BaseVersion, src, lk, pr, b.SourceURI, currentUser(r).ID)
		if e != nil {
			return nil, 0, e
		}
		value, e := knowledgeProposal(r.Context(), tx, tid, id)
		return value, 201, e
	})
}

// Only this function publishes a version and its current relation projection.
// The immutable revision retains the previous relation set for exact restoration.
func publishKnowledgeRevision(ctx context.Context, tx pgx.Tx, tid, id string, version int64, parent, title, content, uri string, provenance map[string]any, links []knowledgeLinkInput, actor string) (string, error) {
	rid := randomID()
	pr, _ := json.Marshal(provenance)
	lk, _ := json.Marshal(links)
	_, e := tx.Exec(ctx, "INSERT INTO knowledge_revisions(id,tenant_id,document_id,version,parent_revision_id,title,content,content_hash,source_uri,provenance,links,actor_id) VALUES($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8,$9,$10,$11,$12)", rid, tid, id, version, parent, title, content, tokenHash(content), uri, pr, lk, actor)
	if e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "UPDATE knowledge_documents SET title=$3,version=$4,current_revision_id=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2", tid, id, title, version, rid); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "DELETE FROM knowledge_links WHERE tenant_id=$1 AND from_document_id=$2", tid, id); e != nil {
		return "", e
	}
	for _, link := range links {
		if _, e = tx.Exec(ctx, "INSERT INTO knowledge_links(id,tenant_id,from_document_id,to_document_id,revision_id,relation) VALUES($1,$2,$3,$4,$5,$6)", randomID(), tid, id, link.ToDocumentID, rid, link.Relation); e != nil {
			return "", e
		}
	}
	return rid, nil
}

func (a *App) acceptKnowledgeProposal(w http.ResponseWriter, r *http.Request) {
	var b struct {
		OperationID string `json:"operationId"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	a.knowledgeMutation(w, r, b.OperationID, "knowledge.proposal.accepted", b, func(tx pgx.Tx) (json.RawMessage, int, error) {
		tid, pid := r.PathValue("tenantId"), r.PathValue("id")
		var id, kind, title, content, status, uri, accepted string
		var base int64
		var rawLinks, rawProvenance []byte
		e := tx.QueryRow(r.Context(), "SELECT COALESCE(document_id,''),kind,title,content,base_version,status,links,provenance,source_uri,COALESCE(accepted_document_id,'') FROM knowledge_proposals WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, pid).Scan(&id, &kind, &title, &content, &base, &status, &rawLinks, &rawProvenance, &uri, &accepted)
		if e != nil {
			return nil, 0, e
		}
		if status == "accepted" {
			value, err := knowledgeDocument(r.Context(), tx, tid, accepted)
			return value, 200, err
		}
		if status != "draft" {
			return nil, 0, knowledgeError{409, "proposal_resolved", "This proposal has already been rejected"}
		}
		parent := ""
		version := int64(0)
		if id != "" {
			if e = tx.QueryRow(r.Context(), "SELECT version,current_revision_id FROM knowledge_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, id).Scan(&version, &parent); e != nil {
				return nil, 0, e
			}
			if version != base {
				return nil, 0, knowledgeConflict()
			}
		} else {
			id = randomID()
			if _, e = tx.Exec(r.Context(), "INSERT INTO knowledge_documents(id,tenant_id,kind,title) VALUES($1,$2,$3,$4)", id, tid, kind, title); e != nil {
				return nil, 0, e
			}
		}
		links := []knowledgeLinkInput{}
		provenance := map[string]any{}
		if e = json.Unmarshal(rawLinks, &links); e != nil {
			return nil, 0, e
		}
		if e = json.Unmarshal(rawProvenance, &provenance); e != nil {
			return nil, 0, e
		}
		if e = validateKnowledgeTargets(r.Context(), tx, tid, links); e != nil {
			return nil, 0, e
		}
		provenance["proposalId"] = pid
		provenance["acceptedBy"] = currentUser(r).ID
		if _, e = publishKnowledgeRevision(r.Context(), tx, tid, id, version+1, parent, title, content, uri, provenance, links, currentUser(r).ID); e != nil {
			return nil, 0, e
		}
		if _, e = tx.Exec(r.Context(), "UPDATE knowledge_proposals SET status='accepted',accepted_document_id=$3,resolved_at=now() WHERE tenant_id=$1 AND id=$2", tid, pid, id); e != nil {
			return nil, 0, e
		}
		value, e := knowledgeDocument(r.Context(), tx, tid, id)
		return value, 200, e
	})
}

func (a *App) rejectKnowledgeProposal(w http.ResponseWriter, r *http.Request) {
	var b struct {
		OperationID string `json:"operationId"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	a.knowledgeMutation(w, r, b.OperationID, "knowledge.proposal.rejected", b, func(tx pgx.Tx) (json.RawMessage, int, error) {
		tid, pid := r.PathValue("tenantId"), r.PathValue("id")
		var status string
		if e := tx.QueryRow(r.Context(), "SELECT status FROM knowledge_proposals WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, pid).Scan(&status); e != nil {
			return nil, 0, e
		}
		if status == "accepted" {
			return nil, 0, knowledgeError{409, "proposal_resolved", "This proposal has already been accepted"}
		}
		if status == "draft" {
			if _, e := tx.Exec(r.Context(), "UPDATE knowledge_proposals SET status='rejected',resolved_at=now() WHERE tenant_id=$1 AND id=$2", tid, pid); e != nil {
				return nil, 0, e
			}
		}
		value, e := knowledgeProposal(r.Context(), tx, tid, pid)
		return value, 200, e
	})
}

func (a *App) restoreKnowledgeRevision(w http.ResponseWriter, r *http.Request) {
	var b struct {
		RevisionID      string `json:"revisionId"`
		ExpectedVersion int64  `json:"expectedVersion"`
		OperationID     string `json:"operationId"`
	}
	if !a.decode(w, r, &b) {
		return
	}
	a.knowledgeMutation(w, r, b.OperationID, "knowledge.revision.restored", b, func(tx pgx.Tx) (json.RawMessage, int, error) {
		tid, id := r.PathValue("tenantId"), r.PathValue("id")
		var kind, parent string
		var version int64
		e := tx.QueryRow(r.Context(), "SELECT kind,version,current_revision_id FROM knowledge_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE", tid, id).Scan(&kind, &version, &parent)
		if e != nil {
			return nil, 0, e
		}
		if kind == "source" {
			return nil, 0, knowledgeInvalid("Original sources are immutable; import a new source instead")
		}
		if version != b.ExpectedVersion {
			return nil, 0, knowledgeConflict()
		}
		var title, content, uri string
		var rawLinks, rawProvenance []byte
		e = tx.QueryRow(r.Context(), "SELECT title,content,source_uri,links,provenance FROM knowledge_revisions WHERE tenant_id=$1 AND document_id=$2 AND id=$3", tid, id, b.RevisionID).Scan(&title, &content, &uri, &rawLinks, &rawProvenance)
		if e != nil {
			return nil, 0, e
		}
		links := []knowledgeLinkInput{}
		provenance := map[string]any{}
		if e = json.Unmarshal(rawLinks, &links); e != nil {
			return nil, 0, e
		}
		if e = json.Unmarshal(rawProvenance, &provenance); e != nil {
			return nil, 0, e
		}
		provenance["restoredFromRevisionId"] = b.RevisionID
		if _, e = publishKnowledgeRevision(r.Context(), tx, tid, id, version+1, parent, title, content, uri, provenance, links, currentUser(r).ID); e != nil {
			return nil, 0, e
		}
		value, e := knowledgeDocument(r.Context(), tx, tid, id)
		return value, 200, e
	})
}
