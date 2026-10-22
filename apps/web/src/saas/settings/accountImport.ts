// The local edition's 导入: a file the hosted site's 导出我的数据 saved (preferences.go exportAccount) becomes new
// workspaces here, through the API's own routes: one workspace per active workspace the file lists, named the same,
// then each of its canvases, one at a time, detached from the workspace it was made in. Nothing that is already on
// this computer is changed.
import { splitAttachments } from '../../canvas/attachments';
import { parseMediaOutput } from '../../canvas/mediaOutput';
import { api, SaaSApiError } from '../api';

export type ExportedCanvas = { name: string; document: Record<string, unknown> };
export type ExportedWorkspace = { name: string; canvases: ExportedCanvas[] };
export type AccountExport = { exportedAt: string; workspaces: ExportedWorkspace[]; canvasCount: number };
/** Why a file cannot be imported: not an export, cut short, written by a newer AwwO, or with no active workspace. */
export type ExportProblem = 'not_export' | 'incomplete' | 'newer' | 'empty';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The API takes a name of 1–200 bytes (cleanName); a longer one, such as a ClawHunt account's first workspace's
 *  ("<name> · AwwO"), is cut on a character boundary. */
const MAX_NAME_BYTES = 200;
export function fitName(name: string): string {
  const encoder = new TextEncoder();
  let fitted = '';
  for (const character of name) {
    if (encoder.encode(fitted + character).length > MAX_NAME_BYTES) break;
    fitted += character;
  }
  return fitted;
}

/** The active workspaces an export lists, in its order, each with the canvases the file holds for it. */
export function readAccountExport(text: string): AccountExport | ExportProblem {
  let file: unknown;
  try { file = JSON.parse(text); } catch { return 'not_export'; }
  if (!object(file) || file.kind !== 'awwo.account-export' || !Array.isArray(file.workspaces) || !Array.isArray(file.canvases)) return 'not_export';
  if (typeof file.schemaVersion !== 'number' || file.schemaVersion > 1) return 'newer';
  // An export the server had to cut short ends with "complete":false: some canvases are missing from it.
  if (file.complete !== true) return 'incomplete';
  const workspaces = new Map<string, ExportedWorkspace>();
  for (const item of file.workspaces) {
    if (object(item) && typeof item.id === 'string' && typeof item.name === 'string' && item.status === 'active' && !workspaces.has(item.id))
      workspaces.set(item.id, { name: item.name, canvases: [] });
  }
  let canvasCount = 0;
  for (const item of file.canvases) {
    const workspace = object(item) && typeof item.tenantId === 'string' ? workspaces.get(item.tenantId) : undefined;
    if (!workspace || !object(item) || typeof item.name !== 'string' || !object(item.document)) continue;
    workspace.canvases.push({ name: item.name, document: item.document });
    canvasCount++;
  }
  if (!workspaces.size) return 'empty';
  return { exportedAt: typeof file.exportedAt === 'string' ? file.exportedAt : '', workspaces: [...workspaces.values()], canvasCount };
}

const FILE_REFERENCE = 'awwo-file:';
/** A delivery that names files or media stored in the workspace it was made in, which the new one does not have. */
const namesWorkspaceFiles = (text: unknown) => typeof text === 'string' && (text.includes(FILE_REFERENCE) || parseMediaOutput(text) !== null);

function detachedOutput(output: unknown): unknown {
  if (!object(output) || namesWorkspaceFiles(output.text)) return null;
  // Versions of the canvas it was made on, which mean nothing to the new one.
  const { supersedesThroughGraphVersion: _version, supersedesGraphCanvasId: _canvas, ...kept } = output;
  return kept;
}

/** What a person wrote in a text, without the old workspace's files: its attachment lines and the server's data block
 *  after them (attachments.ts) go, and so does any other line that names one; the words stay. */
const ownWords = (text: string) => splitAttachments(text).body.split('\n').filter(line => !line.includes(FILE_REFERENCE)).join('\n');

function detachedContract(contract: unknown): unknown {
  if (!object(contract)) return contract;
  // An input keeps what was written in it; an output is the old run's delivery, made again by the next run.
  const fields = (list: unknown, keep: boolean) => Array.isArray(list)
    ? list.map(field => object(field) && typeof field.value === 'string' && field.value.includes(FILE_REFERENCE)
      ? { ...field, value: keep ? ownWords(field.value) : '' } : field) : list;
  return { ...contract, inputs: fields(contract.inputs, true), outputs: fields(contract.outputs, false) };
}

/** The conversation the node had open, as a new one: its unsent draft (a media node's prompt) without its files; none
 *  when there is nothing written in it. Without an open one named, it is the default conversation, as the client
 *  (nodeThreads.ts) and the server (graph_media.go) read it. */
