// Trusted transport only. Model-controlled input never becomes a host command.
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { responseJSON, record } from './protocol.ts';

export async function startShim() {
  const target = process.env.AWWO_WORKSPACE_URL || '', token = process.env.AWWO_WORKSPACE_TOKEN || '';
  const url = new URL(target);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || !token) throw new Error('Invalid managed workspace transport');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = 0;
  input.on('line', line => {
    if (Buffer.byteLength(line) > 3 * 1024 * 1024 || ++pending > 16) { process.exitCode = 1; input.close(); process.stdin.destroy(); return; }
    void (async () => {
      let request: unknown;
      try {
        request = JSON.parse(line);
        if (!record(request) || request.jsonrpc !== '2.0') return;
        if (request.id === undefined) return;
        const response = await fetch(target, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: line, signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error('Workspace transport failed');
        const result = await responseJSON(response);
        process.stdout.write(JSON.stringify(result) + '\n');
      } catch {
        if (record(request) && request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Managed workspace request failed' } }) + '\n');
      } finally { pending--; }
    })();
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void startShim();
