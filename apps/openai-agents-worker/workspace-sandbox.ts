import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';

export interface WorkspaceSandboxConfig {
  dockerExecutable: string;
  image: string;
  dockerContext?: string;
  commandTimeoutMs?: number;
  maxFileBytes?: number;
  maxArchiveBytes?: number;
}
export interface WorkspaceInput {
  path?: string;
  name?: string;
  content: string;
  encoding?: 'utf8' | 'base64';
  sha256?: string;
}
export interface WorkspaceSnapshot {
  content: string;
  encoding: 'base64';
  sha256: string;
}
export interface WorkspaceFile extends WorkspaceSnapshot {
  path: string;
  name: string;
  byteLength: number;
  mimeType: string;
}
export interface WorkspaceRead extends Omit<WorkspaceFile, 'encoding'> { encoding: 'utf8' | 'base64' }
export interface WorkspaceEntry { path: string; type: 'file' | 'directory'; byteLength: number }
export interface WorkspaceExecResult { exitCode: number; stdout: string; stderr: string; truncated: boolean }
export interface WorkspaceSandbox {
  list(path?: string): Promise<WorkspaceEntry[]>;
  read(path: string): Promise<WorkspaceRead>;
  write(path: string, content: string, encoding?: 'utf8' | 'base64'): Promise<WorkspaceRead>;
  exec(command: string, options?: { timeoutMs?: number }): Promise<WorkspaceExecResult>;
  publish(path: string): Promise<WorkspaceRead>;
  archive(): Promise<WorkspaceFile>;
  close(): Promise<void>;
}

const MiB = 1024 * 1024;
const FILE_LIMIT = 2 * MiB;
const ARCHIVE_LIMIT = 2 * MiB;
const INPUT_LIMIT = 8 * MiB;
const ENTRY_LIMIT = 1024;
const COMMAND_OUTPUT_LIMIT = 64 * 1024;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function validateWorkspacePath(value: string, allowRoot = false): string {
  if (allowRoot && (value === '' || value === '.')) return '';
  if (typeof value !== 'string' || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) {
    throw new Error('Workspace paths must be relative, without traversal or control characters');
  }
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('Invalid workspace limit');
  return value;
}

function decodeContent(content: string, encoding: 'utf8' | 'base64', limit: number): Buffer {
  if (typeof content !== 'string' || content.length > limit * 2) throw new Error('Workspace file exceeds size limit');
  const bytes = Buffer.from(content, encoding);
  if (bytes.length > limit) throw new Error('Workspace file exceeds size limit');
  if (encoding === 'base64' && bytes.toString('base64') !== content) throw new Error('Invalid base64 workspace file');
  return bytes;
}