function draftThread(node: Record<string, unknown>): unknown[] {
  const threads = Array.isArray(node.threads) ? node.threads.filter(object) : [];
  const open = threads.find(thread => thread.id === node.activeThreadId) ?? threads.find(thread => thread.id === 'default');
  const draft = open && typeof open.draft === 'string' ? ownWords(open.draft) : '';
  if (!open || !draft.trim() || typeof open.id !== 'string' || !open.id) return [];
  return [{ id: open.id, title: typeof open.title === 'string' ? open.title : '', issueId: null, preview: '', draft,
    createdAt: typeof open.createdAt === 'number' ? open.createdAt : Date.now() }];
}

function detachedNode(raw: unknown): unknown {
  if (!object(raw)) return raw;
  const node: Record<string, unknown> = { ...raw };
  if ('lastOutput' in node) node.lastOutput = node.kind === 'edit' ? null : detachedOutput(node.lastOutput);
  if ('contract' in node) node.contract = detachedContract(node.contract);
  if (node.kind !== 'session') return node;
  // Its agent and its conversations are the old workspace's (node_setup.go refuses a reference it does not own; the
  // transcripts are not in the export): the node is set up afresh on its first run, as a new one is. Only the open
  // conversation's unsent draft comes along.
  const threads = draftThread(node);
  delete node.agentRef;
  delete node.activeThreadId;
  Object.assign(node, { binding: null, bindAttempt: null, issueId: null, threads, preview: '' });
  if (threads.length) node.activeThreadId = (threads[0] as { id: string }).id;
  if (Array.isArray(node.skills)) node.skills = node.skills.filter(skill => typeof skill === 'string' && skill.startsWith('builtin:'));
  return node;
}

/**
 * A canvas as it can live in a new workspace: what tied each node to the old one goes (its agent, its conversation and
 * threads, a workspace skill, and every delivery or value that names the old workspace's files or media), so its nodes
 * are set up there on their first run. A plain text delivery stays: a node not run again still hands its text on.
 */
export function detachDocument(document: Record<string, unknown>): Record<string, unknown> {
  return Array.isArray(document.nodes) ? { ...document, nodes: document.nodes.map(detachedNode) } : { ...document };
}

export type ImportFailure = { workspace: string; canvas?: string; error: unknown };
export type ImportProgress = { done: number; total: number; workspaces: number; imported: number; failed: ImportFailure[] };

const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal?.reason); };
  signal?.addEventListener('abort', stop, { once: true });
});

/** Saves one canvas; while the API's canvas saves are all busy (canvas_save_busy) it waits and tries again, a few times. */
async function createCanvas(tenantId: string, canvas: ExportedCanvas, signal?: AbortSignal, retryMs = 2000) {
  const body = JSON.stringify({ name: fitName(canvas.name), document: detachDocument(canvas.document) });
  for (let attempt = 1; ; attempt++) {
    try { return await api(`/tenants/${encodeURIComponent(tenantId)}/canvases`, { method: 'POST', body, signal }); }
    catch (error) {
      if (!(error instanceof SaaSApiError) || error.code !== 'canvas_save_busy' || attempt >= 5) throw error;
      await pause(retryMs, signal);
    }
  }
}

/** A failure every later request would meet too: the session has ended, or the API is not answering at all. */
const ends = (error: unknown) => !(error instanceof SaaSApiError) || error.status === 401;

/**
 * Imports every workspace of the export, reporting after each step. A workspace or canvas the API refuses is listed with
 * the refusal and the rest go on; a stop (the signal), an ended session or an API that no longer answers ends it early,
 * by throwing.
 */
export async function importAccountExport(plan: AccountExport, onProgress: (progress: ImportProgress) => void,
  { signal, retryMs }: { signal?: AbortSignal; retryMs?: number } = {}): Promise<ImportProgress> {
  const progress: ImportProgress = { done: 0, total: plan.canvasCount, workspaces: 0, imported: 0, failed: [] };
  const report = () => onProgress({ ...progress, failed: [...progress.failed] });
  for (const workspace of plan.workspaces) {
    let tenantId: string;
    try {
      const created = await api<{ id?: unknown }>('/tenants', { method: 'POST', body: JSON.stringify({ name: fitName(workspace.name) }), signal });
      if (typeof created?.id !== 'string') throw new SaaSApiError(502, 'request_failed', 'The workspace was created without an id');
      tenantId = created.id;
    } catch (error) {
      if (signal?.aborted || ends(error)) throw error;
      progress.failed.push({ workspace: workspace.name, error });
      progress.done += workspace.canvases.length;
      report();
      continue;
    }
    progress.workspaces++;
    report();
    for (const canvas of workspace.canvases) {
      try { await createCanvas(tenantId, canvas, signal, retryMs); progress.imported++; }
      catch (error) {
        if (signal?.aborted || ends(error)) throw error;
        progress.failed.push({ workspace: workspace.name, canvas: canvas.name, error });
      }
      progress.done++;
      report();
    }
  }
  return progress;
}
