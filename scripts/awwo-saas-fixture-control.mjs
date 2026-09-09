// Explicit control of the isolated browser fixture only; no application API backdoor.
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function controlFixture(credentialsFile, rulesFile) {
  if (((await stat(credentialsFile)).mode & 0o077) !== 0) throw new Error('Fixture credentials must be private (0600)');
  const credentials = JSON.parse(await readFile(credentialsFile, 'utf8'));
  const url = new URL(credentials.controlURL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/__fixture/control' || url.search || url.hash || url.username || url.password) throw new Error('Control URL must be the loopback fixture control endpoint');
  if (typeof credentials.controlToken !== 'string' || credentials.controlToken.length < 32) throw new Error('Missing fixture control token');
  const body = await readFile(rulesFile, 'utf8');
  if (Buffer.byteLength(body) > 16384) throw new Error('Rules file is too large');
  JSON.parse(body);
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${credentials.controlToken}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Fixture rejected rules (${response.status})`);
  return response.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--credentials' || args[2] !== '--rules') {
    console.error('Usage: node scripts/awwo-saas-fixture-control.mjs --credentials <600-file> --rules <json-file>'); process.exitCode = 1;
  } else controlFixture(args[1], args[3]).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
