const path = require('node:path');

function formatNote(note) {
  return `[${new Date(note.at).toISOString()}] ${note.text} (${path.basename(note.file)})`;
}

module.exports = { formatNote };
