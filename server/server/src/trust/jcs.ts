/**
 * Trust primitives — JCS (RFC 8785) canonicalization + NFC pre-normalization.
 *
 * Byte-for-byte Node port of the SuperClaw kernel cross-repo contract
 * `packages/superclaw/src/superclaw/trust_contracts.py`. Verified against golden
 * vectors generated from that module (see __tests__/fixtures/trust-golden-vectors.json
 * + scripts gen_golden.py). Any divergence breaks signature verification against
 * envelopes signed by ClawHunt, so this MUST stay exact.
 */

export class TrustContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustContractError";
  }
}

// JS Number.MAX_SAFE_INTEGER (2^53 - 1). Integers outside [-MAX, MAX] are rejected;
// carry them as decimal strings instead (matches the kernel + JS Number safety).
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

// ECMAScript JSON.stringify short escapes (RFC 8785 §3.2.2.2).
const SHORT_ESCAPES: Record<number, string> = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r",
  0x22: '\\"',
  0x5c: "\\\\",
};

// Lone (unpaired) UTF-16 surrogate detector — these cannot UTF-8 encode; the
// kernel surfaces them as a TrustContractError rather than silently replacing with
// U+FFFD (which TextEncoder would otherwise do), so we fail closed identically.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function escapeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    const short = SHORT_ESCAPES[code];
    if (short !== undefined) {
      out += short;
    } else if (code < 0x20) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out + '"';
}

// RFC 8785 §3.2.3: object keys sort by UTF-16 code units. JavaScript's default
// string comparison IS UTF-16 code-unit order (== UTF-16-BE byte order), so a
// plain sort matches the kernel's `key.encode("utf-16-be")` sort, including the
// non-BMP/surrogate ordering that differs from code-point order.
function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}

function serialize(value: unknown): string {
  if (value === true) return "true";
  if (value === false) return "false";
  if (value === null) return "null";
  if (typeof value === "string") return escapeString(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TrustContractError(
        "floats are not permitted in trust metadata (use integer minor units or a decimal string)",
      );
    }
    if (value < -MAX_SAFE_INTEGER || value > MAX_SAFE_INTEGER) {
      throw new TrustContractError(
        "integer outside JS safe range; carry it as a decimal string instead",
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => serialize(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const items = sortedKeys(obj).map((key) => escapeString(key) + ":" + serialize(obj[key]));
    return "{" + items.join(",") + "}";
  }
  throw new TrustContractError(`unsupported type for canonical JSON: ${typeof value}`);
}

/**
 * Serialize a JSON-compatible value to RFC 8785 (JCS) canonical UTF-8 bytes.
 *
 * Caller is responsible for pre-signing NFC normalization (`nfcNormalize`); this
 * does NOT normalize Unicode (per JCS). Floats and out-of-range ints are rejected.
 */
export function jcsCanonicalize(value: unknown): Uint8Array {
  const serialized = serialize(value);
  if (LONE_SURROGATE.test(serialized)) {
    throw new TrustContractError("value contains invalid Unicode (lone surrogate)");
  }
  return new TextEncoder().encode(serialized);
}

/**
 * Reject any JSON *float number literal* (a number token containing `.`, `e`, or
 * `E`) anywhere outside a string. `JSON.parse` collapses `7.0` → `7`, erasing the
 * distinction the kernel preserves: Python's `json.loads` yields a float and JCS
 * rejects it. Without this, an envelope rewritten `"n":7` → `"n":7.0` would verify
 * in Node (identical canonical bytes) while the kernel rejects it — a parity gap.
 * Callers ingesting UNTRUSTED JSON text (e.g. a fetched signature envelope) MUST use
 * `parseTrustJson` rather than `JSON.parse` so the two implementations agree.
 */
function assertNoFloatNumberTokens(text: string): void {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      let j = c === "-" ? i + 1 : i;
      let isFloat = false;
      while (j < text.length) {
        const d = text[j];
        if (d >= "0" && d <= "9") {
          j += 1;
        } else if (d === "." || d === "e" || d === "E") {
          isFloat = true;
          j += 1;
        } else if (d === "+" || d === "-") {
          // Only valid as an exponent sign; the token is already flagged float by e/E.
          j += 1;
        } else {
          break;
        }
      }
      if (isFloat) {
        throw new TrustContractError(
          "floats are not permitted in trust metadata (use integer minor units or a decimal string)",
        );
      }
      i = j - 1;
    }
  }
}

/**
 * Parse untrusted JSON text for the trust path, rejecting float number literals so
 * the result matches what the Python kernel would accept. Use this instead of
 * `JSON.parse` / `response.json()` for any signature envelope fetched off the wire.
 */
export function parseTrustJson(text: string): unknown {
  assertNoFloatNumberTokens(text);
  return JSON.parse(text);
}

/**
 * Pre-signing data-model normalization: NFC-normalize every string in the tree.
 *
 * Separate from JCS canonicalization (JCS does not normalize Unicode). Apply BEFORE
 * serializing so signer and verifier operate on the same normalized strings. Fails
 * closed on an NFC key collision (two raw keys folding to one would silently drop a
 * field).
 */
export function nfcNormalize(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map((v) => nfcNormalize(v));
  if (value !== null && typeof value === "object") {
    // Null-prototype object so a `"__proto__"` (or other prototype) key is written as
    // a real OWN property instead of hitting the JS prototype setter. With a plain
    // `{}`, `result["__proto__"] = …` would be silently dropped and the payload would
    // canonicalize to `{}` — the kernel keeps the key (Python dicts have no such
    // setter), so Node would verify a payload the kernel rejects (prototype-pollution
    // parity gap).
    const result = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const nk = k.normalize("NFC");
      if (Object.prototype.hasOwnProperty.call(result, nk)) {
        throw new TrustContractError(`NFC key collision after normalization: ${JSON.stringify(nk)}`);
      }
      result[nk] = nfcNormalize(v);
    }
    return result;
  }
  return value;
}
