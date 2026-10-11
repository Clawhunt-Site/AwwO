import { describe, expect, it } from 'vitest';
import { closeUnterminatedJsonObject, deliveryJsonSource } from '../src/canvas/deliveryJson';
import { parseContractOutput, type NodeContract } from '../src/canvas/nodeContracts';
import { deliveryPresentation, fileSafeDisplaySource } from '../src/canvas/fileDeliveryPresentation';

// The shape a coding node delivered on 2026-10-10: a complete game in a file field with only the
// final closing brace of the outer object missing. Server and canvas must both accept it.
const page = '<!doctype html><html><head><title>Game</title></head><body><script>if (ready) { start({ hp: [100] }); }</script></body></html>';
const game: NodeContract = { version: 1, inputs: [], outputs: [
  { id: 'delivery', type: 'markdown', required: true, label: '交付说明', value: '' },
  { id: 'preview', type: 'file', required: false, label: '可运行页面', value: '' },
  { id: 'checks', type: 'markdown', required: false, label: '检查', value: '' },
] };
const unclosed = `{"delivery":"实现页面：\\n1. 主菜单","preview":{"name":"index.html","content":${JSON.stringify(page)}}`;

describe('delivery JSON missing its final closers', () => {
  it('restores only closers missing at the very end, exactly like the server', () => {
    const cases: Array<[string, string]> = [
      ['{"a":"x"', '{"a":"x"}'],
      ['{"a":"x","f":{"name":"index.html","content":"<html></html>"}', '{"a":"x","f":{"name":"index.html","content":"<html></html>"}}'],
      ['{"a":["x","y"]', '{"a":["x","y"]}'],
      ['{"a":[{"b":"c"', '{"a":[{"b":"c"}]}'],
      ['{"a":"say \\"hi\\""', '{"a":"say \\"hi\\""}'],
      ['{"a":"C:\\\\"', '{"a":"C:\\\\"}'],
      ['{"code":"if (a) { b(); } else { c[0]; }"', '{"code":"if (a) { b(); } else { c[0]; }"}'],
      ['{"a":"x"\n  ', '{"a":"x"}'],
      ['{"a":"x"}', '{"a":"x"}'],
      // A different defect stays a failure.
      ['{"a":"unfinished', '{"a":"unfinished'],
      ['{"a":"x",', '{"a":"x",'],
      ['{"a":', '{"a":'],
      ['{"a":"x","b"', '{"a":"x","b"'],
      ['{"n":12', '{"n":12'],
      ['{"b":true', '{"b":true'],
      ['{"a":[}', '{"a":[}'],
      ['{"a":"x"} trailing', '{"a":"x"} trailing'],
      ['["x"', '["x"'],
      ['Done.', 'Done.'],
      ['{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":"x"', '{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":"x"'],
    ];
    for (const [input, expected] of cases) {
      expect(closeUnterminatedJsonObject(input)).toBe(expected);
      expect(closeUnterminatedJsonObject(closeUnterminatedJsonObject(input))).toBe(expected);
    }
    expect(deliveryJsonSource('```json\n{"a":"x"\n```')).toBe('{"a":"x"}');
  });

  it('reads the delivery and its pending file instead of reporting a malformed object', () => {
    const presented = deliveryPresentation(game, unclosed);
    expect(presented.errors).toEqual([]);
    expect(presented.values.delivery).toBe('实现页面：\n1. 主菜单');
    expect(presented.pendingFiles.get('preview')).toEqual({ name: 'index.html', byteLength: new TextEncoder().encode(page).byteLength });
    // File bytes still never reach the transcript DOM.
    expect(presented.displaySource).not.toContain('start({');
    expect(fileSafeDisplaySource('```json\n' + unclosed + '\n```')).not.toContain('start({');
  });

  it('keeps a delivery cut off inside its content incomplete', () => {
    const cut = '{"delivery":"x","preview":{"name":"index.html","content":"<!doctype html><html><body><script>if (ready) {';
    const presented = deliveryPresentation(game, cut);
    expect(presented.pendingFiles.size).toBe(0);
    expect(presented.errors.length).toBeGreaterThan(0);
  });

  it('reads one-field contracts from the restored object and keeps plain prose whole', () => {
    const html = '<html><head></head><body>Result</body></html>';
    const single: NodeContract = { version: 1, inputs: [], outputs: [{ id: 'page', type: 'html', required: true, label: '页面', value: '' }] };
    expect(parseContractOutput(single, `{"page":${JSON.stringify(html)}`)).toEqual({ values: { page: html }, errors: [] });
    const prose: NodeContract = { version: 1, inputs: [], outputs: [{ id: 'answer', type: 'markdown', required: true, label: '回答', value: '' }] };
    expect(parseContractOutput(prose, '{"other":"x"').values.answer).toBe('{"other":"x"');
  });
});
