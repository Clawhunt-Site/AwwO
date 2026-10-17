// What a canvas made, as files: the model behind the deliverable studio (成果工作台) and the live card previews.
//
// Read from published outputs only (the same rules as canvasResultModel): each node's contract fields become
// files (a page, a document, a stored file, a scalar summary), an image/video/3D node's generated media become
// their own files, and a field that named a file no server holds is listed as missing, never as a delivery.
// Stored bytes are not fetched here; the studio loads them when a file is opened (studioData.ts).
import type { CanvasDocument, CanvasNode, SessionNode } from '../canvasDoc';
import { canvasResult, type DeliveryState } from '../canvasResultModel';
import { deliveryPresentation } from '../fileDeliveryPresentation';
import { htmlDocumentSource } from '../htmlDeliverable';
import { mediaKindOf } from '../mediaCatalog';
import { parseMediaOutput } from '../mediaOutput';
import { emptyContract } from '../nodeContracts';

export type StudioKind = 'page' | 'markdown' | 'text' | 'code' | 'data' | 'table' | 'image' | 'video' | 'audio' | 'model' | 'pdf'
  | 'archive' | 'file' | 'missing';

export type StudioSource =
  /** A value published in the node's output (an HTML page, Markdown, text, a JSON summary). */
  | { type: 'inline'; text: string }
  /** A file the server stores (`awwo-file:<id>`), downloaded when opened. */
  | { type: 'stored'; reference: string }
  /** A generated image, video or 3D model (an artifact id from an `awwo.media` record). */
  | { type: 'media'; artifactId: string; contentType: string; size: number }
  /** A file inside an archive the studio has opened. */
  | { type: 'member'; parentId: string; path: string; bytes: Uint8Array }
  /** A file field that came back as a name with no file behind it. */
  | { type: 'missing'; claimed: string };

export interface StudioEntry {
  id: string;
  nodeId: string;
  nodeTitle: string;
  /** Folders inside the node's group (an archive's directories). */
  folder: string[];
  /** File name, with an extension where one is known. */
  name: string;
  /** The deliverable's own label (the contract field), for the tree's tooltip and the status bar. */
  label: string;
  kind: StudioKind;
  source: StudioSource;
  state: DeliveryState;
  size?: number;
  /** The node's main deliverable: the first one shown for it. */
  primary?: boolean;
  /** An acceptance step's report. */
  review?: boolean;
}

export interface StudioGroup {
  nodeId: string;
  title: string;
  state: DeliveryState;
  /** The canvas's own result (canvasResult.final). */
  final: boolean;
  review: boolean;
  entries: StudioEntry[];
}

const EXTENSION_KIND: ReadonlyArray<readonly [RegExp, StudioKind]> = [
  [/\.html?$/i, 'page'],
  [/\.(?:md|markdown|mdx)$/i, 'markdown'],
  [/\.(?:txt|text|log|rtf)$/i, 'text'],
  [/\.(?:json|jsonc|geojson)$/i, 'data'],
  [/\.(?:csv|tsv)$/i, 'table'],
  [/\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i, 'image'],
  [/\.(?:mp4|webm|mov|m4v|ogv)$/i, 'video'],
  [/\.(?:mp3|wav|ogg|oga|m4a|aac|flac)$/i, 'audio'],
  [/\.(?:glb|gltf|obj)$/i, 'model'],
  [/\.pdf$/i, 'pdf'],
  [/\.zip$/i, 'archive'],
  [/\.(?:[cm]?[jt]sx?|css|scss|sass|less|py|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|rb|lua|sh|bash|zsh|ps1|bat|sql|ya?ml|toml|ini|cfg|conf|env|xml|vue|svelte|astro|graphql|gql|proto|r|dart|scala|ex|exs|erl|hs|ml|tf|dockerfile|makefile|gitignore|editorconfig|lock)$/i, 'code'],
];
const BARE_CODE = /(?:^|\/)(?:Dockerfile|Makefile|Procfile|LICENSE|README|CHANGELOG|\.gitignore|\.env\.example)$/i;