function mimeType(path: string): string {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  return ({ html: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/plain', tsx: 'text/plain',
    json: 'application/json', md: 'text/markdown', txt: 'text/plain', py: 'text/plain', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf',
    glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain', stl: 'model/stl', zip: 'application/zip',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

interface DockerResult { code: number; stdout: Buffer; stderr: Buffer }
interface DockerOptions { input?: string; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }
export type WorkspaceDockerRunner = (args: string[], options: DockerOptions) => Promise<DockerResult>;

function dockerRunner(config: WorkspaceSandboxConfig): WorkspaceDockerRunner {
  return (args, { input, timeoutMs, maxOutputBytes, signal }) => new Promise((resolve, reject) => {
    // The CLI is trusted. No shell, model-supplied environment, Docker endpoint or host mount enters this call.
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/local/bin', LANG: 'C.UTF-8' };
    if (process.env.HOME) env.HOME = process.env.HOME;
    const child = spawn(config.dockerExecutable, [...(config.dockerContext ? ['--context', config.dockerContext] : []), ...args],
      { stdio: ['pipe', 'pipe', 'pipe'], env, shell: false });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
    const onAbort = () => stop(new Error('Workspace operation cancelled'));
    const timer = setTimeout(() => stop(new Error('Workspace operation timed out')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { stop(new Error('Workspace command output exceeds limit')); return; }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error); });
    child.on('error', error => { failure ??= error; });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin.end(input ?? '');
  });
}

// Python is invoked with -I -S and an immutable image: workspace modules and site customizations cannot shadow it.
// All filesystem access walks directory descriptors with O_NOFOLLOW, including restored archive entries.
export const WORKSPACE_FILE_HELPER = String.raw`
import os, sys, json, stat, base64, hashlib, io, zipfile
WORKSPACE = '/workspace'
INPUTS = '/inputs'
SKIP = {'.git', 'node_modules', '__pycache__', '.venv', '.pytest_cache', '.mypy_cache', 'inputs'}
payload = json.load(sys.stdin)
FILE_LIMIT = payload['fileLimit']
ARCHIVE_LIMIT = payload['archiveLimit']
TOTAL_LIMIT = 33554432
ENTRY_LIMIT = 1024

def parts(path, root=False):
    if root and path in ('', '.'): return []
    result = path.split('/')
    if len(path) > 1024 or any(not p or p in ('.', '..') or len(p.encode()) > 255 for p in result) or any(ord(c) < 32 or ord(c) == 127 or c == '\\' for c in path):
        raise ValueError('Invalid workspace path')
    return result

def parent(path, write=False, root=False):
    components = parts(path, root)
    source = WORKSPACE
    if components and components[0] == 'inputs':
        if write: raise ValueError('Inputs are read only')
        source = INPUTS
        components = components[1:]
    fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in components[:-1]:
            if write:
                try: os.mkdir(component, mode=0o700, dir_fd=fd)
                except FileExistsError: pass
            nxt = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd, components[-1] if components else ''
    except:
        os.close(fd)
        raise

def file_bytes(path):
    fd, name = parent(path)
    try: f = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    finally: os.close(fd)
    try:
        info = os.fstat(f)
        if not stat.S_ISREG(info.st_mode): raise ValueError('Only regular files can be read')
        if info.st_nlink != 1: raise ValueError('Hard linked files cannot be published')
        if info.st_size > FILE_LIMIT: raise ValueError('Workspace file exceeds size limit')
        with os.fdopen(f, 'rb', closefd=False) as stream: data = stream.read(FILE_LIMIT + 1)
        if len(data) > FILE_LIMIT: raise ValueError('Workspace file exceeds size limit')
        return data
    finally: os.close(f)

def write_bytes(path, data):
    if len(data) > FILE_LIMIT: raise ValueError('Workspace file exceeds size limit')
    fd, name = parent(path, write=True)
    temp = '.awwo-write-' + os.urandom(12).hex()
    try:
        try:
            previous = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(previous.st_mode) or previous.st_nlink != 1: raise ValueError('Target is not an ordinary file')
        except FileNotFoundError: pass
        f = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(f, 'wb') as stream: stream.write(data)
        os.rename(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
    finally:
        try: os.unlink(temp, dir_fd=fd)
        except FileNotFoundError: pass
        os.close(fd)

def file_result(path, data):
    return {'path': path, 'content': base64.b64encode(data).decode(), 'encoding': 'base64', 'byteLength': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

def walk(fd, prefix='', result=None):
    if result is None: result = []
    for name in sorted(os.listdir(fd)):
        if name in SKIP: continue
        path = prefix + name
        parts(path)
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise ValueError('Workspace contains a symlink or special file: ' + path)
        if len(result) >= ENTRY_LIMIT: raise ValueError('Workspace has too many entries')
        result.append((path, stat.S_ISDIR(info.st_mode)))
        if stat.S_ISDIR(info.st_mode):
            sub = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try: walk(sub, path + '/', result)
            finally: os.close(sub)
    return result

action = payload['action']
if action == 'inputs':
    # Called only before any model command, as root. The model runs as uid 1000.
    for entry in payload['inputs']:
        components = parts(entry['path'])
        fd = os.open(INPUTS, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for name in components[:-1]:
                try: os.mkdir(name, 0o755, dir_fd=fd)
                except FileExistsError: pass
                nxt = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = nxt
            f = os.open(components[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444, dir_fd=fd)
            with os.fdopen(f, 'wb') as stream: stream.write(base64.b64decode(entry['content'], validate=True))
        finally: os.close(fd)
    result = {'ok': True}
elif action == 'list':
    fd, name = parent(payload['path'], root=True)
    if name:
        try: sub = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        finally: os.close(fd)
        fd = sub
    try:
        names = sorted(os.listdir(fd))
        if len(names) > ENTRY_LIMIT: raise ValueError('Directory has too many entries')
        result = []
        for item in names:
            parts(item)
            info = os.stat(item, dir_fd=fd, follow_symlinks=False)
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)): continue
            result.append({'path': (payload['path'].rstrip('/') + '/' if payload['path'] else '') + item, 'type': 'directory' if stat.S_ISDIR(info.st_mode) else 'file', 'byteLength': info.st_size if stat.S_ISREG(info.st_mode) else 0})
        if not payload['path']: result.append({'path': 'inputs', 'type': 'directory', 'byteLength': 0})
    finally: os.close(fd)
elif action in ('read', 'publish'):
    result = file_result(payload['path'], file_bytes(payload['path']))
elif action == 'write':
    data = base64.b64decode(payload['content'], validate=True)
    write_bytes(payload['path'], data)
    result = file_result(payload['path'], data)
elif action == 'archive':
    fd = os.open(WORKSPACE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: entries = walk(fd)
    finally: os.close(fd)
    output = io.BytesIO()
    total = 0
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path, directory in entries:
            if directory: continue
            data = file_bytes(path)
            total += len(data)
            if total > TOTAL_LIMIT: raise ValueError('Workspace exceeds snapshot size limit')
            info = zipfile.ZipInfo(path, date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
            if output.tell() > ARCHIVE_LIMIT: raise ValueError('Workspace archive exceeds size limit')
    if output.tell() > ARCHIVE_LIMIT: raise ValueError('Workspace archive exceeds size limit')
    result = file_result('workspace.zip', output.getvalue())
elif action == 'restore':
    data = base64.b64decode(payload['content'], validate=True)
    if len(data) > ARCHIVE_LIMIT: raise ValueError('Workspace archive exceeds size limit')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > ENTRY_LIMIT: raise ValueError('Archive has too many entries')
        seen = set()
        total = 0
        for info in entries:
            path = info.filename.rstrip('/') if info.is_dir() else info.filename
            components = parts(path)
            mode = stat.S_IFMT(info.external_attr >> 16)
            if path in seen or any(p in SKIP for p in components) or mode not in (0, stat.S_IFREG, stat.S_IFDIR) or info.flag_bits & 1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError('Unsupported or unsafe archive entry')
            seen.add(path)
            total += info.file_size
            if info.file_size > FILE_LIMIT or total > TOTAL_LIMIT: raise ValueError('Archive expands beyond size limit')
        for info in entries:
            if info.is_dir(): continue
            with archive.open(info) as stream: entry = stream.read(FILE_LIMIT + 1)
            if len(entry) != info.file_size or len(entry) > FILE_LIMIT: raise ValueError('Invalid archive size')
            write_bytes(info.filename, entry)
    result = {'ok': True}
else: raise ValueError('Unknown workspace operation')
print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))
`;

// Timeout is enforced again by the parent, which removes the entire container. Shell exit alone is not cancellation.
const COMMAND_HELPER = String.raw`
import os, sys, json, subprocess, selectors, signal, time
payload = json.load(sys.stdin)
limit = 65536
chunks = {'stdout': bytearray(), 'stderr': bytearray()}
truncated = False
process = subprocess.Popen(['/bin/sh', '-lc', payload['command']], cwd='/workspace', stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/workspace','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'})
selector = selectors.DefaultSelector()
selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
deadline = time.monotonic() + payload['timeoutMs'] / 1000
try:
    while selector.get_map():
        if time.monotonic() >= deadline: raise TimeoutError('Workspace command timed out')
        for key, event in selector.select(0.1):
            data = os.read(key.fileobj.fileno(), 8192)
            if not data:
                selector.unregister(key.fileobj)
                continue
            remaining = limit - sum(len(value) for value in chunks.values())
            if len(data) > remaining: truncated = True
            chunks[key.data].extend(data[:max(0, remaining)])
    exit_code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
finally:
    try: os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    # Reap escaped/background children as well; this container serves only one serialized command at a time.
    for item in os.listdir('/proc'):
        if not item.isdigit() or int(item) in (1, os.getpid()): continue
        try:
            if os.stat('/proc/' + item).st_uid == os.getuid(): os.kill(int(item), signal.SIGKILL)
        except (ProcessLookupError, FileNotFoundError, PermissionError): pass
    selector.close()
print(json.dumps({'exitCode': exit_code, 'stdout': bytes(chunks['stdout']).decode('utf-8', errors='replace'), 'stderr': bytes(chunks['stderr']).decode('utf-8', errors='replace'), 'truncated': truncated}))
`;

export function workspaceDockerArgs(name: string, image: string): string[] {
  return ['run', '--detach', '--pull=never', '--name', name, '--label', 'awwo.workspace-sandbox=true',
    '--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--memory=1g', '--memory-swap=1g', '--cpus=1', '--pids-limit=128', '--ulimit=nofile=1024:1024',
    '--tmpfs', '/workspace:rw,nosuid,nodev,size=134217728,nr_inodes=8192,uid=1000,gid=1000,mode=0700',
    '--tmpfs', '/inputs:rw,nosuid,nodev,noexec,size=8388608,nr_inodes=2048,uid=0,gid=0,mode=0755',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=33554432,nr_inodes=2048,uid=1000,gid=1000,mode=0700',
    '--workdir=/workspace', '--env', 'HOME=/workspace', '--env', 'PYTHONDONTWRITEBYTECODE=1',
    '--entrypoint=python3', image, '-I', '-S', '-c',
    'import signal,time,os; signal.signal(signal.SIGCHLD, signal.SIG_IGN); time.sleep(86400)'];
}

export async function createWorkspaceSandbox(config: WorkspaceSandboxConfig,
  options: { workspaceId: string; runId: string; inputs?: WorkspaceInput[]; snapshot?: WorkspaceSnapshot },
  signal?: AbortSignal, runDocker: WorkspaceDockerRunner = dockerRunner(config)): Promise<WorkspaceSandbox> {
  if (!isAbsolute(config.dockerExecutable) || /[\x00-\x1f]/.test(config.dockerExecutable)) throw new Error('Docker executable must be an absolute trusted path');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,254}$/.test(config.image)) throw new Error('Invalid workspace image');
  if (config.dockerContext && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(config.dockerContext)) throw new Error('Invalid Docker context');
  for (const value of [options.workspaceId, options.runId]) if (typeof value !== 'string' || !value || value.length > 256) throw new Error('Invalid workspace identity');
  const fileLimit = boundedInteger(config.maxFileBytes, FILE_LIMIT, FILE_LIMIT);
  const archiveLimit = boundedInteger(config.maxArchiveBytes, ARCHIVE_LIMIT, ARCHIVE_LIMIT);
  const timeoutMs = boundedInteger(config.commandTimeoutMs, 30_000, 120_000);
  if (signal?.aborted) throw new Error('Workspace operation cancelled');
  const name = `awwo-ws-${sha256(Buffer.from(options.workspaceId + '\0' + options.runId)).slice(0,24)}-${randomBytes(6).toString('hex')}`;
  const inputs: { path: string; content: string }[] = [];
  const seen = new Set<string>();
  let inputBytes = 0;
  for (const input of options.inputs ?? []) {
    if (inputs.length >= ENTRY_LIMIT) throw new Error('Too many workspace inputs');
    const path = validateWorkspacePath((input.path ?? input.name ?? '').replace(/^inputs\//, ''));
    if (seen.has(path)) throw new Error('Duplicate workspace input');
    seen.add(path);
    const bytes = decodeContent(input.content, input.encoding ?? 'utf8', fileLimit);
    if (input.sha256 && sha256(bytes) !== input.sha256) throw new Error('Workspace input checksum mismatch');
    inputBytes += bytes.length;
    if (inputBytes > INPUT_LIMIT) throw new Error('Workspace inputs exceed total size limit');
    inputs.push({ path, content: bytes.toString('base64') });
  }
  if (options.snapshot) {
    if (options.snapshot.encoding !== 'base64') throw new Error('Workspace snapshot must be base64');
    const bytes = decodeContent(options.snapshot.content, 'base64', archiveLimit);
    if (sha256(bytes) !== options.snapshot.sha256) throw new Error('Workspace snapshot checksum mismatch');
  }
  let closed = false, created = false, closing: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    closing = (async () => {
      if (!created) return;
      const result = await runDocker(['rm', '--force', name], { timeoutMs: 10_000, maxOutputBytes: 16_384 });
      if (result.code !== 0 && !/No such container/.test(result.stderr.toString())) throw new Error('Unable to remove workspace sandbox');
    })();
    return closing;
  };
  const onAbort = () => { void close().catch(() => { /* The active operation also awaits cleanup and reports failure. */ }); };
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(async () => {
      if (closed || signal?.aborted) throw new Error('Workspace sandbox is closed');
      return operation();
    });
    queue = result.catch(() => undefined);
    return result;
  };
  const invoke = async (action: string, payload: Record<string, unknown> = {}, user = '1000:1000'): Promise<unknown> => {
    let result: DockerResult;
    try {
      result = await runDocker(['exec', '--interactive', '--user', user, name, 'python3', '-I', '-S', '-c', WORKSPACE_FILE_HELPER],
        { input: JSON.stringify({ action, fileLimit, archiveLimit, ...payload }), timeoutMs: 15_000,
          maxOutputBytes: Math.max(fileLimit, archiveLimit) * 2 + 16_384, signal });
    } catch (error) { await close(); throw error; }
    if (result.code !== 0) throw new Error(`Workspace ${action} failed: ${result.stderr.toString('utf8').slice(-2048)}`);
    try { return JSON.parse(result.stdout.toString('utf8')); }
    catch { await close(); throw new Error('Invalid workspace helper response'); }
  };
  const verified = (value: unknown, path: string, limit: number, binary = false): WorkspaceRead => {
    if (!isRecord(value) || value.path !== path || value.encoding !== 'base64' || typeof value.sha256 !== 'string' || typeof value.content !== 'string') throw new Error('Invalid workspace file response');
    const bytes = decodeContent(value.content, 'base64', limit);
    if (value.byteLength !== bytes.length || value.sha256 !== sha256(bytes)) throw new Error('Workspace file verification failed');
    let encoding: 'utf8' | 'base64' = 'base64', content = value.content;
    if (!binary) {
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); encoding = 'utf8'; } catch { /* Binary files retain base64. */ }
    }
    return { path, name: path.split('/').at(-1)!, content, encoding, byteLength: bytes.length, sha256: value.sha256, mimeType: mimeType(path) };
  };
  try {
    // Set before run: a client timeout may occur after the daemon has already created the container.
    created = true;
    const start = await runDocker(workspaceDockerArgs(name, config.image), { timeoutMs: 20_000, maxOutputBytes: 16_384, signal });
    if (start.code !== 0) throw new Error(`Workspace sandbox could not start: ${start.stderr.toString('utf8').slice(-1024)}`);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) throw new Error('Workspace operation cancelled');
    if (inputs.length) await invoke('inputs', { inputs }, '0:0');
    if (options.snapshot) await invoke('restore', { content: options.snapshot.content });
  } catch (error) { await close(); throw error; }

  return {
    list: (path = '') => serialized(async () => {
      const value = await invoke('list', { path: validateWorkspacePath(path, true) });
      if (!Array.isArray(value) || value.length > ENTRY_LIMIT + 1) throw new Error('Invalid workspace directory response');
      return value.map((entry: unknown): WorkspaceEntry => {
        if (!isRecord(entry) || typeof entry.path !== 'string' || (entry.type !== 'file' && entry.type !== 'directory')
          || typeof entry.byteLength !== 'number' || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) throw new Error('Invalid workspace directory entry');
        return { path: validateWorkspacePath(entry.path), type: entry.type, byteLength: entry.byteLength };
      });
    }),
    read: path => serialized(async () => verified(await invoke('read', { path: validateWorkspacePath(path) }), path, fileLimit)),
    write: (path, content, encoding = 'utf8') => serialized(async () => {
      validateWorkspacePath(path);
      if (path === 'inputs' || path.startsWith('inputs/')) throw new Error('Inputs are read only');
      const bytes = decodeContent(content, encoding, fileLimit);
      return verified(await invoke('write', { path, content: bytes.toString('base64') }), path, fileLimit);
    }),
    exec: (command, commandOptions = {}) => serialized(async () => {
      if (typeof command !== 'string' || !command.trim() || command.length > 32_768 || command.includes('\0')) throw new Error('Invalid workspace command');
      const commandTimeout = boundedInteger(commandOptions.timeoutMs, timeoutMs, timeoutMs);
      let result: DockerResult;
      try {
        result = await runDocker(['exec', '--interactive', '--user', '1000:1000', name, 'python3', '-I', '-S', '-c', COMMAND_HELPER],
          { input: JSON.stringify({ command, timeoutMs: commandTimeout }), timeoutMs: commandTimeout + 2000,
            maxOutputBytes: COMMAND_OUTPUT_LIMIT * 6 + 4096, signal });
        if (result.code !== 0) throw new Error('Workspace command failed or timed out');
        const value: unknown = JSON.parse(result.stdout.toString('utf8'));
        if (!isRecord(value) || typeof value.exitCode !== 'number' || !Number.isInteger(value.exitCode) || typeof value.stdout !== 'string' || typeof value.stderr !== 'string' || typeof value.truncated !== 'boolean') throw new Error('Invalid workspace command response');
        return { exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr, truncated: value.truncated };
      } catch (error) { await close(); throw error; }
    }),
    publish: path => serialized(async () => verified(await invoke('publish', { path: validateWorkspacePath(path) }), path, fileLimit)),
    archive: () => serialized(async () => verified(await invoke('archive'), 'workspace.zip', archiveLimit, true) as WorkspaceFile),
    close,
  };
}
