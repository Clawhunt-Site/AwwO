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

describe('a delivery’s JSON fence', () => {
  // What deliveryJsonSource read with a regex before 2026-11-08, which backtracked quadratically on blank lines after a
  // fence that never closes. The fence is now read by position; it must read every text as the regex did.
  const byRegex = (output: string) => {
    const trimmed = output.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return closeUnterminatedJsonObject(fenced ? fenced[1] : trimmed);
  };

  it('reads every fence as the regex it replaces did', () => {
    const texts = ['{"a":"x"}', '```json\n{"a":"x"}\n```', '```JSON {"a":"x"} ```', '```\n{"a":"x"\n```', '  ```json\n\n{"a":1}\n\n```  ',
      '```json```', '``````', '`````', '````', '```', '```x```', '```jsonx\n{}\n```', '```js\n{}\n```', '```json\n{}\n````', '````json\n{}\n```',
      '```html\n<!doctype html><html><head></head><body></body></html>\n```', '```json\n{"a":"```"}\n```', 'prose ```json\n{}\n```',
      '```json\n{}\n``` and words', '\uFEFF```json\n{"a":"x"}\n```\uFEFF', '```json\n\u00a0{"a":"x"}\u2028\n```', 'Done.', '', '   '];
    for (const text of texts) expect(deliveryJsonSource(text)).toBe(byRegex(text));
  });

  it('reads a fence that never closes, after any number of blank lines, at once', () => {
    const open = '```json' + '\n'.repeat(50_000) + 'x';
    const started = performance.now();
    expect(deliveryJsonSource(open)).toBe(open);
    expect(deliveryJsonSource(`${open}\n\`\`\``)).toBe('x');
    // The regex took about 0.8 s at 2,000 lines, and grows with their square.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('the closers’ trailing whitespace', () => {
  it('is dropped as the regex it replaces did, and a long run inside the text costs nothing', () => {
    const byRegex = (text: string) => text.replace(/[ \t\r\n]+$/, '');
    for (const tail of ['', ' ', '\n', '\t \r\n ', '\u00a0', ' \u00a0 ', '\f']) {
      const text = `{"a":"x"${tail}`;
      const expected = byRegex(text).endsWith('"') ? `${byRegex(text)}}` : text;
      expect(closeUnterminatedJsonObject(text)).toBe(expected);
    }
    // An unbalanced object with 200,000 spaces before its last character: the regex took seconds (quadratic in the run).
    const text = `{"a":1${' '.repeat(200_000)}x`;
    const started = performance.now();
    expect(closeUnterminatedJsonObject(text)).toBe(text);
    expect(closeUnterminatedJsonObject(`{"a":"x"${' '.repeat(200_000)}`)).toBe('{"a":"x"}');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