/** The viewer a file name calls for. */
export function kindOfName(name: string): StudioKind {
  const path = name.split(/[?#]/)[0];
  for (const [pattern, kind] of EXTENSION_KIND) if (pattern.test(path)) return kind;
  return BARE_CODE.test(path) ? 'code' : 'file';
}

/** The viewer a MIME type calls for, where a file has no telling name. */
export function kindOfType(contentType: string): StudioKind | null {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'text/html') return 'page';
  if (type === 'text/markdown') return 'markdown';
  if (type === 'text/csv' || type === 'text/tab-separated-values') return 'table';
  if (type === 'application/json') return 'data';
  if (type.startsWith('text/')) return 'text';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('model/')) return 'model';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'application/zip' || type === 'application/x-zip-compressed') return 'archive';
  return null;
}

/** Text the studio can show as code or prose and search through. */
export function isTextKind(kind: StudioKind): boolean {
  return kind === 'page' || kind === 'markdown' || kind === 'text' || kind === 'code' || kind === 'data' || kind === 'table';
}

const EXTENSION_OF_TYPE: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm',
  'video/quicktime': 'mov', 'model/gltf-binary': 'glb', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
};

/** A file-name-safe version of a label: keeps CJK and letters, drops path and control characters. */
export function fileStem(label: string, fallback = 'deliverable'): string {
  const stem = label.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^[.-]+|[. -]+$/g, '');
  return (stem || fallback).slice(0, 80);
}

/** Markdown-looking text (headings, lists, tables, fences, emphasis) reads better rendered. */
export function looksLikeMarkdown(text: string): boolean {
  return /^(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.+\|)/m.test(text) || /\*\*[^*\n]+\*\*/.test(text);
}

/** The whole canvas's deliverables, one group per node with something published, in step order. */
export function studioGroups(doc: Pick<CanvasDocument, 'nodes' | 'edges'> & Partial<Pick<CanvasDocument, 'execution'>>, onlyNodeId?: string): StudioGroup[] {
  const result = canvasResult(doc);
  const groups: StudioGroup[] = [];
  for (const step of result.stages.flat()) {
    if (onlyNodeId && step.node.id !== onlyNodeId) continue;
    if (step.input || !step.output || step.node.kind === 'form') continue;
    const entries = nodeEntries(step.node, step.state, step.review);
    if (!entries.length) continue;
    groups.push({ nodeId: step.node.id, title: step.node.title.trim() || step.node.id, state: step.state,
      final: result.final?.node.id === step.node.id, review: step.review, entries });
  }
  // The canvas's result first: it is what someone opening the studio came to see.
  return groups.sort((a, b) => Number(b.final) - Number(a.final));
}

