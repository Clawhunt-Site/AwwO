import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseEnv, port, waitForHttp } from './awwo-saas-lib.mjs';
test('local dotenv reads literal values without executing shell expressions', () => {
  assert.deepEqual(parseEnv('# comment\nMODEL=abc\nKEY="a=b"\nEMPTY=\nLITERAL=$(touch danger)\n'), { MODEL:'abc',KEY:'a=b',EMPTY:'',LITERAL:'$(touch danger)' });
  assert.throws(() => parseEnv('export KEY=x'));
});
test('local startup accepts an explicitly unconfigured Pi, but rejects unrelated unavailable services', async () => {
  let body = { status:'unconfigured', ready:false, configured:false, piVersion:'0.85.1' };
  const server = createServer((_req,res) => { res.writeHead(503, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/health`;
    await waitForHttp(url, {exitCode:null}, 300, {allowUnconfiguredPi:true});
    await assert.rejects(waitForHttp(url,{exitCode:null},200), /timed out/);
    body = { status:'stopping', ready:false, configured:false, piVersion:'0.85.1' };
    await assert.rejects(waitForHttp(url,{exitCode:null},200,{allowUnconfiguredPi:true}), /timed out/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('ports reject command fragments, privileged and out of range values', () => {
  assert.equal(port('8087','port'),8087);
  for (const value of ['80','0','65536','8087 -h 0.0.0.0','NaN','1.5']) assert.throws(() => port(value,'port'));
});
