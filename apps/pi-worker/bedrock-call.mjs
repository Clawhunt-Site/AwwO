import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherChatStream } from '../computer-model.ts';

// One managed-execution Bedrock call (the canvas assistant's direct task, POST /internal/computer-model), made in an
// isolated child the way a Bedrock run's model calls are made (pi-task.mjs). The parent forks it with no Node options
// and only the variables workerEnvironment allows, and sends it the credentials the parent already resolved together
// with the one request, over private IPC. The child sends the request through the Converse bridge, gathers the stream
// into one Chat Completions answer, sends that back and exits. It never reads the AWS credential chain or the
// parent's environment, so nothing in the parent's environment reaches the AWS SDK. A failure is answered with its
// kind only (a label such as `bedrock:403:AccessDeniedException`), never with provider text.

const LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;
const label = (value) => (typeof value === 'string' && LABEL.test(value) ? value : 'unknown');

async function loadBridge() {
  const [{ childBedrockFetch }, sdk] = await Promise.all([import('../bedrock-bridge.ts'), import('@aws-sdk/client-bedrock-runtime')]);
  return { childBedrockFetch, sdk };
}

/** The call: `{ ok: true, raw }` with the gathered answer, or `{ ok: false, reason }`. `load` is for tests (a fake SDK). */
export async function bedrockCall(message, { load = loadBridge } = {}) {
  // The bridge's content-free facts (a fallback to the model's other profile, a failure's error type), sent back with
  // the answer for the parent's log; an answer without any carries none.
  const facts = [];
  const answer = (value) => (facts.length ? { ...value, facts } : value);
  let upstream;
  try {
    const { childBedrockFetch, sdk } = await load();
    // A managed call never has a thinking budget: its parent sends none.
    const bridge = childBedrockFetch(message, message.auth, sdk, (fact) => { if (facts.length < 4) facts.push(fact); });
    upstream = await bridge(message.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: message.body });
  } catch (error) {
    return answer({ ok: false, reason: `bridge-error:${label(error?.name)}` });
  }
  if (!upstream.ok || !upstream.body) {
    // The bridge's error body names the AWS exception (or its own refusal) by type; its message is never relayed.
    let type = 'unknown';
    try { type = label((await upstream.json())?.error?.type); } catch { await upstream.body?.cancel().catch(() => {}); }
    return answer({ ok: false, reason: `bedrock:${upstream.status}:${type}` });
  }
  try {
    return answer({ ok: true, raw: await gatherChatStream(upstream.body) });
  } catch (error) {
    // What broke the stream, by kind (gatherChatStream's detail): an AWS failure after it began (`stream:error:429:…`),
    // the bridge's own refusal of what the model sent (`stream:error:api_error`), or a stream that ended or read wrong.
    return answer({ ok: false, reason: `stream:${typeof error?.detail === 'string' ? label(error.detail) : 'shape'}` });
  }
}

if (process.send && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once('message', async (message) => {
    let answer;
    try { answer = await bedrockCall(message); } catch (error) { answer = { ok: false, reason: `child:${label(error?.name)}` }; }
    process.send(answer, () => process.exit(0));
  });
  // The parent going away ends the call: nothing would read its answer.
  process.once('disconnect', () => process.exit(0));
}
