import { createServer } from 'node:http';
import { once } from 'node:events';
import { loadConfig } from './config.mjs';
import { startIsolatedRun } from './runner.mjs';

export const request = (overrides = {}) => ({ runId: 'run-1', tenantId: 'tenant-1', sessionId: 'session-1', prompt: 'Reply briefly.', messages: [], runtime: 'openai-agents', ...overrides });
export const configuration = (overrides = {}) => loadConfig({
  AWWO_OPENAI_AGENTS_TOKEN: 'test-only-internal-token-at-least-32-characters',
  AWWO_OPENAI_AGENTS_MODEL: 'fixture-model', AWWO_OPENAI_AGENTS_API_KEY: 'fixture-key',
  AWWO_OPENAI_AGENTS_BASE_URL: 'http://127.0.0.1:1/v1',
  AWWO_OPENAI_AGENTS_CANCEL_GRACE_MS: '100', ...overrides,
});
export async function fixture(t, { mode = 'text', text = 'Hello from Agents', calls = [], tool = 'calculator', args = { expression: '(2+3)*4' }, status = 200, delay = 0, usage, multilineUsage = false, responseUsage = { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } = {}) {
  let received;
  const ready = new Promise(resolve => { received = resolve; });
  const server = createServer(async (req, res) => {
    let bytes = '';
    for await (const chunk of req) bytes += chunk;
    const call = { url: req.url, headers: req.headers, body: JSON.parse(bytes) };
    calls.push(call); received(call);
    if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'private-upstream-key-payload', type: 'fixture_error' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (req.url.endsWith('/responses')) {
      if (mode === 'tool') {
        const serialized = typeof args === 'string' ? args : JSON.stringify(args);
        const item = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: tool, arguments: serialized, status: 'completed' };
        const response = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', model: 'fixture-model', output: [item], usage: responseUsage };
        const event = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
        event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
        event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } });
        event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: serialized });
        event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: serialized });
        event('response.output_item.done', { output_index: 0, item });
        event('response.completed', { response }); res.end(); return;
      }
      const message = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      const response = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', model: 'fixture-model', output: [message], usage: responseUsage };
      const event = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
      event('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
      event('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      event('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: text });
      event('response.output_text.done', { item_id: message.id, output_index: 0, content_index: 0, text });
      event('response.content_part.done', { item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
      event('response.output_item.done', { output_index: 0, item: message });
      event('response.completed', { response }); res.end(); return;
    }
    send({ role: 'assistant', content: mode === 'tool' || mode === 'double-tool' ? 'Provisional preamble.' : text });
    if (mode === 'stall') return;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (mode === 'tool' || mode === 'double-tool') {
      const item = index => ({ index, id: `call_${index}`, type: 'function', function: { name: tool, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
      send({ tool_calls: mode === 'double-tool' ? [item(0), item(1)] : [item(0)] }); send({}, 'tool_calls');
    } else if (mode !== 'missing-finish') send({}, mode === 'length' ? 'length' : mode === 'refusal' ? 'content_filter' : 'stop');
    if (usage !== undefined) res.write(JSON.stringify({ choices: [], usage }, null, multilineUsage ? 2 : undefined).split('\n').map(line => `data: ${line}`).join('\n') + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, baseURL: `http://127.0.0.1:${server.address().port}/v1`, calls, ready };
}
export async function run(config, input = request(), onEvent = () => {}) {
  const events = []; let released = false;
  const handle = await startIsolatedRun({ config, request: input, onEvent: event => { events.push(event); onEvent(event, released); }, onExit: () => { released = true; } });
  return { ...handle, events, result: handle.done.then(() => events.at(-1)) };
}
