// Persistence for chat automations. The ticker and the automation API share one store;
// it survives gateway restarts and enforces the §4.5 isolation invariant at the storage
// boundary: ONLY Personal Chat automations can be stored.
//
// Concurrency: every mutation goes through `transaction`, which serializes the whole
// read-modify-write critical section behind a single in-process lock. This closes the
// lost-update race (two async put/delete reading the same snapshot and clobbering each
// other) AND lets the ticker select-due + claim atomically, so a concurrent DELETE can
// never be "resurrected" by a ticker advancing a stale snapshot.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { ChatAutomation } from './types.js';

// Mirrors the upstream LOCAL_CHAT_COMPANY_ID (chat-compat.ts).
export const PERSONAL_CHAT_COMPANY_ID = '00000000-c4a7-4000-a000-000000000001';

export class AutomationCompanyScopeError extends Error {
  constructor(companyId: string) {
    super(`chat automation must be scoped to the Personal Chat company, got ${companyId}`);
    this.name = 'AutomationCompanyScopeError';
  }
}

export interface AutomationStore {
  list(): Promise<ChatAutomation[]>;
  get(id: string): Promise<ChatAutomation | null>;
  put(automation: ChatAutomation): Promise<void>;
  delete(id: string): Promise<void>;
  // Atomic read-modify-write. `fn` mutates the live map (keyed by id) and may return a
  // value (e.g. the ticker returns the slots it claimed). The whole load→fn→save runs
  // under the store's write lock — no other mutation interleaves.
  transaction<T>(fn: (map: Map<string, ChatAutomation>) => T): Promise<T>;
}

function assertPersonalChat(a: ChatAutomation): void {
  if (a.companyId !== PERSONAL_CHAT_COMPANY_ID) throw new AutomationCompanyScopeError(a.companyId);
}

// Validate every persisted entry on load: a row scoped to anything but Personal Chat is a
// corruption / tampering signal and is rejected loudly (fail-closed) rather than admitted.
function assertLoaded(map: Map<string, ChatAutomation>): Map<string, ChatAutomation> {
  for (const a of map.values()) assertPersonalChat(a);
  return map;
}

// Serializes async critical sections behind a single promise chain (an in-process mutex).
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Keep the chain alive even if `fn` rejects (swallow only for the chain, not the caller).
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class InMemoryAutomationStore implements AutomationStore {
  private readonly map = new Map<string, ChatAutomation>();
  private readonly mutex = new Mutex();

  constructor(seed: readonly ChatAutomation[] = []) {
    for (const a of seed) {
      assertPersonalChat(a);
      this.map.set(a.id, { ...a });
    }
  }

  async list(): Promise<ChatAutomation[]> {
    return [...this.map.values()].map((a) => ({ ...a }));
  }

  async get(id: string): Promise<ChatAutomation | null> {
    const a = this.map.get(id);
    return a ? { ...a } : null;
  }

  async put(automation: ChatAutomation): Promise<void> {
    assertPersonalChat(automation);
    return this.transaction((map) => {
      map.set(automation.id, { ...automation });
    });
  }

  delete(id: string): Promise<void> {
    return this.transaction((map) => {
      map.delete(id);
    });
  }

  transaction<T>(fn: (map: Map<string, ChatAutomation>) => T): Promise<T> {
    return this.mutex.run(async () => {
      const result = fn(this.map);
      assertLoaded(this.map);
      return result;
    });
  }
}

// JSON-file store — atomic file writes (temp + rename) and a single-writer mutex so the
// read-modify-write is serialized within the process.
export class JsonFileAutomationStore implements AutomationStore {
  private readonly mutex = new Mutex();

  constructor(private readonly filePath: string) {}

  private async readAll(): Promise<Map<string, ChatAutomation>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw err;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`corrupt automation store at ${this.filePath}`);
    return assertLoaded(new Map((parsed as ChatAutomation[]).map((a) => [a.id, a])));
  }

  private async writeAll(map: Map<string, ChatAutomation>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = join(dirname(this.filePath), `.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify([...map.values()], null, 2), 'utf8');
    await rename(tmp, this.filePath); // atomic on POSIX
  }

  async list(): Promise<ChatAutomation[]> {
    return [...(await this.readAll()).values()];
  }

  async get(id: string): Promise<ChatAutomation | null> {
    return (await this.readAll()).get(id) ?? null;
  }

  async put(automation: ChatAutomation): Promise<void> {
    assertPersonalChat(automation);
    return this.transaction((map) => {
      map.set(automation.id, { ...automation });
    });
  }

  delete(id: string): Promise<void> {
    return this.transaction((map) => {
      map.delete(id);
    });
  }

  transaction<T>(fn: (map: Map<string, ChatAutomation>) => T): Promise<T> {
    return this.mutex.run(async () => {
      const map = await this.readAll();
      const result = fn(map);
      assertLoaded(map);
      await this.writeAll(map);
      return result;
    });
  }
}
