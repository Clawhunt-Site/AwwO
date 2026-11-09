// 多人同屏: what the canvas surface and its host (the hosted app's page) give each other (docs/awwo-canvas-live-collaboration.md).
// The host holds the live connection and the server's document; the surface holds the working document, its undo
// steps and what the person sees. Neither reaches into the other.

import type { ReactNode } from 'react';
import type { CanvasDocument, CanvasNode } from '../canvasDoc';

/** A rebase: `working` for the document the surface shows (others' changes, and the server's answer to this page's own),
 *  `history` for each undo and redo step (others' changes only, so an undo still takes the page's own edit back). */
export interface CanvasMultiplayerRebase {
  working(doc: CanvasDocument): CanvasDocument;
  history(doc: CanvasDocument): CanvasDocument;
  /** The paths others set or deleted in this rebase: an undo or redo step taken before it does not put its older value
   *  back at any of them (multiplayer/history.ts). None: an undo goes to its step whole. */
  othersPaths?: readonly (readonly string[])[];
}

/** What the surface gives the host once it is ready for others' changes. */
export interface CanvasMultiplayerSurface {
  /** Applies a rebase to the working document and to every undo and redo step, as no undo step of its own. */
  rebase(rebase: CanvasMultiplayerRebase): void;
  /** Whether a rebase can be applied now: not while node setup rewrites the document or the page is out of date. */
  ready(): boolean;
  /** Shows a node (the 同屏 panel names one). */
  focus(nodeId: string): void;
  /** The document the canvas holds now (its own, whatever this device's shared cache says). */
  document(): CanvasDocument;
  /** Whether the results of a run another page started may land now (saas/runAdoption.ts): not while a lane of this page
   *  holds that run or one of `nodes`, a run here holds the whole canvas, one of them talks, someone else's run holds one
   *  of them, node setup rewrites the document, or the page is out of date. */
  canLand?(operationId: string, nodes: readonly string[]): boolean;
  /** Says (`say`) that a run's results the server took are on the canvas (the host landed them), and reads again the
   *  conversations of `nodes` this page has loaded, which the run's turns joined. */
  landed?(nodes: readonly string[], say?: boolean): void;
}

/** This page's part of what everyone on the canvas sees: its selection, the node it has open and its pointer. */
export interface CanvasPresenceUpdate {
  selection?: string[];
  focus?: string | null;
  cursor?: { x: number; y: number } | null;
}

export interface CanvasMultiplayerHost {
  /** The surface registers itself (and null when it goes). */
  connect(surface: CanvasMultiplayerSurface | null): void;
  presence(update: CanvasPresenceUpdate): void;
  /** Drawn inside the board over the cards, in world coordinates: others' rings, claims and pointers. `nodes` are the
   *  cards the board draws, at their drawn boxes (never a member inside a converged icon); a component the icon view
   *  (图标视图) draws as its icon comes at its plate, with `round` set, and its marks ring the plate. The scale is the
   *  board's zoom, so names and pointers keep their size on screen. */
  boardLayer?: (nodes: ReadonlyArray<CanvasNode & { round?: boolean }>, scale: number) => ReactNode;
  /** The nodes others' runs hold now: the page changes them no more than it changes its own running nodes. */
  busyNodes?: () => ReadonlySet<string>;
  /** Takes over the landing of a canvas run that had ended before this page took it up from its journal (a reopening):
   *  the host lands it by its versioned save (saas/useRunLanding.ts), which leaves what others published since it ended. */
  landEnded?: (graphRunId: string) => void;
}
