# Pinned Unicode case-fold data

`17.0.0/CaseFolding.txt` is the unmodified Unicode 17.0.0 data file downloaded from
https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt on 2026-09-04.
Its SHA-256 is `ff8d8fefbf123574205085d6714c36149eb946d717a0c585c27f0f4ef58c4183`.
`LICENSE.txt` is the Unicode License V3 downloaded from https://www.unicode.org/license.txt.

Full default case folding uses C and F records; S and Turkic T records are excluded.
See [Unicode 17.0.0 section 3.13.3](https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-3/).
Unmapped code points retain their original value. The runtime has no external dependency
and does not download data or use locale-sensitive case conversion.

Reproduce or check the generated table offline:

```sh
node scripts/generate-unicode-casefold.mjs
node scripts/generate-unicode-casefold.mjs --check
node --test --experimental-test-isolation=none tests/unicode-casefold.test.js
```

`src/demo.js` applies JavaScript NFKC normalization, then calls the generated
`unicodeCaseFold` export. The canonical generated module and license are described
in [17.0.0/README.md](17.0.0/README.md). NFKC uses the browser/Node Unicode normalization version;
this package does not pin the host normalization tables. This operation is not
Unicode `NFKC_Casefold`: it retains default-ignorable characters and does not add a
second normalization pass. Trimming, query tokenization, and index visibility stay
with the caller.

When upgrading Unicode, review the source URL, source checksum, expected mapping
count, generated output and conformance fixture together. Never silently replace
the pinned source with the moving `latest` endpoint.
