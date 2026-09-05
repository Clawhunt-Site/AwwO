# Unicode default full case folding

`CaseFolding.txt` is the unmodified Unicode 17.0.0 database file downloaded from
https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt.

- SHA-256: `ff8d8fefbf123574205085d6714c36149eb946d717a0c585c27f0f4ef58c4183`
- Source header date: 2025-07-30, 23:54:36 GMT
- Retrieved: 2026-09-04
- License: Unicode License V3, included in `LICENSE.txt` from https://www.unicode.org/license.txt
- Specification: Unicode 17.0.0, section 3.13.3 (Default Case Folding),
  https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-3/

The generator uses every C (common) and F (full) mapping. It excludes S (simple
alternatives) and T (Turkic locale tailoring). Unlisted code points map to
themselves. The source hash and version are checked before generation.

From the project root:

```sh
node scripts/generate-unicode-casefold.mjs
node scripts/generate-unicode-casefold.mjs --check
node --test --experimental-test-isolation=none tests/unicode-casefold.test.js
```

Both generation and testing work offline with the vendored source. The browser
only imports the generated `src/unicode-casefold.js`, which has no fetches,
runtime dependencies, or locale-sensitive casing calls. Keep the Unicode license
with the generated module when redistributing it.

`unicodeCaseFold(value)` performs case folding only. The AWW-15 search integration
should preserve its existing NFKC preprocessing:

```js
import { unicodeCaseFold } from './unicode-casefold.js';
const normalize = value => unicodeCaseFold(String(value ?? '').normalize('NFKC'));
```

Default folding may produce decomposed sequences and does not promise a normalized
result. NFKC followed by case folding is not the Unicode `NFKC_Casefold` identifier
operation, which also handles default-ignorable characters. NFKC itself continues
to use the host JavaScript engine's Unicode data; only case folding is pinned to
17.0.0 here. Do not change this composition without confirming the search contract.
