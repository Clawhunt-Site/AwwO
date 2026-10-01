import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { WorkspaceSandbox, WorkspaceRead } from '../openai-agents-worker/workspace-sandbox.ts';
import { LIMITS, WorkerError, hash, json, readJSON, record, responseJSON, safeEqual, textField, type RunRequest, type WorkerEvent } from './protocol.ts';
import { diagnostic, proxyErrorCode } from './diagnostics.ts';

const prop = (description: string) => ({ type: 'string', description });
export const TOOLS = [
  { name: 'list', description: 'List files in the isolated AwwO workspace. No host files are available.', inputSchema: { type: 'object', properties: { path: prop('Relative directory; empty for root') }, additionalProperties: false } },
  { name: 'read', description: 'Read a real file in the isolated workspace.', inputSchema: { type: 'object', properties: { path: prop('Relative file path') }, required: ['path'], additionalProperties: false } },
  { name: 'write', description: 'Write UTF-8 source in the isolated workspace. Never writes host files.', inputSchema: { type: 'object', properties: { path: prop('Relative file path'), content: prop('Complete UTF-8 content') }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'exec', description: 'Execute a shell command inside the real Docker workspace, with no network or host credentials. Inspect exitCode and output. This is not a desktop or browser.', inputSchema: { type: 'object', properties: { command: prop('Shell command within /workspace') }, required: ['command'], additionalProperties: false } },
  { name: 'publish', description: 'Publish exact verified bytes of an existing file as an AwwO artifact.', inputSchema: { type: 'object', properties: { path: prop('Relative existing file path') }, required: ['path'], additionalProperties: false } },
  { name: 'archive', description: 'Publish the actual workspace source as workspace.zip.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
] as const;
export type CapturedCall = { tool: string; arguments: Record<string, unknown> };
export async function listenLocal(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new WorkerError('LISTEN_FAILED', 500);
  return `http://127.0.0.1:${address.port}`;
}
export async function closeServer(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

export async function createTransport(request: RunRequest, sandbox: WorkspaceSandbox, signal: AbortSignal, emit: (event: WorkerEvent) => void) {
  const token = randomBytes(32).toString('base64url'), calls: CapturedCall[] = [];
  const published = new Set<string>(); let artifactBytes = 0, modelCalls = 0;
  const publish = (file: WorkspaceRead) => {
    const bytes = Buffer.from(file.content, file.encoding);
    if (bytes.length > LIMITS.artifact || bytes.length !== file.byteLength || hash(bytes) !== file.sha256) throw new WorkerError('ARTIFACT_INVALID');
    const identity = file.path + '\0' + file.sha256;
    if (published.has(identity)) return;
    if (published.size >= 16 || artifactBytes + bytes.length > LIMITS.artifacts) throw new WorkerError('ARTIFACT_BUDGET_EXCEEDED');
    artifactBytes += bytes.length; published.add(identity);
    emit({ type: 'computer_artifact', name: file.path.split('/').at(-1)!, path: file.path, content: bytes.toString('base64'), encoding: 'base64', sha256: file.sha256 });
  };
  async function tool(name: string, args: unknown): Promise<unknown> {
    if (!record(args)) throw new WorkerError('INVALID_TOOL_ARGUMENTS');
    const schema = TOOLS.find(tool => tool.name === name);
    if (!schema || Object.keys(args).some(key => !(key in schema.inputSchema.properties))) throw new WorkerError('TOOL_NOT_ALLOWED');
    const path = () => textField(args.path, 1024);
    switch (name) {
      case 'list': return sandbox.list(args.path === undefined || args.path === '.' ? '' : textField(args.path, 1024, true));
      case 'read': return sandbox.read(path());
      case 'write': return sandbox.write(path(), textField(args.content, LIMITS.artifact, true));
      case 'exec': return sandbox.exec(textField(args.command, 32_768));
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
          catch (e) { result = { isError: true, content: [{ type: 'text', text: e instanceof WorkerError ? e.code : 'Workspace operation failed; do not claim it succeeded.' }] }; }
        } else return json(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not allowed' } });
        return json(res, 200, { jsonrpc: '2.0', id: body.id, result });
      }
      if (req.url === '/v1/chat/completions') {
        const body = await readJSON(req, LIMITS.response);
        if (!record(body) || body.model !== 'awwo-model' || !Array.isArray(body.messages)) throw new WorkerError('INVALID_MODEL_REQUEST');
        if (++modelCalls > request.maxModelCalls) throw new WorkerError('MODEL_BUDGET_EXCEEDED', 429);
        const endpoint = request.modelProxyURL.replace(/\/+$/, '');
        const response = await fetch(endpoint.endsWith('/chat/completions') ? endpoint : endpoint + '/chat/completions', {
          method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${request.modelProxyToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, model: 'awwo-model', stream: false, stream_options: undefined }), signal,
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
          for (const call of choice.message.tool_calls) {
            if (!record(call) || !record(call.function) || typeof call.function.name !== 'string') continue;
            let args: unknown; try { args = JSON.parse(textField(call.function.arguments, LIMITS.request, true)); } catch { continue; }
            if (record(args)) calls.push({ tool: call.function.name, arguments: args });
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
