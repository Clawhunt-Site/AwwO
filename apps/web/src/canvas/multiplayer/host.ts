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
  /** Drawn inside the board over the cards, in world coordinates: others' rings, claims and pointers. The scale is
   *  the board's zoom, so names and pointers keep their size on screen. */
  boardLayer?: (nodes: ReadonlyArray<CanvasNode>, scale: number) => ReactNode;
  /** The nodes others' runs hold now: the page changes them no more than it changes its own running nodes. */
  busyNodes?: () => ReadonlySet<string>;
}
