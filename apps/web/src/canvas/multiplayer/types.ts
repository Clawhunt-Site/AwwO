// 多人同屏 / Multiplayer: the wire format of docs/awwo-canvas-live-collaboration.md ("Wire format" and "The API"), as
// the API sends and takes it. The change engine that applies these ops is changes.ts.

/** One edit of a canvas document, on one path (the contract's "Paths" and "Ops"). */
export type CanvasOp = { op: 'set'; path: string[]; value: unknown } | { op: 'del'; path: string[] } | { op: 'order'; path: string[]; ids: string[] };

/** Who made a change. */
export interface ChangeActor { kind: 'human' | 'agent' | 'awwo'; userId?: string; tokenId?: string; name: string; clientId: string }

/** One numbered step of a canvas: `version` is the canvas's version after it; `ops` are its effective ops. */
export interface CanvasChange { version: number; actor: ChangeActor; label: string; ops: CanvasOp[]; at: string }

/** A participant's state, as `POST …/live/presence` sends it. `cursor` is in world coordinates. */
export interface LiveState { selection: string[]; focus: string | null; cursor: { x: number; y: number } | null; status: string | null }

export interface LiveParticipant {
  /** A page's client id, 't_' + token id, or 'run_' + run id. */
  id: string;
  kind: 'human' | 'agent' | 'awwo';
  port: 'web' | 'mcp' | 'api' | 'awwo';
  name: string;
  /** '#rrggbb' */
  color: string;
  /** The person (for an agent: who made its token). */
  userId?: string;
  role?: 'reader' | 'member' | 'admin' | 'owner';
  /** kind awwo: the node's model. */
  model?: string;
  state: LiveState;
  /** ISO time it came. */
  since: string;
}

/** A participant's hold on a node, until `expiresAt`. */
export interface LiveClaim { nodeId: string; participantId: string; holderKind: 'human' | 'agent'; name: string; note: string; expiresAt: string }

/** A short line the participants of a canvas write to each other. `nodeId` is '' when it names no node. */
export interface LiveMessage {
  id: string;
  authorKind: 'human' | 'agent';
  /** 'u_' + user id for a person, 't_' + token id for an agent. */
  participantId: string;
  name: string;
  /** '#rrggbb': the author's colour from the participants' palette by `participantId`, so an author who has left still
   *  shows in it (canvas_live.go liveMessage). */
  color: string;
  nodeId: string;
  text: string;
  createdAt: string;
}

/** A canvas agent token as the API lists it: never its secret. */
export interface AgentTokenItem {
  id: string; name: string; prefix: string; scope: 'edit' | 'read'; createdAt: string; expiresAt: string;
  lastUsedAt: string | null; revokedAt: string | null; createdBy: { id: string; name: string };
}

/** What the server did with one op of a change: `gone` is an op whose record was not there (it acted on nothing),
 *  `claimed` an op on a node another participant holds, `node_running` an op the run fence refuses. */
export type OpResult = 'ok' | 'gone' | 'claimed' | 'node_running' | 'forbidden';

/** `PATCH …/canvases/{id}`: the ops a page or an agent sends, with the version it had. */
export interface CanvasChangeRequest { baseVersion: number; changeId: string; clientId: string; ops: CanvasOp[]; label?: string }

/** The answer to a change: `results[i]` for `ops[i]`; `changes` holds every change after `baseVersion` (others' and this
 *  one), or, when the log no longer reaches back that far, `reset` comes with the whole stored document instead. */
export interface CanvasChangeResponse { version: number; results: OpResult[]; changes?: CanvasChange[]; reset?: true; document?: unknown }
