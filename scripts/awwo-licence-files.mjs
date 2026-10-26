// What the scripts that fetch licences share (awwo-crate-licences.mjs, awwo-npm-licences.mjs,
// awwo-postgres-licences.mjs): fetching a file, the check of a folder of fetched files against its PROVENANCE.json, and
// whether a text is of the licence something names.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** A URL's bytes, through curl (which takes the person's proxy settings), in at most `seconds`; null when it could not
 *  be fetched. */
export function fetchBytes(url, seconds = 60) {
  const result = spawnSync('curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', String(seconds), url], { windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** What of a folder of fetched files disagrees with its PROVENANCE.json: a file it lists that is not there or holds
 *  other bytes, a file it does not list, a folder it has no entry for. */
export function provenanceDifferences(output) {
  const provenanceFile = path.join(output, 'PROVENANCE.json');
  const provenance = existsSync(provenanceFile) ? JSON.parse(readFileSync(provenanceFile, 'utf8')) : {};
  const differences = [];
  const folders = existsSync(output) ? readdirSync(output, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
  for (const folder of folders) {
    const listed = provenance[folder]?.files || {};
    if (!provenance[folder]) differences.push(`${folder}: no provenance`);
    for (const name of readdirSync(path.join(output, folder))) {
      if (!listed[name]) differences.push(`${folder}/${name}: not in the provenance`);
      else if (sha256(readFileSync(path.join(output, folder, name))) !== listed[name].sha256) differences.push(`${folder}/${name}: other bytes than fetched`);
    }
    for (const name of Object.keys(listed)) if (!existsSync(path.join(output, folder, name))) differences.push(`${folder}/${name}: missing`);
  }
  for (const folder of Object.keys(provenance)) if (!folders.includes(folder)) differences.push(`${folder}: missing`);
  return differences;
}

/** Words of each licence's own text, by SPDX identifier (the licences of what AwwO Local carries): of its body, so that
 *  a line naming the licence ("Licensed under the Apache License, Version 2.0") is not taken for its text. They are
 *  matched with the text's runs of white space as one space. */
export const LICENCE_TEXTS = Object.freeze({
  'MIT': /Permission is hereby granted, free of charge, to any person obtaining a copy/i,
  'ISC': /Permission to use, copy, modify, and\/?or distribute this software for any purpose/i,
  '0BSD': /Permission to use, copy, modify, and\/?or distribute this software for any purpose/i,
  'Apache-2.0': /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/i,
  'BSD-2-Clause': /Redistribution and use in source and binary forms, with or without modification, are permitted/i,
  // BSD-3 is BSD-2 with a clause that the names of its holders may not endorse a product.
  'BSD-3-Clause': /Redistribution and use in source and binary forms, with or without modification, are permitted.*\bnames? of .{0,200}?(endorse|promote)/i,
  'Unlicense': /This is free and unencumbered software released into the public domain/i,
  'Zlib': /This software is provided ['‘]as-is['’], without any express or implied warranty/i,
  'MPL-2.0': /Mozilla Public License,? Version 2\.0.*1\.1\. ["“]Contributor["”]/i,
  'Unicode-3.0': /UNICODE LICENSE V3.*Permission is hereby granted, free of charge, to any person obtaining a copy/i,
  'Unicode-DFS-2016': /UNICODE,? INC\.? LICENSE AGREEMENT.*Permission is hereby granted, free of charge, to any person obtaining a copy/i,
  'BlueOak-1.0.0': /This license gives everyone as much permission to work with this software as possible/i,
  'BSL-1.0': /Permission is hereby granted, free of charge, to any person or organization obtaining a copy/i,
  // MinGW-w64's runtime, which a program it builds has linked in: the notices of its parts, in one file.
  'LicenseRef-MinGW-w64-runtime': /MinGW-w64 runtime licensing.*statically linked against the MinGW-w64 runtime/i,
  // The notices of the code of others in PostgreSQL's source, as Debian's package of it lists them (debian/copyright).
  'LicenseRef-PostgreSQL-source-notices': /Upstream-Name: PostgreSQL.*Files: src\/backend\/regex\/.*src\/backend\/snowball\/libstemmer/i,
  // PostgreSQL's own licence, its source's COPYRIGHT (EDB's macOS archive carries no copy of it).
  'PostgreSQL': /PostgreSQL Database Management System.*Permission to use, copy, modify, and distribute this software and its documentation for any purpose, without fee, and without a written agreement is hereby granted/i,
  // MIT Kerberos: its NOTICE, MIT's BSD-style licence first, then the notices of every other part of it.
  'LicenseRef-MIT-krb5': /Copyright \(C\) 1985-\d{4} by the Massachusetts Institute of Technology.*Redistribution and use in source and binary forms, with or without modification, are permitted/i,
  'LGPL-2.1-or-later': /GNU LESSER GENERAL PUBLIC LICENSE Version 2\.1, February 1999/i,
});

/** An SPDX licence expression as a tree: { or: [...] }, { and: [...] }, or { id } (a WITH's exception kept beside it);
 *  AND binds tighter than OR, parentheses group, and crates' older "/" is OR. Null for one that does not parse. */
export function parseLicenceExpression(expression) {
  const tokens = String(expression || '').match(/\(|\)|\/|[^\s()/]+/g) || [];
  let at = 0;
  const word = value => String(tokens[at] || '').toUpperCase() === value;
  const any = () => {
    const parts = [all()];
    while (word('OR') || tokens[at] === '/') { at += 1; parts.push(all()); }
    return parts.length === 1 ? parts[0] : { or: parts };
  };
  const all = () => {
    const parts = [one()];
    while (word('AND')) { at += 1; parts.push(one()); }
    return parts.length === 1 ? parts[0] : { and: parts };
  };
  const one = () => {
    if (tokens[at] === '(') {
      at += 1;
      const inner = any();
      if (tokens[at] !== ')') throw new Error('unclosed');
      at += 1;
      return inner;
    }
    const id = tokens[at];
    if (!id || [')', '/'].includes(id) || ['OR', 'AND', 'WITH'].includes(id.toUpperCase())) throw new Error('no licence');
    at += 1;
    if (!word('WITH')) return { id };
    at += 1;
    if (!tokens[at] || ['(', ')', '/'].includes(tokens[at]) || ['OR', 'AND', 'WITH'].includes(tokens[at].toUpperCase())) throw new Error('no exception');
    return { id, exception: tokens[at++] };
  };
  try {
    const tree = any();
    return at === tokens.length ? tree : null;
  } catch {
    return null;
  }
}

/** Whether an SPDX expression holds when each licence it names holds as holds(id, exception) does (exception: the WITH
 *  of that licence, if any): a malformed or empty one never. */
export function licenceExpressionHolds(expression, holds) {
  const tree = parseLicenceExpression(expression);
  const check = node => node.or ? node.or.some(check) : node.and ? node.and.every(check) : holds(node.id, node.exception);
  return tree ? check(tree) : false;
}

/** Whether texts carry the licence an SPDX expression names: each licence the expression needs (all of an AND, one
 *  of an OR), and the exception a WITH adds to it, has its words in some text. A licence or exception with no words
 *  known here is never found. */
export function licenceTextMatches(expression, texts) {
  // A licence kept in a source file's comment has a marker at each line's start (" * ", "// ", "# "): it goes first.
  const flat = texts.map(text => String(text).replace(/^[ \t]*(\/\*+|\*+\/?|\/\/+|#+)[ \t]?/gm, '').replace(/\s+/g, ' '));
  const found = id => Boolean(LICENCE_TEXTS[id]) && flat.some(text => LICENCE_TEXTS[id].test(text));
  return licenceExpressionHolds(expression, (id, exception) => found(id) && (!exception || found(exception)));
}
