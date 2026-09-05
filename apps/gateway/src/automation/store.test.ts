import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatAutomation } from './types.js';
import {
  AutomationCompanyScopeError,
  InMemoryAutomationStore,
  JsonFileAutomationStore,
  PERSONAL_CHAT_COMPANY_ID,
} from './store.js';

function automation(over: Partial<ChatAutomation> = {}): ChatAutomation {
  return {
    id: 'a1',
    sessionIssueId: 'chat-issue-1',
    chatAgentId: 'agent-1',
    companyId: PERSONAL_CHAT_COMPANY_ID,
    prompt: 'morning digest',
    cadence: { kind: 'interval', intervalSec: 60 },
    timezone: 'UTC',
    enabled: true,
    nextRunAt: 1_000_000,
    lastFireKey: null,
    approvalState: 'approved',
    createdAt: 1_000_000,
    lastFiredAt: null,
    lastOutcomeOk: null,
    lastError: null,
    updatedAt: 1_000_000,
    ...over,
  };
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gw-automation-'));
  tmpDirs.push(dir);
  return join(dir, 'chat-automations.json');
}

describe.each([
  ['InMemoryAutomationStore', () => new InMemoryAutomationStore()],
  ['JsonFileAutomationStore', async () => new JsonFileAutomationStore(await tempFile())],
])('%s — contract', (_name, make) => {
  it('put / get / list / delete round-trip', async () => {
    const store = await make();
    expect(await store.list()).toEqual([]);
    await store.put(automation({ id: 'x' }));
    await store.put(automation({ id: 'y' }));
    expect((await store.list()).map((a) => a.id).sort()).toEqual(['x', 'y']);
    expect((await store.get('x'))?.id).toBe('x');
    await store.delete('x');
    expect(await store.get('x')).toBeNull();
    expect((await store.list()).map((a) => a.id)).toEqual(['y']);
  });

  it('put upserts (same id overwrites)', async () => {
    const store = await make();
    await store.put(automation({ id: 'x', prompt: 'first' }));
    await store.put(automation({ id: 'x', prompt: 'second' }));
    expect((await store.list())).toHaveLength(1);
    expect((await store.get('x'))?.prompt).toBe('second');
  });

  it('§4.5 isolation: refuses to store a non-Personal-Chat automation', async () => {
    const store = await make();
    await expect(store.put(automation({ companyId: 'real-company-uuid' }))).rejects.toBeInstanceOf(
      AutomationCompanyScopeError,
    );
    expect(await store.list()).toEqual([]);
  });
});

describe('JsonFileAutomationStore — persistence', () => {
  it('survives a restart: a new instance on the same file reads prior schedules', async () => {
    const path = await tempFile();
    await new JsonFileAutomationStore(path).put(automation({ id: 'persisted' }));
    const reopened = new JsonFileAutomationStore(path);
    expect((await reopened.get('persisted'))?.id).toBe('persisted');
  });

  it('a missing file reads as empty (first run)', async () => {
    const store = new JsonFileAutomationStore(await tempFile());
    expect(await store.list()).toEqual([]);
  });

  it('fails loud on a corrupt file rather than silently dropping every schedule', async () => {
    const path = await tempFile();
    await writeFile(path, '{ not valid json', 'utf8');
    await expect(new JsonFileAutomationStore(path).list()).rejects.toThrow();
  });

  it('writes atomically: the persisted file is valid JSON of the full set', async () => {
    const path = await tempFile();
    const store = new JsonFileAutomationStore(path);
    await store.put(automation({ id: 'a' }));
    await store.put(automation({ id: 'b' }));
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as ChatAutomation[];
    expect(onDisk.map((a) => a.id).sort()).toEqual(['a', 'b']);
  });

  it('fail-closed on load: a persisted non-Personal-Chat row is rejected, not admitted', async () => {
    const path = await tempFile();
    await writeFile(path, JSON.stringify([{ ...automation({ id: 'tampered' }), companyId: 'real-company' }]), 'utf8');
    await expect(new JsonFileAutomationStore(path).list()).rejects.toThrow();
  });
});

describe.each([
  ['InMemoryAutomationStore', () => new InMemoryAutomationStore()],
  ['JsonFileAutomationStore', async () => new JsonFileAutomationStore(await tempFile())],
])('%s — concurrency (lost-update fix)', (_name, make) => {
  it('serializes concurrent put/delete so no update is lost', async () => {
    const store = await make();
    // Fire many writes concurrently against the same store/file. Without the mutex the
    // read-modify-write would clobber; with it, every surviving put lands and the delete
    // takes effect.
    const puts = Array.from({ length: 20 }, (_v, i) => store.put(automation({ id: `a${i}` })));
    await Promise.all(puts);
    await store.delete('a5');
    const ids = (await store.list()).map((a) => a.id).sort();
    expect(ids).toContain('a0');
    expect(ids).toContain('a19');
    expect(ids).not.toContain('a5');
    expect(ids).toHaveLength(19);
  });

  it('transaction runs the read-modify-write atomically and returns a value', async () => {
    const store = await make();
    await store.put(automation({ id: 'x', nextRunAt: 1 }));
    const claimed = await store.transaction((map) => {
      const a = map.get('x');
      if (a) map.set('x', { ...a, nextRunAt: 999 });
      return a?.id ?? null;
    });
    expect(claimed).toBe('x');
    expect((await store.get('x'))!.nextRunAt).toBe(999);
  });
});
