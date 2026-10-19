// A workspace tool call that failed with the workspace as it was: a wrong path, a missing file, a file or a listing too
// large. The pinned core refuses a turn's final answer once any tool result was an error ("One or more tool operations
// failed or were denied", openai-chat.ts at UPSTREAM_REVISION), so a task whose model had recovered from such a slip
// lost its answer and its work (2026-10-18). Such a failure goes back as an ordinary result that says plainly that the
// call did nothing, with a fixed code and sentence: nothing the sandbox printed (a file name the model made, a path)
// is passed on. Everything else stays an error: a file that fails its checks, a sandbox that closed, a response that
// cannot be read, and anything this list does not know.
import { WorkerError } from './protocol.ts';

export class ToolFailure extends Error {
  readonly code: string;
  readonly sentence: string;
  constructor(code: string, sentence: string) { super(code); this.code = code; this.sentence = sentence; }
}

const PATH = 'The path must be relative to the workspace, without .. or control characters.';
const READ_ONLY = 'Files under inputs/ are read only.';
const TOO_LARGE = 'The file or the workspace is larger than a tool may read, write, publish or archive.';

/** The sandbox's own refusals before it runs anything (workspace-sandbox.ts). */
const SANDBOX: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^Workspace paths must be relative, without traversal or control characters$/, 'INVALID_PATH', PATH],
  [/^Inputs are read only$/, 'READ_ONLY', READ_ONLY],
  [/^Workspace file exceeds size limit$/, 'TOO_LARGE', TOO_LARGE],
];

/** The workspace helper's refusals, by the last line it printed: the exception's type and message. */
const HELPER: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^FileNotFoundError: /, 'NOT_FOUND', 'No such file or directory.'],
  [/^NotADirectoryError: /, 'NOT_A_DIRECTORY', 'A part of the path is not a directory.'],
  [/^IsADirectoryError: /, 'NOT_A_FILE', 'The path is a directory, not a file.'],
  [/^OSError: \[Errno 40\] /, 'NOT_A_FILE', 'The path is a symbolic link, which workspace tools do not follow.'],
  [/^PermissionError: /, 'PERMISSION_DENIED', 'The workspace does not allow that.'],
  [/^ValueError: (Only regular files can be read|Hard linked files cannot be published|Target is not an ordinary file)$/, 'NOT_A_FILE', 'Only ordinary files can be read, written or published.'],
  [/^ValueError: (Workspace file exceeds size limit|Workspace exceeds snapshot size limit|Workspace archive exceeds size limit)$/, 'TOO_LARGE', TOO_LARGE],
  [/^ValueError: (Directory has too many entries|Workspace has too many entries)$/, 'TOO_MANY_ENTRIES', 'The directory or the workspace has more than 1,024 entries.'],
  [/^ValueError: Workspace contains a symlink or special file: /, 'ARCHIVE_BLOCKED', 'The workspace holds a symbolic link or special file, so it cannot be archived as it is.'],
  [/^ValueError: Invalid workspace path$/, 'INVALID_PATH', PATH],
  [/^ValueError: Inputs are read only$/, 'READ_ONLY', READ_ONLY],
];

/** The failure a model can correct or report, or null for one that must stay an error. */
export function recoverableFailure(error: unknown): ToolFailure | null {
  if (error instanceof ToolFailure) return error;
  if (!(error instanceof Error) || error instanceof WorkerError) return null;
  for (const [pattern, code, sentence] of SANDBOX) if (pattern.test(error.message)) return new ToolFailure(code, sentence);
  // A helper that exited with an error leaves the sandbox open; one whose response could not be read closed it.
  const helper = /^Workspace (?:list|read|write|publish|archive) failed: ([\s\S]*)$/.exec(error.message);
  const last = helper?.[1].trim().split('\n').at(-1)?.trim();
  if (!last) return null;
  for (const [pattern, code, sentence] of HELPER) if (pattern.test(last)) return new ToolFailure(code, sentence);
  return null;
}

/** What the model is given for a recoverable failure of tool `name`: an ordinary result that did nothing. */
export function failedResult(name: string, failure: ToolFailure): Record<string, unknown> {
  return { failed: true, error: failure.code, message: `${name} did nothing: ${failure.sentence}`, ...(name === 'publish' || name === 'archive' ? { published: false } : {}) };
}
