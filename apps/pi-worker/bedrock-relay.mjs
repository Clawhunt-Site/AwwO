import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// One Bedrock call for AwwO 本地版 through the hosted site (docs/awwo-cloud-relay.md, POST /internal/relay-model), made
// in an isolated child as the managed calls are (bedrock-call.mjs): the parent forks it with no Node options and only
// the variables workerEnvironment allows, and sends it the credentials it already resolved together with the one
// request, over private IPC. The child sends the request through the Converse bridge and passes the answer back as it
// comes instead of gathering it: a refusal before any stream by its kind (the bridge's status and error type), else the
// stream's text piece by piece, each sent once the last one was taken, then its end. It never reads the AWS credential
// chain or the parent's environment, and never passes on AWS's words: the bridge keeps them out of all it answers.

const LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;
const label = (value) => (typeof value === 'string' && LABEL.test(value) ? value : 'unknown');
const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
// A request the bridge refuses as one it cannot take faithfully, or as larger than the model's window, is refused in the
// bridge's own words, which say what to change (a field, the size); they are never AWS's. Other refusals go by kind.
const OWN_WORDS = new Set(['invalid_request_error', 'context_length_exceeded']);

async function loadBridge() {
  const [{ childBedrockFetch }, sdk] = await Promise.all([import('../bedrock-bridge.ts'), import('@aws-sdk/client-bedrock-runtime')]);
  return { childBedrockFetch, sdk };
}

/** The call. `send` takes one message to the parent and resolves once it has gone; `load` is for tests (a fake SDK). */
export async function relayCall(message, send, { load = loadBridge } = {}) {
  let upstream;
  // Whether the bridge turned to the model's other profile: a refusal after that is the second request's.
  let fellBack = false;
  try {
    const { childBedrockFetch, sdk } = await load();
    // A relayed call never has a thinking budget: its parent sends none.
    const bridge = childBedrockFetch(message, message.auth, sdk, (fact) => {
      if (plain(fact) && fact.event === 'fallback') fellBack = true;
      void send({ type: 'fact', fact });
    });
    upstream = await bridge(message.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: message.body });
  } catch (error) {
    return send({ type: 'failed', reason: `bridge-error:${label(error?.name)}` });
  }
  if (!upstream.ok || !upstream.body) {
    let error = {};
    try { error = (await upstream.json())?.error ?? {}; } catch { await upstream.body?.cancel().catch(() => {}); }
    const type = label(error.type);
    return send({ type: 'refused', status: upstream.status, error: { type,
      // The bridge names a status only where AWS answered (bedrock-bridge.ts errorBody).
      upstream: Number.isInteger(error.status), ...(fellBack ? { fallback: true } : {}),
      ...(OWN_WORDS.has(type) && typeof error.message === 'string' ? { message: error.message.slice(0, 300) } : {}) } });
  }
  const decoder = new TextDecoder();
  try {
    for await (const chunk of upstream.body) {
      const text = decoder.decode(chunk, { stream: true });
      if (text) await send({ type: 'data', text });
    }
    const rest = decoder.decode();
    if (rest) await send({ type: 'data', text: rest });
  } catch {
    // The bridge ends a stream that failed after it began with its own error frame, so what breaks here is the read.
    return send({ type: 'failed', reason: 'stream' });
  }
  return send({ type: 'end' });
}

if (process.send && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const send = (message) => new Promise((done) => {
    try { process.send(message, () => done()); } catch { done(); }
  });
  process.once('message', async (message) => {
    try { await relayCall(message, send); } catch (error) { await send({ type: 'failed', reason: `child:${label(error?.name)}` }); }
    process.exit(0);
  });
  // The parent going away ends the call: nothing would read its answer.
  process.once('disconnect', () => process.exit(0));
}
