import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { WorkspaceSandbox, WorkspaceRead } from '../openai-agents-worker/workspace-sandbox.ts';
import { LIMITS, WorkerError, hash, json, readJSON, record, responseJSON, safeEqual, textField, type RunRequest, type WorkerEvent } from './protocol.ts';
import { diagnostic, proxyErrorCode } from './diagnostics.ts';
import { ToolFailure, failedResult, recoverableFailure } from './tool-failures.ts';

const prop = (description: string) => ({ type: 'string', description });
export const TOOLS = [
  { name: 'list', description: 'List files in the isolated AwwO workspace. No host files are available.', inputSchema: { type: 'object', properties: { path: prop('Relative directory; empty for root') }, additionalProperties: false } },
  { name: 'read', description: 'Read a real file in the isolated workspace. A result holds at most 50 KiB: a longer file comes back cut and says truncated: true, and exec can read the rest (for example sed -n or tail -c).', inputSchema: { type: 'object', properties: { path: prop('Relative file path') }, required: ['path'], additionalProperties: false } },
  { name: 'write', description: 'Write UTF-8 source in the isolated workspace. Never writes host files.', inputSchema: { type: 'object', properties: { path: prop('Relative file path'), content: prop('Complete UTF-8 content') }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'exec', description: 'Execute a shell command inside the real Docker workspace, without host credentials (your instructions say whether it reaches the web). Inspect exitCode and output. This is not a desktop or browser.', inputSchema: { type: 'object', properties: { command: prop('Shell command within /workspace') }, required: ['command'], additionalProperties: false } },
  { name: 'publish', description: 'Publish exact verified bytes of an existing file as an AwwO artifact.', inputSchema: { type: 'object', properties: { path: prop('Relative existing file path') }, required: ['path'], additionalProperties: false } },
  { name: 'archive', description: 'Publish the actual workspace source as workspace.zip.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
] as const;
/** One tool call of a model answer as the model made it: its call id, its function name and, when the broker could take
 *  them (a JSON object within LIMITS.toolArguments), its arguments. Every call of an answer is kept, in the answer's order,
 *  readable or not, because a card is paired with the call it is for by the core's own record of the calls it has taken
 *  (runtime.ts cardCall), never by a tool's name: the core refuses some calls before any card. `card` is the request id of
 *  the card paired with it. */
export type CapturedCall = { id: string; tool: string; arguments?: Record<string, unknown>; card?: string };
/** The name the pinned core gives a tool of an MCP server it mounts: `${server}_${tool}` (server/drivers/chat-mcp-tools.ts at
 *  UPSTREAM_REVISION), for the one server it mounts here, awwo_workspace (runtime.ts). */
export const modelToolName = (name: string) => `awwo_workspace_${name}`;
/** The pinned core's chat driver lets a turn make 16 model calls (server/drivers/openai-chat.ts at UPSTREAM_REVISION:
 *  `for (let round = 0; round < 16; round++)`) and fails the whole turn when the last answer still asks for a tool: a
 *  task that had done its work lost its answer (2026-10-18). So the call that can be the turn's last asks for the
 *  final answer instead, and a turn the core stopped at that limit is the task's call budget (runtime.ts). */
export const CORE_MODEL_ROUNDS = 16;
export const FINAL_CALL_NOTE = '[AwwO] This is the last model call this task allows: no model call follows it, so a tool you call now ends the task unfinished and you will not see its result. Do not call any tool. Reply with your final answer now: what you did and checked, the files you published, and what is still left and how to continue.';
/** The number of the call that can be a task's last: its own budget, or the core's rounds when they come first. */
export const finalModelCall = (request: Pick<RunRequest, 'maxModelCalls'>) => Math.min(request.maxModelCalls, CORE_MODEL_ROUNDS);
/** The API's model proxy takes at most this many messages in one call (backend/internal/app/computer_model_proxy.go), so
 *  a final call already at it goes as it came, without the note, rather than be refused for one message more. */
export const PROXY_MESSAGES = 128;
/** The model sees a tool result's first 50 KiB of UTF-8, cut wherever that falls (OUTPUT_BYTES in the pinned core's
 *  server/drivers/chat-mcp-tools.ts at UPSTREAM_REVISION), and the core ends the turn on a reply frame over 2 MiB, which
 *  a whole large file could reach (its text escaped twice). So a read's whole result stays within those 50 KiB, and
 *  says it was cut before its text: a flag after the text was itself cut off (review 2026-10-18). */
export const RESULT_BYTES = 50 * 1024;
const encoded = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const readResult = (file: WorkspaceRead) => {
  const { content, ...about } = file;
  if (encoded(file) <= RESULT_BYTES) return { ...about, content };
  // The longest start that fits: never half a UTF-16 pair, and a base64 text in whole 4-character groups.
  const start = (end: number) => file.encoding === 'base64' ? end - end % 4 : /[\ud800-\udbff]/.test(content[end - 1] ?? '') ? end - 1 : end;
  const cut = (end: number) => ({ ...about, truncated: true, content: content.slice(0, start(end)) });
  let low = 0, high = Math.min(content.length, RESULT_BYTES);
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (encoded(cut(mid)) <= RESULT_BYTES) low = mid; else high = mid - 1; }
  return cut(low);
};
const BAD_PATH = new ToolFailure('INVALID_PATH', 'The path is empty, longer than 1,024 bytes, or holds a NUL character.');
const BAD_CONTENT = new ToolFailure('TOO_LARGE', 'The content is larger than a workspace file may be (2 MiB), or holds a NUL character.');
const BAD_COMMAND = new ToolFailure('INVALID_COMMAND', 'The command is empty, longer than 32 KiB, or holds a NUL character.');
export async function listenLocal(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new WorkerError('LISTEN_FAILED', 500);
  return `http://127.0.0.1:${address.port}`;
}
export async function closeServer(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

/** `authorize` is asked before every workspace tool runs, with the name and arguments the core calls it with; it throws
 *  to refuse. A managed run allows only a call its card allowed (runtime.ts); a test that means to allow every call says
 *  so with `() => {}`. */
export async function createTransport(request: RunRequest, sandbox: WorkspaceSandbox, signal: AbortSignal, emit: (event: WorkerEvent) => void,
  authorize: (name: string, args: unknown) => void) {
  const token = randomBytes(32).toString('base64url'), calls: CapturedCall[] = [];
  const published = new Set<string>(); let artifactBytes = 0, modelCalls = 0;
  const publish = (file: WorkspaceRead) => {
    const bytes = Buffer.from(file.content, file.encoding);
    if (bytes.length > LIMITS.artifact || bytes.length !== file.byteLength || hash(bytes) !== file.sha256) throw new WorkerError('ARTIFACT_INVALID');
    const identity = file.path + '\0' + file.sha256;
    if (published.has(identity)) return;
    // Over the task's files nothing more is delivered (the API holds the same limit), and the model can still say so.
    if (published.size >= 16 || artifactBytes + bytes.length > LIMITS.artifacts) throw new ToolFailure('ARTIFACT_BUDGET', 'A task publishes at most 16 files and 8 MiB; this file was not delivered.');
    artifactBytes += bytes.length; published.add(identity);
    emit({ type: 'computer_artifact', name: file.path.split('/').at(-1)!, path: file.path, content: bytes.toString('base64'), encoding: 'base64', sha256: file.sha256 });
  };
  async function tool(name: string, args: unknown): Promise<unknown> {
    authorize(name, args);
    if (!record(args)) throw new WorkerError('INVALID_TOOL_ARGUMENTS');
    const schema = TOOLS.find(tool => tool.name === name);
    if (!schema || Object.keys(args).some(key => !(key in schema.inputSchema.properties))) throw new WorkerError('TOOL_NOT_ALLOWED');
    const field = (value: unknown, max: number, failure: ToolFailure, empty = false) => {
      try { return textField(value, max, empty); } catch { throw failure; }
    };
    const path = () => field(args.path, 1024, BAD_PATH);
    switch (name) {
      case 'list': return sandbox.list(args.path === undefined || args.path === '.' ? '' : field(args.path, 1024, BAD_PATH, true));
      case 'read': return readResult(await sandbox.read(path()));
      // The file's own bytes stay in the workspace: echoing them back cost the model's context and could pass the core's reply limit.
      case 'write': { const file = await sandbox.write(path(), field(args.content, LIMITS.artifact, BAD_CONTENT, true)); return { path: file.path, byteLength: file.byteLength, sha256: file.sha256, written: true }; }
      case 'exec': return sandbox.exec(field(args.command, 32_768, BAD_COMMAND));
      case 'publish': { const file = await sandbox.publish(path()); publish(file); return { path: file.path, sha256: file.sha256, byteLength: file.byteLength, published: true }; }
      case 'archive': { const file = await sandbox.archive(); publish(file); return { path: file.path, sha256: file.sha256, byteLength: file.byteLength, published: true }; }
    }
  }
  const server = createServer(async (req, res) => {
    try {
      if (!safeEqual(String(req.headers.authorization || ''), `Bearer ${token}`)) return json(res, 401, { error: 'UNAUTHORIZED' });
      if (signal.aborted) throw new WorkerError('RUN_CANCELLED', 409);
      if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (req.url === '/mcp') {
        const body = await readJSON(req, LIMITS.event);
        if (!record(body) || body.jsonrpc !== '2.0' || (typeof body.id !== 'string' && typeof body.id !== 'number')) throw new WorkerError('INVALID_RPC');
        let result: unknown;
        if (body.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'awwo-workspace', version: '1.0.0' } };
        else if (body.method === 'tools/list') result = { tools: TOOLS };
        else if (body.method === 'ping') result = {};
        else if (body.method === 'tools/call' && record(body.params) && typeof body.params.name === 'string') {
          try { result = { content: [{ type: 'text', text: JSON.stringify(await tool(body.params.name, body.params.arguments || {})) }] }; }
          catch (e) {
            // A failure the model can correct or report is an ordinary result that did nothing (tool-failures.ts): the
            // core refuses the final answer of a turn that saw any error.
            const failure = recoverableFailure(e);
            result = failure ? { content: [{ type: 'text', text: JSON.stringify(failedResult(body.params.name, failure)) }] }
              : { isError: true, content: [{ type: 'text', text: e instanceof WorkerError ? e.code : 'Workspace operation failed; do not claim it succeeded.' }] };
          }
        } else return json(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not allowed' } });
        return json(res, 200, { jsonrpc: '2.0', id: body.id, result });
      }
      if (req.url === '/v1/chat/completions') {
        const body = await readJSON(req, LIMITS.response);
        if (!record(body) || body.model !== 'awwo-model' || !Array.isArray(body.messages)) throw new WorkerError('INVALID_MODEL_REQUEST');
        if (++modelCalls > request.maxModelCalls) throw new WorkerError('MODEL_BUDGET_EXCEEDED', 429);
        const messages = modelCalls === finalModelCall(request) && body.messages.length < PROXY_MESSAGES
          ? [...body.messages, { role: 'user', content: FINAL_CALL_NOTE }] : body.messages;
        const endpoint = request.modelProxyURL.replace(/\/+$/, '');
        const response = await fetch(endpoint.endsWith('/chat/completions') ? endpoint : endpoint + '/chat/completions', {
          method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${request.modelProxyToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, messages, model: 'awwo-model', stream: false, stream_options: undefined }), signal,
        });
        if (!response.ok) {
          let code = 'MODEL_PROXY_REJECTED';
          try { code = proxyErrorCode(await responseJSON(response, 16_384)); } catch { await response.body?.cancel().catch(() => {}); }
          diagnostic('model_proxy_rejected', request.runId, code, response.status);
          throw new WorkerError('MODEL_PROXY_FAILED', 502);
        }
        const completion = await responseJSON(response);
        if (!record(completion) || !Array.isArray(completion.choices)) throw new WorkerError('MODEL_RESPONSE_INVALID', 502);
        const choice = completion.choices[0];
        if (record(choice) && record(choice.message) && Array.isArray(choice.message.tool_calls)) {
          if (choice.message.tool_calls.length > 32) throw new WorkerError('TOOL_BUDGET_EXCEEDED');
          // Every call of the turn's own answers, in order, under the model's call id: one whose arguments are too large, not
          // JSON or not an object is kept without them, so a card for it can never be given another call's. An answer to a
          // call that declared no tools (the core's text-only helper: a summary, a memory note) runs no call and opens no
          // card, so its calls are never kept (review 2026-10-19).
          if (Array.isArray(body.tools) && body.tools.length) for (const call of choice.message.tool_calls) {
            const fn = record(call) && record(call.function) ? call.function : undefined;
            let args: unknown; try { args = JSON.parse(textField(fn?.arguments, LIMITS.toolArguments, true)); } catch { args = undefined; }
            calls.push({ id: record(call) && typeof call.id === 'string' ? call.id : '', tool: typeof fn?.name === 'string' ? fn.name : '', ...(record(args) ? { arguments: args } : {}) });
          }
        }
        return json(res, 200, completion);
      }
      json(res, 404, { error: 'NOT_FOUND' });
    } catch (e) { if (!res.headersSent) json(res, e instanceof WorkerError ? e.status : 502, { error: { message: e instanceof WorkerError ? e.code : 'MANAGED_TRANSPORT_FAILED', type: 'awwo_error' } }); else res.destroy(); }
  });
  const url = await listenLocal(server);
  return { token, url, calls, modelCalls: () => modelCalls, close: () => closeServer(server) };
}
