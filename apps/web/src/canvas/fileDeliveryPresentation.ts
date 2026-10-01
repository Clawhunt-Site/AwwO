import { parseContractOutput, type NodeContract } from './nodeContracts';

export interface PendingFileDelivery { name: string; byteLength?: number }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const FILE_LIMIT = 2 * 1024 * 1024;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodedByteLength(value: string): number | undefined {
  if (value.length > Math.ceil(FILE_LIMIT / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if ((padding === 2 && (alphabet.indexOf(value.at(-3)!) & 15) !== 0)
    || (padding === 1 && (alphabet.indexOf(value.at(-2)!) & 3) !== 0)) return;
  const bytes = value.length / 4 * 3 - padding;
  return bytes <= FILE_LIMIT ? bytes : undefined;
}

/** Transport bytes are not a stored download reference. This is display metadata only. */
export function pendingFileDelivery(value: unknown): PendingFileDelivery | undefined {
  if (!object(value) || typeof value.name !== 'string') return;
  if (value.invalidContent === true) return;
  const name = value.name.trim();
  if (!name || new TextEncoder().encode(name).byteLength > 200 || name === '.' || name === '..' || /[/\\\u0000-\u001f\u007f]/.test(name)) return;
  // Omission markers can also be authored by a model. Without actual bytes they
  // cannot satisfy a file field, even when they match the server's read projection.
  if (typeof value.content !== 'string') return;
  if (value.encoding === 'base64') {
    const byteLength = encodedByteLength(value.content);
    return byteLength === undefined ? undefined : { name, byteLength };
  }
  if (value.encoding !== undefined) return;
  const byteLength = new TextEncoder().encode(value.content).byteLength;
  return byteLength <= 256 * 1024 ? { name, byteLength } : undefined;
}

/** Linear scan also handles prose-prefixed, reordered or truncated JSON transports. It
 * deliberately needs no filename: an interrupted stream may not have delivered it yet. */
function redactLargeContentStrings(source: string): string {
  const key = /"content"\s*:\s*"/g;
  let result = '', copied = 0;
  for (let match = key.exec(source); match; match = key.exec(source)) {
    const start = key.lastIndex;
    let end = start;
    while (end < source.length && source[end] !== '"') end += source[end] === '\\' && end + 1 < source.length ? 2 : 1;
    if (end - start >= 512) {
      result += source.slice(copied, start) + '[large attachment content omitted]';
      copied = end;
    }
    key.lastIndex = end < source.length ? end + 1 : end;
  }
  return copied ? result + source.slice(copied) : source;
}

function envelope(source: string): unknown {
  const trimmed = source.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

/** Keep ordinary source byte-for-byte; encoded attachments never belong in the transcript DOM. */
export function fileSafeDisplaySource(source: string): string {
  try {
    const parsed: unknown = envelope(source);
    let replaced = false;
    const safe = JSON.stringify(parsed, (_key, value: unknown) => {
      const file = pendingFileDelivery(value);
      if (file) {
        replaced = true;
        return { ...file, contentOmitted: true, storedReference: 'unavailable' };
      }
      if (object(value) && value.contentOmitted === true && value.storedReference === 'unavailable') {
        replaced = true;
        // Present only an explicitly unverified marker, never a URL or a claim
        // that bytes were received. Contract validation still rejects this object.
        return { ...(typeof value.name === 'string' ? { name: value.name.slice(0, 200) } : {}),
          contentOmitted: true, storedReference: 'unavailable', verified: false,
          ...(value.invalidContent === true ? { invalidContent: true } : {}) };
      }
      if (object(value) && typeof value.content === 'string' && (typeof value.name === 'string' || value.encoding !== undefined)) {
        replaced = true;
        return { ...(typeof value.name === 'string' ? { name: value.name.slice(0, 200) } : {}), contentOmitted: true, invalidAttachment: true };
      }
      if (typeof value === 'string') {
        const redacted = redactLargeContentStrings(value);
        if (redacted !== value) replaced = true;
        return redacted;
      }
      return value;
    });
    return redactLargeContentStrings(replaced ? safe : source);
  } catch {
    return redactLargeContentStrings(source);
  }
}

/** Read a mixed legacy file envelope without weakening execution or publication validation. */
export function deliveryPresentation(contract: NodeContract, source: string) {
  let parsed: unknown;
  try { parsed = envelope(source); } catch { parsed = undefined; }
  const pendingFiles = new Map<string, PendingFileDelivery>();
  if (object(parsed)) for (const field of contract.outputs) {
    if (field.type !== 'file') continue;
    const file = pendingFileDelivery(parsed[field.id]);
    if (file) pendingFiles.set(field.id, file);
  }
  const readableContract = { ...contract, outputs: contract.outputs.filter(field => !pendingFiles.has(field.id)) };
  const result = readableContract.outputs.length ? parseContractOutput(readableContract, source) : { values: {}, errors: [] };
  return { ...result, pendingFiles, displaySource: fileSafeDisplaySource(source) };
}