/** One node's deliverables (its published output), primary first. */
export function nodeEntries(node: SessionNode | CanvasNode, state: DeliveryState, review = false): StudioEntry[] {
  // An assemble node's page and file are deliverables like an agent's.
  if (node.kind === 'form' || !node.lastOutput?.text.trim()) return [];
  const nodeTitle = node.title.trim() || node.id;
  const contract = node.contract || emptyContract();
  const base = { nodeId: node.id, nodeTitle, folder: [] as string[], state, ...(review ? { review: true } : {}) };
  const text = node.lastOutput.text;
  const entries: StudioEntry[] = [];
  const used = new Set<string>();
  const unique = (name: string) => {
    let candidate = name; let index = 2;
    const dot = name.lastIndexOf('.');
    while (used.has(candidate.toLowerCase())) candidate = dot > 0 ? `${name.slice(0, dot)} (${index++})${name.slice(dot)}` : `${name} (${index++})`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
  if (!contract.outputs.length && node.kind === 'session' && mediaKindOf(node.agentKind)) {
    const media = parseMediaOutput(text);
    for (const item of media?.items ?? []) {
      const extension = EXTENSION_OF_TYPE[item.contentType] ?? '';
      const name = unique(/\.[a-z0-9]{2,5}$/i.test(item.name) || !extension ? item.name : `${item.name}.${extension}`);
      entries.push({ ...base, id: `${node.id}:media:${item.artifactId}`, name, label: item.name, size: item.size,
        kind: kindOfType(item.contentType) ?? kindOfName(name), source: { type: 'media', artifactId: item.artifactId, contentType: item.contentType, size: item.size } });
    }
    if (entries.length) {
      // A 3D node stores its model and a preview picture: the model is what it made.
      const model = entries.find(entry => entry.kind === 'model');
      (model ?? entries[0]).primary = true;
      return model ? [model, ...entries.filter(entry => entry !== model)] : entries;
    }
  }
  const parsed = contract.outputs.length ? deliveryPresentation(contract, text) : null;
  const published = parsed && !parsed.errors.length ? contract.outputs.filter(field => parsed.pendingFiles.has(field.id)
    || (parsed.values[field.id] !== undefined && String(parsed.values[field.id]).trim() !== '')) : [];
  if (!published.length) {
    // Free text (or a result the contract could not read) is still what the node said it delivered.
    const source = parsed?.displaySource ?? text;
    const markdown = looksLikeMarkdown(source);
    entries.push({ ...base, id: `${node.id}:output`, name: unique(`${fileStem(nodeTitle)}.${markdown ? 'md' : 'txt'}`), label: nodeTitle,
      kind: markdown ? 'markdown' : 'text', source: { type: 'inline', text: source }, primary: true });
    return entries;
  }
  const scalars: Record<string, unknown> = {};
  for (const field of published) {
    const label = field.label.trim() || field.id;
    const id = `${node.id}:field:${field.id}`;
    if (parsed!.pendingFiles.has(field.id)) {
      const pending = parsed!.pendingFiles.get(field.id)!;
      entries.push({ ...base, id, name: unique(pending.name), label, kind: 'missing', source: { type: 'missing', claimed: pending.name } });
      continue;
    }
    const value = parsed!.values[field.id];
    const textValue = String(value);
    if (field.type === 'html') {
      entries.push({ ...base, id, name: unique(`${fileStem(label, 'index')}.html`), label, kind: 'page', source: { type: 'inline', text: htmlDocumentSource(textValue) } });
    } else if (field.type === 'markdown') {
      entries.push({ ...base, id, name: unique(`${fileStem(label)}.md`), label, kind: 'markdown', source: { type: 'inline', text: textValue } });
    } else if (field.type === 'text') {
      const markdown = looksLikeMarkdown(textValue);
      entries.push({ ...base, id, name: unique(`${fileStem(label)}.${markdown ? 'md' : 'txt'}`), label, kind: markdown ? 'markdown' : 'text', source: { type: 'inline', text: textValue } });
    } else if (field.type === 'file') {
      const reference = textValue.trim();
      if (reference.startsWith('awwo-file:')) entries.push({ ...base, id, name: unique(fileStem(label, 'file')), label, kind: 'file', source: { type: 'stored', reference } });
      else if (node.lastOutput.source === 'manual') entries.push({ ...base, id, name: unique(`${fileStem(label)}.txt`), label, kind: 'text', source: { type: 'inline', text: reference } });
      else entries.push({ ...base, id, name: unique(fileStem(label, 'file')), label, kind: 'missing', source: { type: 'missing', claimed: reference.slice(0, 200) } });
    } else {
      scalars[label] = value;
    }
  }
  if (Object.keys(scalars).length) {
    entries.push({ ...base, id: `${node.id}:scalars`, name: unique(`${fileStem(nodeTitle)}.json`), label: nodeTitle, kind: 'data',
      source: { type: 'inline', text: JSON.stringify(scalars, null, 2) } });
  }
  // A page is what a person opens first, then a stored file, then prose.
  const rank = (entry: StudioEntry) => entry.kind === 'page' ? 0 : entry.source.type === 'stored' ? 1 : entry.kind === 'markdown' ? 2 : entry.kind === 'missing' ? 9 : 3;
  const primary = [...entries].sort((a, b) => rank(a) - rank(b))[0];
  if (primary) primary.primary = true;
  return entries;
}

/** The file a node's card previews: its primary deliverable. */
export function primaryEntry(node: CanvasNode, state: DeliveryState = 'run'): StudioEntry | null {
  const entries = nodeEntries(node, state);
  return entries.find(entry => entry.primary) ?? entries[0] ?? null;
}

/** "12.4 KB" for a size, nothing for an unknown one. */
export function formatBytes(size: number | undefined): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
