// Durable idempotency journal for real Agent conversation mutations.
//
// Each operation owns one directory and each transition is an immutable file. The
// initial request is claimed with `wx`, so concurrent requests sharing the same
// SUPERCLAW_HOME cannot both acquire the right to mutate upstream. Later files are
// also create-only: a crash can leave an incomplete/uncertain operation, but can
// never rewind it or turn it into permission to execute the Agent a second time.

import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ConversationOperationPhase =
  | 'claimed'
  | 'mutation_started'
  | 'container_known'
  | 'comment_started'
  | 'issue_known'
  | 'run_known'
  | 'rejected'
  | 'uncertain';

export interface ConversationOperationRequest {
  version: 1;
  operationId: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  requestDigest: string;
  createdAt: string;
  /** Absent in old journals, where creating a todo issue itself dispatched the first turn. */
  deliveryMode?: 'comment';
}

interface LabelTransition { labelId: string; recordedAt: string }
interface MutationTransition { startedAt: string }
interface IssueTransition { issueId: string; commentId: string | null; recordedAt: string }
interface RunTransition { runId: string; recordedAt: string }
interface DetailTransition { detail: string; recordedAt: string }

export interface ConversationOperationSnapshot {
  request: ConversationOperationRequest;
  phase: ConversationOperationPhase;
  labelId: string | null;
  mutationStarted: boolean;
  /** A backlog container is not proof that its first message was delivered. */
  containerId: string | null;
  commentStarted: boolean;
  /** The upstream accepted this exact mutation. For continuation operations the
   * request's issueId exists before delivery, so issueId alone is not proof. */
  deliveryConfirmed: boolean;
  issueId: string | null;
  /** Exact comment wake identity for continuation operations. */
  commentId: string | null;
  runId: string | null;
  detail: string | null;
}

export class ConversationOperationConflictError extends Error {
  constructor() {
    super('operationId is already bound to a different conversation request');
    this.name = 'ConversationOperationConflictError';
  }
}

export class ConversationOperationCorruptError extends Error {
  constructor(operationId: string) {
    super(`conversation operation ${operationId} is corrupt or incomplete`);
    this.name = 'ConversationOperationCorruptError';
  }
}

export function isConversationOperationId(value: string): boolean {
  return UUID.test(value);
}

