// The canvas assistant's one conversation, where the host can also do tasks (the hosted app). Each message is
// handled in one of two ways, and the server decides which: arranging the canvas (the planner) or doing the
// task in a managed workspace. This file holds what the canvas and the host share; the host draws the tasks.
import type { ReactNode } from 'react';
import type { CanvasDocument } from './canvasDoc';
import type { PlanningMessage } from './canvasPlanning';

export type AssistantRoute = 'plan' | 'execute';

/** What the server's router reads (POST …/canvases/{id}/assistant/route); the bounds are the server's. */
export interface AssistantRouteRequest {
  message: string;
  routes: AssistantRoute[];
  canvas: { nodes: number; titles: string[]; results: boolean };
  recent: Array<{ role: 'user' | 'assistant'; route?: AssistantRoute; text: string }>;
}

export type RouteAssistant = (request: AssistantRouteRequest, signal: AbortSignal) => Promise<AssistantRoute>;

/** What a message being handled waits for before it joins the conversation. */
export type AssistantPendingPhase = 'routing' | 'starting' | 'stopping';
/** `operationId`: the submission identity a task being started is sent under. */
export interface AssistantPending { id: string; prompt: string; phase: AssistantPendingPhase; operationId?: string }

/** Thrown by `start` when the service did not say whether the task was created: the host offers to reconcile it,
 *  and the message must not be sent again meanwhile. */
export class TaskStartUnconfirmed extends Error {
  constructor(message: string) { super(message); this.name = 'TaskStartUnconfirmed'; }
}

/** What a task's card may do in the conversation: send a follow-up (「继续」, or the request again) as a new task. */
export interface AssistantTaskActions { send?: (text: string) => void }

/** The host's managed execution, drawn into the conversation. */
export interface AssistantExecutionHost {
  readOnly: boolean;
  /** Reads the service and this canvas's tasks: once a canvas that routes opens, so it knows whether a task can
   *  start, and for a viewer once the tasks are first shown. */
  activate: () => void;
  /** The conversation is on screen; a running task is read only while it is. */
  setVisible: (visible: boolean) => void;
  /** A task can start now (service ready, a model chosen, nothing unconfirmed in flight). */
  ready: boolean;
  /** Starts a task with this text under the given submission identity: resolves with its id; rejects with an error to
   *  show, or with TaskStartUnconfirmed where the outcome is unknown. */
  start: (prompt: string, operationId: string) => Promise<string>;
  /** Stops a task this user started, unless it has ended; resolves once the stop is asked for. */
  stop: (taskId: string) => Promise<void>;
  /** Whether the task has ended, as far as the host has read. */
  finished: (taskId: string) => boolean;
  /** Whether the task is known to be under way: read, and not ended. A task is read only while the conversation is on
   *  screen (setVisible), so this is current only then. */
  running?: (taskId: string) => boolean;
  renderTask: (taskId: string, actions?: AssistantTaskActions) => ReactNode;
  /** How a task ended, in a few plain English words for the router (undefined while it is not known). */
  outcome?: (taskId: string) => string | undefined;
  /** Earlier tasks of this canvas the conversation does not mention, at its top. */
  renderEarlier: (mentioned: ReadonlySet<string>, open: boolean) => ReactNode;
  /** Above the composer: the service's notices, saying where messages go while tasks cannot start when the canvas
   *  can take them (`planAvailable`). */
  renderNotices: (planAvailable: boolean) => ReactNode;
  /** Under the composer: the model the canvas assistant uses (its direct tasks, and the components a plan adds). */
  settings: ReactNode;
  /** The model the reader chose under the composer, once chosen there: the Agent components a plan adds start on it,
   *  as the direct tasks run on it. Absent while the reader keeps the default. */
  componentModel?: { runtime: string; model: string };
  /** The task the last reconcile in this page confirmed, with the submission it was. */
  confirmedTask?: { taskId: string; operationId: string };
  /** The submission whose outcome is unknown and waits to be reconciled (kept across reloads and tabs). */
  pendingOperation?: string;
  /** The last submission settled with no task: which one, and why. A reconcile refused in a way that proves the start
   *  never happened offers its request again; one given up (`givenUp`) does not, as a task it started may be listed. */
  startRefusal?: { reason: string; at: number; operationId: string; givenUp?: boolean };
}

const ROUTE_TITLES = 40;
const ROUTE_TITLE_CHARS = 120;
const ROUTE_TURNS = 6;
const ROUTE_TURN_CHARS = 600;

/** The router's input, within the server's bounds: the canvas in brief and the last turns of the conversation. A turn
 *  that is a task says how the task ended, when `outcome` knows, so a follow-up such as 「继续」 after one that stopped
 *  part-way can go on with it. */
export function assistantRouteRequest(message: string, routes: AssistantRoute[], doc: CanvasDocument, messages: PlanningMessage[],
  outcome?: (taskId: string) => string | undefined): AssistantRouteRequest {
  const clip = (text: string, max: number) => [...text].slice(0, max).join('');
  return {
    message,
    routes,
    canvas: {
      nodes: doc.nodes.length,
      titles: doc.nodes.slice(0, ROUTE_TITLES).map(node => clip(node.title.trim(), ROUTE_TITLE_CHARS)).filter(Boolean),
      results: doc.nodes.some(node => Boolean(node.lastOutput)),
    },
    recent: messages.slice(-ROUTE_TURNS).map(item => ({
      role: item.role,
      ...(item.route ? { route: item.route } : {}),
      text: clip(item.taskId ? taskTurn(outcome?.(item.taskId)) : item.content, ROUTE_TURN_CHARS),
    })),
  };
}

/** A task's turn as the router reads it. */
function taskTurn(outcome: string | undefined): string {
  return outcome ? `(a direct task in the workspace: ${outcome})` : '(a task was started in the workspace)';
}
