-- Knowledge has a tenant-owned lifecycle independent of canvases and run artifacts.
ALTER TABLE node_sessions DROP CONSTRAINT node_sessions_kind_check;
ALTER TABLE node_sessions ADD CONSTRAINT node_sessions_kind_check CHECK(kind IN ('node','planner','knowledge'));
CREATE UNIQUE INDEX node_sessions_one_knowledge ON node_sessions(tenant_id,canvas_id) WHERE kind='knowledge';
CREATE TABLE knowledge_documents (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id),
 kind text NOT NULL CHECK(kind IN ('source','page','decision')), title text NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), current_revision_id text,
 source_hash text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,source_hash), CHECK((kind='source')=(source_hash IS NOT NULL))
);
CREATE TABLE knowledge_revisions (
 id text PRIMARY KEY, tenant_id text NOT NULL, document_id text NOT NULL,
 version bigint NOT NULL CHECK(version>0), parent_revision_id text, title text NOT NULL,
 content text NOT NULL, content_hash text NOT NULL, source_uri text NOT NULL DEFAULT '',
 provenance jsonb NOT NULL DEFAULT '{}', links jsonb NOT NULL DEFAULT '[]', actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,document_id) REFERENCES knowledge_documents(tenant_id,id),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,document_id,id), UNIQUE(tenant_id,document_id,version)
);
ALTER TABLE knowledge_documents ADD CONSTRAINT knowledge_current_revision
 FOREIGN KEY(tenant_id,id,current_revision_id) REFERENCES knowledge_revisions(tenant_id,document_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE knowledge_revisions ADD CONSTRAINT knowledge_parent_revision
 FOREIGN KEY(tenant_id,document_id,parent_revision_id) REFERENCES knowledge_revisions(tenant_id,document_id,id);
CREATE FUNCTION knowledge_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Knowledge revisions are immutable'; END $$;
CREATE TRIGGER knowledge_revision_immutable BEFORE UPDATE ON knowledge_revisions
 FOR EACH ROW EXECUTE FUNCTION knowledge_revision_immutable();
CREATE TABLE knowledge_links (
 id text PRIMARY KEY, tenant_id text NOT NULL, from_document_id text NOT NULL, to_document_id text NOT NULL,
 revision_id text NOT NULL, relation text NOT NULL CHECK(relation IN ('links_to','cites','supports','contradicts','derived_from')),
 FOREIGN KEY(tenant_id,from_document_id,revision_id) REFERENCES knowledge_revisions(tenant_id,document_id,id),
 FOREIGN KEY(tenant_id,to_document_id) REFERENCES knowledge_documents(tenant_id,id),
 UNIQUE(tenant_id,from_document_id,to_document_id,relation)
);
CREATE INDEX knowledge_backlinks ON knowledge_links(tenant_id,to_document_id);
CREATE TABLE knowledge_proposals (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), document_id text,
 kind text NOT NULL CHECK(kind IN ('page','decision')), title text NOT NULL, content text NOT NULL,
 base_version bigint NOT NULL CHECK(base_version>=0), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','accepted','rejected')),
 source_ids jsonb NOT NULL DEFAULT '[]', links jsonb NOT NULL DEFAULT '[]', provenance jsonb NOT NULL DEFAULT '{}',
 source_uri text NOT NULL DEFAULT '', actor_id text NOT NULL, accepted_document_id text,
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 FOREIGN KEY(tenant_id,document_id) REFERENCES knowledge_documents(tenant_id,id),
 FOREIGN KEY(tenant_id,accepted_document_id) REFERENCES knowledge_documents(tenant_id,id),
 CHECK((document_id IS NULL AND base_version=0) OR (document_id IS NOT NULL AND base_version>0)),
 UNIQUE(tenant_id,id)
);
CREATE INDEX knowledge_proposal_status ON knowledge_proposals(tenant_id,status,created_at DESC);
CREATE TABLE knowledge_operations (
 tenant_id text NOT NULL REFERENCES tenants(id), operation_id text NOT NULL, request_hash text NOT NULL,
 response jsonb NOT NULL, status integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,operation_id)
);
CREATE TABLE knowledge_events (
 id bigserial PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), actor_id text NOT NULL,
 operation_id text NOT NULL, action text NOT NULL, resource_id text NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_events_tenant ON knowledge_events(tenant_id,id DESC);