export function conversationRequestDigest(input: {
  companyId: string;
  agentId: string;
  issueId?: string | null;
  message: string;
  title?: string | null;
}): string {
  const canonical = JSON.stringify({
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId ?? null,
    message: input.message,
    title: input.title ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sameRequest(left: ConversationOperationRequest, right: ConversationOperationRequest): boolean {
  return left.version === right.version
    && left.operationId === right.operationId
    && left.companyId === right.companyId
    && left.agentId === right.agentId
    && left.issueId === right.issueId
    && left.requestDigest === right.requestDigest;
}

export class ConversationOperationStore {
  constructor(private readonly rootDir: string) {}

  private dir(operationId: string): string {
    if (!isConversationOperationId(operationId)) throw new Error('operationId must be a UUID');
    return join(this.rootDir, operationId.toLowerCase());
  }

  private async readJson(path: string): Promise<unknown | null> {
    try {
      const source = await readFile(path, 'utf8');
      try { return JSON.parse(source) as unknown; }
      catch { throw new ConversationOperationCorruptError(path); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async readTransition<T>(operationId: string, name: string, validate: (raw: Record<string, unknown>) => T | null): Promise<T | null> {
    const raw = await this.readJson(join(this.dir(operationId), name));
    if (raw === null) return null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConversationOperationCorruptError(operationId);
    const parsed = validate(raw as Record<string, unknown>);
    if (!parsed) throw new ConversationOperationCorruptError(operationId);
    return parsed;
  }

  private async writeOnce(operationId: string, name: string, value: object): Promise<boolean> {
    return this.writeOnceAt(this.dir(operationId), name, value);
  }

  private async writeOnceAt(dir: string, name: string, value: object): Promise<boolean> {
    await mkdir(dir, { recursive: true });
    const target = join(dir, name);
    const temporary = join(dir, `.${name}.${randomUUID()}.tmp`);
    try {
      // Publish only a fully-written file. A direct `writeFile(target,{flag:'wx'})`
      // exposes an empty/partial target to the losing process between open and flush.
      // A same-directory hard link is atomic and no-replace on Windows and POSIX:
      // exactly one complete temporary inode becomes the immutable transition.
      await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
      await link(temporary, target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      try { await unlink(temporary); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  async claim(input: Omit<ConversationOperationRequest, 'version' | 'createdAt'>): Promise<{ created: boolean; snapshot: ConversationOperationSnapshot }> {
    const operationId = input.operationId.toLowerCase();
    if (!isConversationOperationId(operationId)) throw new Error('operationId must be a UUID');
    const request: ConversationOperationRequest = {
      version: 1,
      ...input,
      operationId,
      createdAt: new Date().toISOString(),
    };
    const created = await this.writeOnce(operationId, 'request.json', request);
    const snapshot = await this.read(operationId);
    if (!sameRequest(snapshot.request, request)) throw new ConversationOperationConflictError();
    return { created, snapshot };
  }

  async read(operationId: string): Promise<ConversationOperationSnapshot> {
    const normalized = operationId.toLowerCase();
    const raw = await this.readJson(join(this.dir(normalized), 'request.json'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConversationOperationCorruptError(normalized);
    const value = raw as Record<string, unknown>;
    const request: ConversationOperationRequest = {
      version: value.version === 1 ? 1 : 0 as never,
      operationId: text(value.operationId) ?? '',
      companyId: text(value.companyId) ?? '',
      agentId: text(value.agentId) ?? '',
      issueId: value.issueId === null ? null : text(value.issueId),
      requestDigest: text(value.requestDigest) ?? '',
      createdAt: text(value.createdAt) ?? '',
      ...(value.deliveryMode === 'comment' ? { deliveryMode: 'comment' as const } : {}),
    };
    if (request.version !== 1 || request.operationId !== normalized || !request.companyId || !request.agentId
      || (value.issueId !== null && !request.issueId) || !/^[0-9a-f]{64}$/.test(request.requestDigest)
      || !Number.isFinite(Date.parse(request.createdAt))) {
      throw new ConversationOperationCorruptError(normalized);
    }
    if (value.deliveryMode !== undefined && value.deliveryMode !== 'comment') throw new ConversationOperationCorruptError(normalized);
    const label = await this.readTransition<LabelTransition>(normalized, 'label.json', (v) => {
      const labelId = text(v.labelId); const recordedAt = text(v.recordedAt);
      return labelId && recordedAt ? { labelId, recordedAt } : null;
    });
    const mutation = await this.readTransition<MutationTransition>(normalized, 'mutation-started.json', (v) => {
      const startedAt = text(v.startedAt); return startedAt ? { startedAt } : null;
    });
    const container = await this.readTransition<{ issueId: string; recordedAt: string }>(normalized, 'container.json', (v) => {
      const issueId = text(v.issueId); const recordedAt = text(v.recordedAt);
      return issueId && recordedAt ? { issueId, recordedAt } : null;
    });
    const commentMutation = await this.readTransition<MutationTransition>(normalized, 'comment-started.json', (v) => {
      const startedAt = text(v.startedAt); return startedAt ? { startedAt } : null;
    });
    const issue = await this.readTransition<IssueTransition>(normalized, 'issue.json', (v) => {
      const issueId = text(v.issueId); const recordedAt = text(v.recordedAt);
      const commentId = v.commentId === null || v.commentId === undefined ? null : text(v.commentId);
      return issueId && recordedAt && (v.commentId === null || v.commentId === undefined || commentId)
        ? { issueId, commentId, recordedAt } : null;
    });
    const run = await this.readTransition<RunTransition>(normalized, 'run.json', (v) => {
      const runId = text(v.runId); const recordedAt = text(v.recordedAt);
      return runId && recordedAt ? { runId, recordedAt } : null;
    });
    const rejected = await this.readTransition<DetailTransition>(normalized, 'rejected.json', (v) => {
      const detail = text(v.detail); const recordedAt = text(v.recordedAt);
      return detail && recordedAt ? { detail, recordedAt } : null;
    });
    const uncertain = await this.readTransition<DetailTransition>(normalized, 'uncertain.json', (v) => {
      const detail = text(v.detail); const recordedAt = text(v.recordedAt);
      return detail && recordedAt ? { detail, recordedAt } : null;
    });
    if (request.deliveryMode === 'comment' && issue && (!issue.commentId
        || (container && container.issueId !== issue.issueId)
        || (request.issueId && request.issueId !== issue.issueId))) throw new ConversationOperationCorruptError(normalized);
    const phase: ConversationOperationPhase = run ? 'run_known' : issue ? 'issue_known'
      : rejected ? 'rejected' : uncertain ? 'uncertain' : commentMutation ? 'comment_started'
      : container ? 'container_known' : mutation ? 'mutation_started' : 'claimed';
    return {
      request,
      phase,
      labelId: label?.labelId ?? null,
      mutationStarted: mutation !== null || commentMutation !== null,
      containerId: container?.issueId ?? null,
      commentStarted: commentMutation !== null,
      deliveryConfirmed: issue !== null,
      issueId: issue?.issueId ?? container?.issueId ?? request.issueId,
      commentId: issue?.commentId ?? null,
      runId: run?.runId ?? null,
      detail: rejected?.detail ?? uncertain?.detail ?? null,
    };
  }

  async recordLabel(operationId: string, labelId: string): Promise<void> {
    const wrote = await this.writeOnce(operationId, 'label.json', { labelId, recordedAt: new Date().toISOString() });
    if (!wrote && (await this.read(operationId)).labelId !== labelId) throw new ConversationOperationCorruptError(operationId);
  }

  /** Exactly one concurrent caller may cross the upstream-mutation boundary. */
  async beginMutation(operationId: string): Promise<boolean> {
    return this.writeOnce(operationId, 'mutation-started.json', { startedAt: new Date().toISOString() });
  }

  async recordContainer(operationId: string, issueId: string): Promise<void> {
    const wrote = await this.writeOnce(operationId, 'container.json', { issueId, recordedAt: new Date().toISOString() });
    if (!wrote && (await this.read(operationId)).containerId !== issueId) throw new ConversationOperationCorruptError(operationId);
  }

  /** Separate no-replay boundary: creating the container never grants two callers a send. */
  async beginComment(operationId: string): Promise<boolean> {
    const current = await this.read(operationId);
    if (!current.issueId || current.request.deliveryMode !== 'comment') throw new ConversationOperationCorruptError(operationId);
    return this.writeOnce(operationId, 'comment-started.json', { startedAt: new Date().toISOString() });
  }

  async recordIssue(operationId: string, issueId: string, commentId: string | null = null): Promise<void> {
    const wrote = await this.writeOnce(operationId, 'issue.json', { issueId, commentId, recordedAt: new Date().toISOString() });
    if (!wrote) {
      const current = await this.read(operationId);
      if (current.issueId !== issueId || current.commentId !== commentId) throw new ConversationOperationCorruptError(operationId);
    }
  }

  async recordRun(operationId: string, runId: string): Promise<void> {
    const wrote = await this.writeOnce(operationId, 'run.json', { runId, recordedAt: new Date().toISOString() });
    if (!wrote && (await this.read(operationId)).runId !== runId) throw new ConversationOperationCorruptError(operationId);
  }

  async recordRejected(operationId: string, detail: string): Promise<void> {
    await this.writeOnce(operationId, 'rejected.json', { detail, recordedAt: new Date().toISOString() });
  }

  async recordUncertain(operationId: string, detail: string): Promise<void> {
    await this.writeOnce(operationId, 'uncertain.json', { detail, recordedAt: new Date().toISOString() });
  }

  /** The upstream hold API has no idempotency key. A lost response permits only readback;
   * never create another hold for the same terminal run after a process restart. */
  async beginSettlement(input: { companyId: string; agentId: string; issueId: string; runId: string }): Promise<boolean> {
    if (!isConversationOperationId(input.runId)) throw new Error('runId must be a UUID');
    const directory = join(this.rootDir, 'settlements', input.runId.toLowerCase());
    const created = await this.writeOnceAt(directory, 'request.json', input);
    const existing = await this.readJson(join(directory, 'request.json'));
    if (!existing || typeof existing !== 'object' || Object.entries(input).some(([key, value]) => (existing as Record<string, unknown>)[key] !== value)) {
      throw new ConversationOperationConflictError();
    }
    return created;
  }
}
