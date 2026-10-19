import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WORKSPACE_FILE_HELPER, validateWorkspacePath } from '../openai-agents-worker/workspace-sandbox.ts';
import { WorkerError } from './protocol.ts';
import { ToolFailure, failedResult, recoverableFailure } from './tool-failures.ts';

// How a helper's refusal reaches the broker: its traceback's last lines after the action (workspace-sandbox.ts invoke).
const helper = (action: string, last: string) => new Error(`Workspace ${action} failed: Traceback (most recent call last):\n  File "<string>", line 180, in <module>\n  File "<string>", line 44, in file_bytes\n${last}\n`);

test('a slip the workspace survived is named by a fixed code and sentence, never by what the sandbox printed', () => {
  let pathError: unknown;
  try { validateWorkspacePath('/workspace/index.html'); } catch (error) { pathError = error; }
  const cases: Array<[unknown, string]> = [
    [pathError, 'INVALID_PATH'],
    [new Error('Inputs are read only'), 'READ_ONLY'],
    [new Error('Workspace file exceeds size limit'), 'TOO_LARGE'],
    [helper('read', "FileNotFoundError: [Errno 2] No such file or directory: 'draft-secret.html'"), 'NOT_FOUND'],
    [helper('list', "NotADirectoryError: [Errno 20] Not a directory: 'index.html'"), 'NOT_A_DIRECTORY'],
    [helper('read', "OSError: [Errno 40] Too many levels of symbolic links: 'link'"), 'NOT_A_FILE'],
    [helper('read', 'ValueError: Only regular files can be read'), 'NOT_A_FILE'],
    [helper('publish', 'ValueError: Hard linked files cannot be published'), 'NOT_A_FILE'],
    [helper('write', 'ValueError: Target is not an ordinary file'), 'NOT_A_FILE'],
    [helper('read', 'ValueError: Workspace file exceeds size limit'), 'TOO_LARGE'],
    [helper('archive', 'ValueError: Workspace archive exceeds size limit'), 'TOO_LARGE'],
    [helper('archive', 'ValueError: Workspace exceeds snapshot size limit'), 'TOO_LARGE'],
    [helper('list', 'ValueError: Directory has too many entries'), 'TOO_MANY_ENTRIES'],
    [helper('archive', 'ValueError: Workspace has too many entries'), 'TOO_MANY_ENTRIES'],
    [helper('archive', 'ValueError: Workspace contains a symlink or special file: venv/bin/python'), 'ARCHIVE_BLOCKED'],
    [helper('write', 'ValueError: Inputs are read only'), 'READ_ONLY'],
    [helper('write', "PermissionError: [Errno 13] Permission denied: 'x'"), 'PERMISSION_DENIED'],
  ];
  for (const [error, code] of cases) {
    const failure = recoverableFailure(error);
    assert.equal(failure?.code, code, String(error));
    const result = JSON.stringify(failedResult('read', failure!));
    assert.ok(!/draft-secret|venv\/bin|index\.html|'link'|Errno|Traceback|<string>/.test(result), result);
  }
  // A publish or an archive that did nothing says it delivered nothing; a read says only that it did nothing.
  assert.deepEqual(failedResult('publish', new ToolFailure('NOT_FOUND', 'No such file or directory.')),
    { failed: true, error: 'NOT_FOUND', message: 'publish did nothing: No such file or directory.', published: false });
  assert.equal(failedResult('archive', new ToolFailure('TOO_LARGE', 'x')).published, false);
  assert.equal('published' in failedResult('read', new ToolFailure('NOT_FOUND', 'x')), false);
});

test('a failure the workspace may not have survived, or one the list does not know, stays an error', () => {
  for (const error of [
    new Error('Workspace sandbox is closed'), new Error('Invalid workspace helper response'), new Error('Invalid workspace file response'),
    new Error('Workspace file verification failed'), new Error('Workspace command failed or timed out'), new Error('Invalid workspace directory response'),
    new WorkerError('ARTIFACT_INVALID'), new WorkerError('INVALID_REQUEST'), new WorkerError('TOOL_NOT_ALLOWED'),
    helper('read', 'RuntimeError: something new'), helper('exec', 'FileNotFoundError: [Errno 2] No such file'),
    helper('restore', 'ValueError: Archive has too many entries'), new Error('Workspace read failed: '), 'a string', undefined,
  ]) assert.equal(recoverableFailure(error), null, String(error));
});

test('every refusal the list names is one the sandbox and its helper really make', async () => {
  const sandbox = await readFile(new URL('../openai-agents-worker/workspace-sandbox.ts', import.meta.url), 'utf8');
  for (const message of ['Inputs are read only', 'Workspace file exceeds size limit', 'Workspace paths must be relative, without traversal or control characters'])
    assert.ok(sandbox.includes(`throw new Error('${message}')`), message);
  for (const message of ['Only regular files can be read', 'Hard linked files cannot be published', 'Target is not an ordinary file',
    'Workspace file exceeds size limit', 'Workspace exceeds snapshot size limit', 'Workspace archive exceeds size limit',
    'Directory has too many entries', 'Workspace has too many entries', 'Workspace contains a symlink or special file: ',
    'Invalid workspace path', 'Inputs are read only'])
    assert.ok(WORKSPACE_FILE_HELPER.includes(`raise ValueError('${message}`), message);
  // The helper's refusals reach the broker in this form, and a helper exit leaves the sandbox open.
  assert.ok(sandbox.includes('if (result.code !== 0) throw new Error(`Workspace ${action} failed: ${result.stderr.toString(\'utf8\').slice(-2048)}`);'));
});
