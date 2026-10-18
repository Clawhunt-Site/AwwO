// awwo-check-page's --missing-ok patterns: which missing local files a check lists instead of counting as errors.
// A pattern names paths relative to the page: * is any run of characters but '/', ? one character but '/', ** any run
// at all, and **/ any directories or none (so **/*.glb matches model.glb too). A leading ./ is dropped.

export const MAX_PATTERNS = 20;
export const MAX_PATTERN_LENGTH = 200;
// A longer path is never allowed missing (it is counted as before): the match costs pattern length x path length.
export const MAX_PATH_LENGTH = 2048;
// The kinds of request a missing file may be excused for: data a page fetches, pictures, sound and video, fonts and
// text tracks. A missing script, stylesheet, document or worker always counts: it is missing code. So does a file named
// like code, however it was asked for (a page may fetch its WebAssembly or a module's text as data).
export const EXCUSABLE_TYPES = new Set(['fetch', 'xhr', 'image', 'media', 'font', 'texttrack']);
const CODE_PATH = /\.(?:[cm]?js|wasm|css|x?html?)$/i;

/** Whether a missing file of this request type and page-relative path may be excused at all. */
export function excusable(type, path) {
  return EXCUSABLE_TYPES.has(type) && typeof path === 'string' && path.length <= MAX_PATH_LENGTH && !CODE_PATH.test(path);
}

/** The pattern to match with, or an Error saying why the option is refused. */
export function parseMissingOk(glob) {
  const raw = String(glob ?? ''), pattern = raw.replace(/^(?:\.\/)+/, '');
  if (!pattern || raw.length > MAX_PATTERN_LENGTH || pattern.startsWith('/') || pattern.split('/').some(part => part === '..' || part === '.')
    || /[\x00-\x1f\x7f\\]/.test(pattern)) {
    return new Error(`--missing-ok takes a path pattern relative to the page (*, ** and ?), at most ${MAX_PATTERN_LENGTH} characters`);
  }
  return pattern;
}

/** A test for one pattern. It runs by dynamic programming over the pattern's tokens and the path's characters (at most
 * their product in steps), where a regular expression of the same pattern can backtrack for minutes on a long path. */
export function globMatcher(pattern) {
  const tokens = pattern.match(/\*\*\/|\*\*|\*|\?|[^*?]/g) ?? [];
  return path => {
    if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH) return false;
    let row = new Uint8Array(path.length + 1);
    row[0] = 1;
    for (const token of tokens) {
      // next[j]: the tokens so far match path.slice(0, j); before: some row[k] with k < j holds.
      const next = new Uint8Array(path.length + 1);
      let before = 0;
      for (let j = 0; j <= path.length; j += 1) {
        const c = path[j - 1];
        if (token === '*') next[j] = row[j] || (j > 0 && next[j - 1] && c !== '/') ? 1 : 0;
        else if (token === '**') next[j] = row[j] || (j > 0 && next[j - 1]) ? 1 : 0;
        else if (token === '**/') next[j] = row[j] || (j > 0 && c === '/' && before) ? 1 : 0;
        else if (token === '?') next[j] = j > 0 && row[j - 1] && c !== '/' ? 1 : 0;
        else next[j] = j > 0 && row[j - 1] && c === token ? 1 : 0;
        before ||= row[j];
      }
      row = next;
    }
    return row[path.length] === 1;
  };
}
