package app

// The canvas list's summary view (GET /tenants/{id}/canvases?view=summary): each canvas with its outline instead of its
// whole document. The outline is exactly what a list card's thumbnail draws (canvasShape, CanvasThumbnail.tsx): the boxes
// of the first 60 nodes that have a string id, the edges between two of them, and the count of all such nodes. A
// document carries every node's configuration and published output, so a workspace of large canvases made the home
// download megabytes to draw thumbnails (8.7 MB for the 50 newest, 2026-10-17). Opening a canvas still reads it whole.
//
// The document is unpacked once per canvas: `document||'{}'` reads it from TOAST into one value the rest reads, and
// each array is walked once (the node count and the first 60 boxes in the same pass).
const canvasOutlineSQL = `(SELECT jsonb_build_object('nodes',COALESCE(nd.boxes,'[]'::jsonb),'nodeCount',nd.count,'edges',COALESCE(ed.links,'[]'::jsonb))` +
	` FROM (SELECT document||'{}'::jsonb AS doc OFFSET 0) d` +
	` CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(d.doc->'nodes')='array' THEN d.doc->'nodes' ELSE '[]'::jsonb END AS nodes,` +
	` CASE WHEN jsonb_typeof(d.doc->'edges')='array' THEN d.doc->'edges' ELSE '[]'::jsonb END AS edges OFFSET 0) a` +
	` CROSS JOIN LATERAL (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',v.value->'id','x',v.value->'x','y',v.value->'y','w',v.value->'w','h',v.value->'h')) ORDER BY v.rank) FILTER (WHERE v.rank<=60) AS boxes,` +
	` array_agg(v.value->>'id') FILTER (WHERE v.rank<=60) AS ids, count(*) AS count` +
	` FROM (SELECT n.value, row_number() OVER (ORDER BY n.ordinality) AS rank FROM jsonb_array_elements(a.nodes) WITH ORDINALITY n` +
	` WHERE jsonb_typeof(n.value->'id')='string') v) nd` +
	` CROSS JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('fromNode',e.value->'fromNode','toNode',e.value->'toNode') ORDER BY e.ordinality) AS links` +
	` FROM jsonb_array_elements(a.edges) WITH ORDINALITY e WHERE jsonb_typeof(e.value->'fromNode')='string' AND jsonb_typeof(e.value->'toNode')='string'` +
	` AND e.value->>'fromNode'=ANY(nd.ids) AND e.value->>'toNode'=ANY(nd.ids)) ed)`

const canvasSummaryJSON = `jsonb_build_object('id',id,'tenantId',tenant_id,'name',name,'outline',` + canvasOutlineSQL +
	`,'version',version,'createdAt',created_at,'updatedAt',updated_at)`
