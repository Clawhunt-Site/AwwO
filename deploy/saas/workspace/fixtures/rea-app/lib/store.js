const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, 'notes.json');
const notes = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];

module.exports = {
  add(text) { notes.push({ text, at: Date.now(), file }); },
  all() { return notes.slice(); },
};
