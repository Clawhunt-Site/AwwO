// Fixture app for the image's `rea analyze-javascript-application` smoke test: an entry point wired to two modules.
const { formatNote } = require('./lib/format');
const store = require('./lib/store');

store.add('Buy milk');
store.add('Ship the release');
for (const note of store.all()) console.log(formatNote(note));
