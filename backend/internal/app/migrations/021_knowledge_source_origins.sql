-- Identical bytes share one immutable original; each distinct origin remains
-- independently attributable without rewriting that original revision.
CREATE TABLE knowledge_source_origins (
 id bigserial PRIMARY KEY, tenant_id text NOT NULL, document_id text NOT NULL,
 title text NOT NULL, source_uri text NOT NULL DEFAULT '', provenance jsonb NOT NULL,
 origin_hash text NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,document_id) REFERENCES knowledge_documents(tenant_id,id),
 UNIQUE(tenant_id,document_id,origin_hash)
);
CREATE INDEX knowledge_source_origins_document ON knowledge_source_origins(tenant_id,document_id,id DESC);
INSERT INTO knowledge_source_origins(tenant_id,document_id,title,source_uri,provenance,origin_hash,actor_id,created_at)
 SELECT v.tenant_id,v.document_id,v.title,v.source_uri,v.provenance,
 md5(jsonb_build_array(v.title,v.source_uri,v.provenance)::text),v.actor_id,v.created_at
 FROM knowledge_revisions v JOIN knowledge_documents d ON d.tenant_id=v.tenant_id AND d.id=v.document_id
 WHERE d.kind='source' AND v.version=1;
CREATE FUNCTION knowledge_source_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Knowledge source origins are immutable'; END $$;
CREATE TRIGGER knowledge_source_origin_immutable BEFORE UPDATE OR DELETE ON knowledge_source_origins
 FOR EACH ROW EXECUTE FUNCTION knowledge_source_origin_immutable();
